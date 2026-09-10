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

import type { BursarConfig } from "../config.js";
import type { Leg, Ledger } from "../ledger/store.js";

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
  constructor(
    private readonly config: BursarConfig,
    private readonly ledger: Ledger,
  ) {}

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

    // 2. Per-transfer ceiling.
    const maxPerTransfer = BigInt(this.config.policy.maxPerTransfer);
    if (amount > maxPerTransfer) {
      return {
        verdict: "deny",
        reason: `amount ${amount} exceeds maxPerTransfer ${maxPerTransfer}`,
      };
    }

    // 3. Rolling 24h aggregate. Counts in-flight movements too — treating an
    //    unconfirmed transfer as "didn't happen" is how daily caps get breached.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const movedToday = await this.ledger.movedSince(since, movement.token);
    const maxPerDay = BigInt(this.config.policy.maxPerDay);
    if (movedToday + amount > maxPerDay) {
      return {
        verdict: "deny",
        reason:
          `would move ${movedToday + amount} in 24h, over maxPerDay ${maxPerDay} ` +
          `(${movedToday} already moved)`,
      };
    }

    // 4. Unreconciled history. If a previous movement is still open we do not
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

    // 5. Human escalation threshold — last, so the reason returned is the most
    //    actionable one rather than an approval prompt masking a hard failure.
    const threshold = this.config.policy.requireApprovalAbove;
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
