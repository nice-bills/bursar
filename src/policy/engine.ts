/**
 * Policy engine.
 *
 * An agent's reasoning is not a safety boundary — it is the thing most likely
 * to be wrong, prompt-injected, or looping. So every movement passes through
 * here, and this layer answers only from configuration and ledger history.
 * It never asks the model anything.
 *
 * Deny is the default. A movement is allowed only by passing every check.
 */

import { assetPolicyFor, type BursarConfig } from "../config.js";
import { NATIVE_DECIMALS } from "../units.js";
import type { Leg, Ledger } from "../ledger/store.js";
import { formatUsd, ValuationError, type Valuation } from "../treasury/valuation.js";
import type { SpendingLimits } from "../keeperhub/mcp.js";

/**
 * The platform's own budget, if it can be read.
 *
 * Returning null means "unknown", which is treated as no extra constraint —
 * a treasury that cannot reach the MCP server should still be able to pay
 * people, and the transfer will simply fail loudly if the cap is exceeded.
 */
export type PlatformLimitsReader = () => Promise<SpendingLimits | null>;

/** Platform limits change slowly; re-reading them per movement is wasteful. */
const LIMITS_TTL_MS = 60_000;

export type Decision =
  | { verdict: "allow" }
  | { verdict: "needs_approval"; reason: string }
  | { verdict: "deny"; reason: string };

export interface Movement {
  /** Set by the policy engine once valued, so the caller can record it. */
  valueUsdCents?: string;
  leg: Leg;
  chainId: number;
  to: string;
  /** Base units, as an integer string. Converted to decimal at the API edge. */
  amount: string;
  token: string | null;
  /** Decimals of the asset being moved — 18 for native, 6 for USDC. */
  decimals: number;
  memo: string;
}

export class PolicyEngine {
  private cachedLimits?: { at: number; limits: SpendingLimits | null };

  constructor(
    private readonly config: BursarConfig,
    private readonly ledger: Ledger,
    /**
     * Reads KeeperHub's enforced daily cap. Optional, because the policy engine
     * must work offline and in tests.
     */
    private readonly platformLimits?: PlatformLimitsReader,
    /** Values movements against a price feed. Required only when a USD ceiling is set. */
    private readonly valuation?: Valuation,
  ) {}

  /**
   * KeeperHub's remaining daily budget, cached briefly.
   *
   * Never throws: an unreachable MCP server must not stop a payout that local
   * policy already approved.
   */
  private async remainingPlatformBudget(): Promise<SpendingLimits | null> {
    if (!this.platformLimits) return null;
    const now = Date.now();
    if (this.cachedLimits && now - this.cachedLimits.at < LIMITS_TTL_MS) {
      return this.cachedLimits.limits;
    }
    try {
      const limits = await this.platformLimits();
      this.cachedLimits = { at: now, limits };
      return limits;
    } catch {
      // Deliberately open, as documented above — but not cached. Caching the
      // failure would extend one transient error into a TTL-long window where
      // the platform cap is not checked at all, and the next movement deserves
      // a fresh attempt rather than an inherited one.
      return null;
    }
  }

  /**
   * Addresses value may leave to: every contributor, plus explicit extras such
   * as the yield pool and the treasury itself (sweeps move funds inward).
   */
  private allowedRecipients(): Set<string> {
    const allowed = new Set<string>();
    for (const c of this.config.contributors) allowed.add(c.address.toLowerCase());
    for (const a of this.config.policy.allowlist) allowed.add(a.toLowerCase());
    if (this.config.treasury.address) {
      allowed.add(this.config.treasury.address.toLowerCase());
    }
    return allowed;
  }

  /**
   * The aggregator that prices this movement's asset.
   *
   * Native and token movements read different config fields, and both the
   * daily ceiling and the approval threshold need the answer — so it lives in
   * one place rather than being derived twice and drifting.
   */
  private priceFeedFor(movement: Movement): string | undefined {
    return movement.token === null
      ? this.config.policy.nativePriceFeed
      : assetPolicyFor(this.config.policy, movement.token)?.priceFeed;
  }

