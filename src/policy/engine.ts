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
import type { Leg, Ledger } from "../ledger/store.js";
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
    let limits: SpendingLimits | null = null;
    try {
      limits = await this.platformLimits();
    } catch {
      limits = null;
    }
    this.cachedLimits = { at: now, limits };
    return limits;
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

    // 7. Human escalation threshold — last, so the reason returned is the most
    //    actionable one rather than an approval prompt masking a hard failure.
    //    Only meaningful for the native asset it is denominated in.
    const threshold =
      movement.token === null ? this.config.policy.requireApprovalAbove : undefined;
    if (threshold !== undefined && amount > BigInt(threshold)) {
      return {
        verdict: "needs_approval",
        reason: `amount ${amount} exceeds requireApprovalAbove ${threshold}`,
      };
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
