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
   * Keep this much liquid in the treasury before depositing anything. Yield is
   * the last claim on the money, never the first.
   */
  buffer: baseUnits,
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
});

export const configSchema = z
  .object({
    /** Treasury wallet. Defaults to the org's Turnkey signer when omitted. */
    treasury: z.object({
      chainId: z.number().int().positive(),
      address: address.optional(),
    }),
    contributors: z.array(contributorSchema).min(1),
    float: z.array(floatSchema).default([]),
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
  });

export type BursarConfig = z.infer<typeof configSchema>;
export type Contributor = z.infer<typeof contributorSchema>;
export type FloatTarget = z.infer<typeof floatSchema>;
export type YieldConfig = z.infer<typeof yieldSchema>;
export type Policy = z.infer<typeof policySchema>;

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
