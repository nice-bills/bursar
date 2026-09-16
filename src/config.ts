/**
 * Bursar treasury configuration.
 *
 * This is the agent's financial constitution: who gets paid, how much gas each
 * chain needs to keep working, where surplus goes, and the hard limits that no
 * amount of agent reasoning is allowed to talk its way past.
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";

/** Chains confirmed enabled on the org, from `npm run chains`. */
export const CHAIN = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
  tempo: 4217,
  sepolia: 11155111,
  baseSepolia: 84532,
  tempoTestnet: 42431,
} as const;

/** Only these two support MEV-protected submission. Payouts prefer them. */
export const PRIVATE_MEMPOOL_CHAINS: number[] = [CHAIN.ethereum, CHAIN.sepolia];

const address = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte address");

/** Base units as a decimal string — never a JS number, which loses precision. */
const baseUnits = z.string().regex(/^\d+$/, "must be an integer string in base units");

const contributorSchema = z.object({
  name: z.string().min(1),
  address,
  /** Basis points of revenue. All contributors must sum to exactly 10000. */
  shareBps: z.number().int().min(1).max(10_000),
});

const floatSchema = z.object({
  chainId: z.number().int().positive(),
  /** The wallet the agent spends gas from — what we keep above the floor. */
  address,
  /** Below this native balance, the agent risks stalling mid-task. */
  minBalance: baseUnits,
  /** Top back up to this level when the floor is breached. */
  targetBalance: baseUnits,
});

const yieldSchema = z.object({
  enabled: z.boolean().default(false),
  protocol: z.literal("aave-v3").default("aave-v3"),
  chainId: z.number().int().positive(),
  /** ERC-20 to supply, e.g. USDC on the yield chain. */
  asset: address,
  /**
   * The lending pool. Must also be on policy.allowlist — supplying is value
   * leaving the treasury, and the allowlist is what stops it going elsewhere.
   */
  poolAddress: address,
  /**
   * Keep this much liquid in the treasury before depositing anything. Yield is
   * the last claim on the money, never the first.
   */
  buffer: baseUnits,
  /**
   * Only supply when Aave's own supply rate clears this, in basis points.
   *
   * Read from the protocol immediately before depositing, not configured as a
   * belief about what Aave pays. Supplying into a collapsed rate spends real
   * gas to earn nothing, and the rate is knowable beforehand — so we look, and
   * decline if it does not clear.
   *
   * Defaults to 0, which supplies at any rate and preserves the behaviour of
   * configs written before this existed.
   */
  minApyBps: z.number().int().nonnegative().default(0),
});

/**
 * Limits for one non-native asset.
 *
 * Caps are meaningless without the asset they are denominated in: 1000 USDC is
 * 1e9 base units, which reads as dust against a wei ceiling. Every token that
 * may move needs its own entry, and anything unlisted is refused.
 */
const assetPolicySchema = z.object({
  /** Human label for messages, e.g. "USDC". */
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
  maxPerTransfer: baseUnits,
  maxPerDay: baseUnits,
  /**
   * Chainlink aggregator for this asset, read through KeeperHub. Required for
   * any asset that may move while a cross-asset ceiling is set — an asset that
   * cannot be valued cannot be counted, and a ceiling that silently skips
   * assets is not a ceiling.
   */
  priceFeed: address.optional(),
});

/**
 * What to consolidate into the treasury, and when.
 *
 * Earnings arrive wherever the agent was paid — x402 settles USDC on Base, MPP
 * settles on Tempo. Sweeping moves them somewhere the treasury actually
 * governs, and `minAmount` keeps it from spending more in gas than it collects.
 */
const sweepAssetSchema = z.object({
  /** null for the chain's native asset. */
  token: address.nullable().default(null),
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
  /**
   * Do not sweep below this. For the native asset it doubles as the reserve
   * left behind, since sweeping the gas away would strand the agent.
   */
  minAmount: baseUnits,
});

const sweepSchema = z.object({
  chainId: z.number().int().positive(),
  /** Defaults to the treasury address. */
  destination: address.optional(),
  assets: z.array(sweepAssetSchema).min(1),
});

const policySchema = z.object({
  /** Hard ceiling on any single movement, in the asset's base units. */
  maxPerTransfer: baseUnits,
  /** Rolling 24h aggregate ceiling across every leg. */
  maxPerDay: baseUnits,
  /**
   * Value may only ever leave to these addresses. Contributor addresses are
   * merged in automatically — this is for extras like the yield pool.
   */
  allowlist: z.array(address).default([]),
  /** Above this, Bursar refuses to act autonomously and asks for a human. */
  requireApprovalAbove: baseUnits.optional(),
  /**
   * The same escalation, in whole US cents, so it binds every asset.
   *
   * `requireApprovalAbove` is denominated in the native asset and can only
   * govern native movements — 5000 base units of USDC cannot be compared
   * against a wei threshold without a price. That leaves token spending
   * unescalated at any size, which matters most for exactly the case it was
   * written for: an agent paying invoices, which it does in stablecoins.
   *
   * Needs the same price feeds the cross-asset ceiling uses.
   */
  requireApprovalAboveUsd: z
    .string()
    .regex(/^\d+$/, "whole US cents, as digits")
    .optional(),
  /**
   * Per-token limits, keyed by contract address. A token with no entry cannot
   * move at all — the native caps do not apply to it and guessing is worse
   * than refusing.
   */
  assets: z.record(address, assetPolicySchema).default({}),

  /**
   * A ceiling on total value leaving in a rolling 24h, in whole US cents,
   * across every asset at once. Per-asset caps bound each token; this bounds
   * the treasury.
   */
  maxPerDayUsd: z
    .string()
    .regex(/^\d+$/, "must be whole US cents as an integer string")
    .optional(),

  /** Chainlink aggregator for the native asset, needed when the ceiling is set. */
  nativePriceFeed: address.optional(),

  /** How stale a published price may be before a movement is refused. */
  maxPriceAgeSeconds: z.number().int().positive().default(3600),
});