  async evaluate(movement: Movement): Promise<Decision> {
    const amount = parseAmount(movement.amount);
    if (amount === null) {
      return { verdict: "deny", reason: `amount "${movement.amount}" is not an integer string` };
    }
    if (amount <= 0n) {
      return { verdict: "deny", reason: "amount must be positive" };
    }

    // 1. Recipient allowlist. The single most valuable check: even a fully
    //    compromised agent can only move money to addresses we pre-approved.
    const allowed = this.allowedRecipients();
    if (!allowed.has(movement.to.toLowerCase())) {
      return {
        verdict: "deny",
        reason:
          `recipient ${movement.to} is not on the allowlist. ` +
          `Add it to policy.allowlist or contributors to permit this.`,
      };
    }

    // 2. Pick the limits that belong to this asset.
    //
    //    Caps are denominated in the asset they govern. 1000 USDC is 1e9 base
    //    units, which reads as dust against a wei ceiling, so a token measured
    //    against the native limits would slip through every one of them. A
    //    token with no entry cannot move: guessing is worse than refusing.
    let limits: { symbol: string; maxPerTransfer: string; maxPerDay: string };
    if (movement.token === null) {
      // The native asset has exactly one scale. A movement declaring any other
      // is measured against the caps in one unit and submitted in another —
      // `decimals: 6` reads as dust here and leaves as ten ether.
      if (movement.decimals !== NATIVE_DECIMALS) {
        return {
          verdict: "deny",
          reason:
            `native movements are denominated in wei (${NATIVE_DECIMALS} decimals) but this ` +
            `movement declares ${movement.decimals}`,
        };
      }
      limits = {
        symbol: "native",
        maxPerTransfer: this.config.policy.maxPerTransfer,
        maxPerDay: this.config.policy.maxPerDay,
      };
    } else {
      const asset = assetPolicyFor(this.config.policy, movement.token);
      if (!asset) {
        return {
          verdict: "deny",
          reason:
            `token ${movement.token} has no entry in policy.assets, so no limit applies to ` +
            `it. Add one with its decimals and caps before moving it.`,
        };
      }
      if (asset.decimals !== movement.decimals) {
        // A decimals mismatch silently rescales the amount by orders of
        // magnitude, which is the most expensive kind of typo.
        return {
          verdict: "deny",
          reason:
            `${asset.symbol} is configured with ${asset.decimals} decimals but this movement ` +
            `declares ${movement.decimals}`,
        };
      }
      limits = asset;
    }

    // 3. Per-transfer ceiling.
    const maxPerTransfer = BigInt(limits.maxPerTransfer);
    if (amount > maxPerTransfer) {
      return {
        verdict: "deny",
        reason: `amount ${amount} exceeds ${limits.symbol} maxPerTransfer ${maxPerTransfer}`,
      };
    }

    // 4. Rolling 24h aggregate. Counts in-flight movements too — treating an
    //    unconfirmed transfer as "didn't happen" is how daily caps get breached.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const movedToday = await this.ledger.movedSince(since, movement.token);
    const maxPerDay = BigInt(limits.maxPerDay);
    if (movedToday + amount > maxPerDay) {
      return {
        verdict: "deny",
        reason:
          `would move ${movedToday + amount} ${limits.symbol} in 24h, over maxPerDay ` +
          `${maxPerDay} (${movedToday} already moved)`,
      };
    }

    // 5. The platform's own daily cap.
    //
    //    KeeperHub enforces a per-organisation daily ceiling on direct
    //    execution, and it is the one that actually binds. A locally
    //    configured limit above it is fiction: the movement passes every check
    //    here and then fails at the API for a reason this engine never saw.
    //    Checking it turns that into a refusal that explains itself.
    if (movement.token === null) {
      const platform = await this.remainingPlatformBudget();
      if (platform && amount > platform.remainingWei) {
        return {
          verdict: "deny",
          reason:
            `KeeperHub's daily cap leaves ${platform.remainingWei} wei today ` +
            `(${platform.dailyUsedWei} of ${platform.effectiveDailyCapWei} spent), which is ` +
            `less than this ${amount} wei movement` +
            (platform.usingDefaultCap
              ? ". The org is on the default cap; raise it in KeeperHub to move more."
              : "."),
        };
      }
    }

    // 6. Unreconciled history. If a previous movement is still open we do not
    //    know the true balance, so committing more money is guesswork.
    const open = await this.ledger.openIntents();
    const blocking = open.filter((e) => e.chainId === movement.chainId);
    if (blocking.length > 0) {
      return {
        verdict: "deny",
        reason:
          `${blocking.length} unreconciled movement(s) on chain ${movement.chainId} ` +
          `(${blocking.map((e) => e.intentId).join(", ")}). Run reconcile first.`,
      };
    }

    // 7. The ceiling across every asset at once.
    //
    //    Per-asset caps bound each token; nothing bounds the treasury. Six
    //    assets, each generously capped, add up to no ceiling at all.
    //
    //    Valuing a movement needs a price, and a treasury that phones an
    //    arbitrary price API to decide whether it may spend has taken on a
    //    dependency nobody audited. So the price is read the way the money
    //    moves: a Chainlink aggregator, called through KeeperHub, landing in
    //    the same execution history as every transfer.
    //
    //    Last of the limits, because it costs a price read and there is no
    //    sense paying for one to reject a movement the cheap checks — or an
    //    unreconciled ledger — would have rejected anyway.
    const ceiling = this.config.policy.maxPerDayUsd;
    if (ceiling !== undefined) {
      const feed = this.priceFeedFor(movement);

      if (!this.valuation || !feed) {
        return {
          verdict: "deny",
          reason:
            `a daily value ceiling is set but ${movement.token ?? "the native asset"} has no ` +
            `price feed available, so this movement cannot be counted against it`,
        };
      }

      try {
        const valueCents = await this.valuation.valueInCents(
          amount,
          movement.decimals,
          movement.chainId,
          feed,
        );
        const spentCents = await this.ledger.valueMovedSince(since);
        const capCents = BigInt(ceiling);

        if (spentCents + valueCents > capCents) {
          return {
            verdict: "deny",
            reason:
              `would move ${formatUsd(spentCents + valueCents)} of value in 24h, over the ` +
              `${formatUsd(capCents)} ceiling (${formatUsd(spentCents)} already moved)`,
          };
        }

        // Handed back so it is written down with the movement rather than
        // recomputed later at a price the market has moved since.
        movement.valueUsdCents = valueCents.toString();
      } catch (error) {
        // Fail closed. A ceiling that cannot be evaluated is not a ceiling, and
        // "the price feed was stale" is not a reason to let money out.
        const why = error instanceof ValuationError ? error.message : String(error);
        return { verdict: "deny", reason: `could not value this movement: ${why}` };
      }
    }

    // 8. Human escalation threshold — last, so the reason returned is the most
    //    actionable one rather than an approval prompt masking a hard failure.
    //
    //    Two thresholds, because one of them cannot see most spending.
    //    `requireApprovalAbove` is denominated in the native asset, so it can
    //    only govern native movements: 5000 base units of USDC against a wei
    //    threshold is not a comparison. That left token spending unescalated at
    //    any size — which is precisely the case this exists for, since an agent
    //    paying invoices pays in stablecoins.
    const nativeThreshold =
      movement.token === null ? this.config.policy.requireApprovalAbove : undefined;
    if (nativeThreshold !== undefined && amount > BigInt(nativeThreshold)) {
      return {
        verdict: "needs_approval",
        reason: `amount ${amount} exceeds requireApprovalAbove ${nativeThreshold}`,
      };
    }

    const usdThreshold = this.config.policy.requireApprovalAboveUsd;
    if (usdThreshold !== undefined) {
      // Reuse the valuation the ceiling already computed when it ran; only
      // price it here when no ceiling is configured.
      let valueCents: bigint | null =
        movement.valueUsdCents !== undefined ? BigInt(movement.valueUsdCents) : null;

      if (valueCents === null) {
        const feed = this.priceFeedFor(movement);
        if (!this.valuation || !feed) {
          // Fail closed, consistently with the ceiling: a threshold that cannot
          // be evaluated must not wave the movement through.
          return {
            verdict: "deny",
            reason:
              `a USD approval threshold is set but ${movement.token ?? "the native asset"} ` +
              `has no price feed available, so this movement cannot be measured against it`,
          };
        }
        try {
          valueCents = await this.valuation.valueInCents(
            amount,
            movement.decimals,
            movement.chainId,
            feed,
          );
          movement.valueUsdCents = valueCents.toString();
        } catch (error) {
          const why = error instanceof ValuationError ? error.message : String(error);
          return { verdict: "deny", reason: `could not value this movement: ${why}` };
        }
      }

      if (valueCents > BigInt(usdThreshold)) {
        return {
          verdict: "needs_approval",
          reason:
            `${formatUsd(valueCents)} exceeds the ${formatUsd(BigInt(usdThreshold))} ` +
            `approval threshold`,
        };
      }
    }

    return { verdict: "allow" };
  }
}

function parseAmount(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}
