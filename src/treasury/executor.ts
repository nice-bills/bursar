/**
 * The one path through which value moves.
 *
 * Every leg — sweep, payout, float, yield — funnels through `move()`, so the
 * policy check, the intent record, the idempotency key, and the reconciliation
 * hook exist exactly once. Adding a fifth leg later gets all of it for free,
 * and cannot accidentally opt out.
 */

import type { BursarConfig } from "../config.js";
import { PRIVATE_MEMPOOL_CHAINS } from "../config.js";
import type { KeeperHubClient } from "../keeperhub/client.js";
import { isSuccess } from "../keeperhub/client.js";
import { Ledger, type LedgerEntry } from "../ledger/store.js";
import type { Movement, PolicyEngine } from "../policy/engine.js";

export type MoveOutcome =
  | { result: "confirmed"; entry: LedgerEntry; transactionHashes: string[] }
  | { result: "failed"; entry: LedgerEntry; error: string }
  | { result: "skipped"; reason: string; intentId: string }
  | { result: "blocked"; reason: string; verdict: "deny" | "needs_approval" };

export class Executor {
  constructor(
    private readonly client: KeeperHubClient,
    private readonly ledger: Ledger,
    private readonly policy: PolicyEngine,
    private readonly config: BursarConfig,
  ) {}

  /**
   * Move value, once.
   *
   * `period` scopes the idempotency key: two calls to pay the same contributor
   * the same amount in the same period are the same payment, and the second is
   * a no-op. Pass `nonce` when a genuine second payment is intended.
   */
  async move(
    movement: Movement,
    period: string,
    nonce?: string,
  ): Promise<MoveOutcome> {
    const intentId = Ledger.intentId({
      leg: movement.leg,
      chainId: movement.chainId,
      to: movement.to,
      amount: movement.amount,
      token: movement.token,
      period,
      nonce,
    });

    // Cheapest possible exit: we already did this.
    if (await this.ledger.alreadyConfirmed(intentId)) {
      return {
        result: "skipped",
        intentId,
        reason: `${movement.leg} already confirmed for period ${period}`,
      };
    }

    const decision = await this.policy.evaluate(movement);
    if (decision.verdict !== "allow") {
      return { result: "blocked", reason: decision.reason, verdict: decision.verdict };
    }

    // Record the intent BEFORE submitting. If the process dies on the next
    // line, reconcile() can still find this and ask the chain what happened.
    const base = {
      intentId,
      leg: movement.leg,
      chainId: movement.chainId,
      to: movement.to,
      amount: movement.amount,
      token: movement.token,
      memo: movement.memo,
    };
    await this.ledger.append({ ...base, status: "intent" });

    let executionId = "";
    try {
      const submitted = await this.client.transfer(
        {
          chainId: String(movement.chainId),
          to: movement.to,
          amount: movement.amount,
          tokenAddress: movement.token ?? undefined,
        },
        intentId,
      );

      executionId = submitted.executionId;
      await this.ledger.append({ ...base, status: "submitted", executionId });

      const final = executionId
        ? await this.client.awaitExecution(executionId)
        : submitted;

      if (isSuccess(final.status)) {
        const entry = await this.ledger.append({
          ...base,
          status: "confirmed",
          executionId,
          transactionHashes: final.transactionHashes,
        });
        return { result: "confirmed", entry, transactionHashes: final.transactionHashes };
      }

      const entry = await this.ledger.append({
        ...base,
        status: "failed",
        executionId,
        error: `execution finished as ${final.status}`,
        transactionHashes: final.transactionHashes,
      });
      return { result: "failed", entry, error: `execution finished as ${final.status}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Deliberately NOT marked failed. We asked KeeperHub to move money and
      // never heard back — the transfer may well have landed. Leave it open so
      // reconcile() resolves it against the chain rather than guessing here.
      const entry = await this.ledger.append({
        ...base,
        status: "submitted",
        executionId,
        error: `unresolved: ${message}`,
      });
      return {
        result: "failed",
        entry,
        error: `unresolved after submit: ${message}. Run reconcile before moving more value.`,
      };
    }
  }

  /**
   * Resolve every open intent against KeeperHub's record of what actually
   * happened. This is what unblocks the policy engine after a crash.
   */
  async reconcile(): Promise<{ resolved: number; stillOpen: number; details: string[] }> {
    const open = await this.ledger.openIntents();
    const details: string[] = [];
    let resolved = 0;

    for (const entry of open) {
      if (!entry.executionId) {
        // Never made it to submission — no execution to ask about. The intent
        // was written, the call never happened, so nothing moved.
        await this.ledger.append({ ...entry, status: "abandoned", error: "never submitted" });
        details.push(`${entry.intentId}: abandoned (never submitted)`);
        resolved++;
        continue;
      }

      try {
        const status = await this.client.getExecutionStatus(entry.executionId);
        if (isSuccess(status.status)) {
          await this.ledger.append({
            ...entry,
            status: "confirmed",
            transactionHashes: status.transactionHashes,
          });
          details.push(
            `${entry.intentId}: confirmed (${status.transactionHashes.join(", ") || "no hash"})`,
          );
          resolved++;
        } else if (isTerminalFailure(status.status)) {
          await this.ledger.append({
            ...entry,
            status: "failed",
            error: `execution finished as ${status.status}`,
          });
          details.push(`${entry.intentId}: failed (${status.status})`);
          resolved++;
        } else {
          details.push(`${entry.intentId}: still ${status.status}`);
        }
      } catch (error) {
        details.push(
          `${entry.intentId}: could not resolve (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }

    return { resolved, stillOpen: open.length - resolved, details };
  }

  /**
   * Preferred chain for a payout. MEV protection only exists on some chains,
   * and money leaving the treasury is exactly what you want shielded.
   */
  payoutChain(): number {
    const configured = this.config.treasury.chainId;
    return PRIVATE_MEMPOOL_CHAINS.includes(configured)
      ? configured
      : (PRIVATE_MEMPOOL_CHAINS[0] ?? configured);
  }
}

function isTerminalFailure(status: string): boolean {
  const s = status.toLowerCase();
  return s === "failed" || s === "error" || s === "cancelled" || s === "canceled";
}