export const configSchema = z
  .object({
    /** Treasury wallet. Defaults to the org's Turnkey signer when omitted. */
    treasury: z.object({
      chainId: z.number().int().positive(),
      address: address.optional(),
      /**
       * Send payouts on a different chain from the treasury's own. Only set
       * this if that chain is funded — nothing here checks, and a payout on an
       * unfunded chain simply fails.
       */
      payoutChainId: z.number().int().positive().optional(),
    }),
    contributors: z.array(contributorSchema).min(1),
    float: z.array(floatSchema).default([]),
    sweep: sweepSchema.optional(),
    yield: yieldSchema.optional(),
    policy: policySchema,
  })
  .superRefine((cfg, ctx) => {
    const total = cfg.contributors.reduce((sum, c) => sum + c.shareBps, 0);
    if (total !== 10_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributors"],
        message: `shareBps must sum to exactly 10000, got ${total}`,
      });
    }

    const seen = new Set<string>();
    for (const c of cfg.contributors) {
      const key = c.address.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributors"],
          message: `duplicate contributor address ${c.address}`,
        });
      }
      seen.add(key);
    }

    for (const f of cfg.float) {
      if (BigInt(f.targetBalance) <= BigInt(f.minBalance)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["float"],
          message: `chain ${f.chainId}: targetBalance must exceed minBalance, or top-ups do nothing`,
        });
      }
    }

    if (BigInt(cfg.policy.maxPerTransfer) > BigInt(cfg.policy.maxPerDay)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["policy"],
        message: "maxPerTransfer exceeds maxPerDay, so the daily cap can never bind",
      });
    }

    if (cfg.policy.maxPerDayUsd !== undefined) {
      if (!cfg.policy.nativePriceFeed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["policy", "nativePriceFeed"],
          message:
            "maxPerDayUsd needs nativePriceFeed, or native movements cannot be valued and the " +
            "ceiling would only bind some of the treasury",
        });
      }
      for (const [token, asset] of Object.entries(cfg.policy.assets)) {
        if (!asset.priceFeed) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["policy", "assets", token],
            message: `${asset.symbol}: needs a priceFeed while maxPerDayUsd is set`,
          });
        }
      }
    }

    for (const [token, asset] of Object.entries(cfg.policy.assets)) {
      if (BigInt(asset.maxPerTransfer) > BigInt(asset.maxPerDay)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["policy", "assets", token],
          message: `${asset.symbol}: maxPerTransfer exceeds maxPerDay, so the daily cap can never bind`,
        });
      }
    }
  });

export type BursarConfig = z.infer<typeof configSchema>;
export type Contributor = z.infer<typeof contributorSchema>;
export type FloatTarget = z.infer<typeof floatSchema>;
export type SweepConfig = z.infer<typeof sweepSchema>;
export type SweepAsset = z.infer<typeof sweepAssetSchema>;
export type YieldConfig = z.infer<typeof yieldSchema>;
export type Policy = z.infer<typeof policySchema>;
export type AssetPolicy = z.infer<typeof assetPolicySchema>;

/** Case-insensitive lookup of a token's limits. */
export function assetPolicyFor(policy: Policy, token: string): AssetPolicy | undefined {
  const wanted = token.toLowerCase();
  for (const [addr, value] of Object.entries(policy.assets)) {
    if (addr.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export async function loadConfig(path = "bursar.config.json"): Promise<BursarConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `No treasury config at ${path}. Copy bursar.config.example.json and edit it.`,
    );
  }

  const parsed = configSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid treasury config at ${path}:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Split an amount by basis points without losing a wei.
 *
 * Integer division leaves a remainder; dropping it silently means the treasury
 * slowly accumulates dust it can never account for. We hand the remainder to
 * the largest shareholder, deterministically.
 */
export function splitByShares(
  amount: bigint,
  contributors: Contributor[],
): Array<{ contributor: Contributor; amount: bigint }> {
  const allocations = contributors.map((contributor) => ({
    contributor,
    amount: (amount * BigInt(contributor.shareBps)) / 10_000n,
  }));

  const distributed = allocations.reduce((sum, a) => sum + a.amount, 0n);
  const remainder = amount - distributed;

  if (remainder > 0n && allocations.length > 0) {
    let largest = 0;
    for (let i = 1; i < allocations.length; i++) {
      const current = allocations[i];
      const best = allocations[largest];
      if (current && best && current.contributor.shareBps > best.contributor.shareBps) {
        largest = i;
      }
    }
    const target = allocations[largest];
    if (target) target.amount += remainder;
  }

  return allocations;
}
