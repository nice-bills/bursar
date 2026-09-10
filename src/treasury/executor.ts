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
import { isSuccess, isTerminal, type ExecutionResult } from "../keeperhub/client.js";
import { Ledger, type LedgerEntry } from "../ledger/store.js";
import { formatUnits } from "../units.js";
import type { Movement, PolicyEngine } from "../policy/engine.js";

/**
 * How a movement reaches the chain.
 *
 * Receives the intent id so whatever it calls uses the same idempotency key,
 * which is what makes replay-based reconciliation work for non-transfers too.
 */
export type Submit = (idempotencyKey: string) => Promise<ExecutionResult>;

export type MoveOutcome =
  | { result: "confirmed"; entry: LedgerEntry; transactionHashes: string[] }
  | { result: "failed"; entry: LedgerEntry; error: string }
  | { result: "skipped"; reason: string; intentId: string }
  | { result: "blocked"; reason: string; verdict: "deny" | "needs_approval" };

/**
 * Serialises the policy-check-then-record section.
 *
 * A daily cap is a serial invariant: two movements that each read the ledger
 * before either writes will both see room under the cap and both proceed. That
 * is a real double-spend, not a theoretical one — ElizaOS dispatches actions
 * concurrently, so two payouts can be in flight at once.
 *
 * The whole of `move()` is held, not just the check, because the intent must be
 * durable before the next caller evaluates policy. Payouts therefore execute
 * one at a time. For a treasury that is the correct trade: throughput is worth
 * nothing if the balance is wrong.
 */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Keep the chain alive even when a caller rejects, or one failure would
    // poison every movement that follows it.
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class Executor {
  private readonly mutex = new Mutex();

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
  move(
    movement: Movement,
    period: string,
    nonce?: string,
    submit?: Submit,
  ): Promise<MoveOutcome> {
    return this.mutex.run(() => this.moveExclusive(movement, period, nonce, submit));
  }

  private async moveExclusive(
    movement: Movement,
    period: string,
    nonce?: string,
    submit?: Submit,
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
      decimals: movement.decimals,
      memo: movement.memo,
    };
    await this.ledger.append({ ...base, status: "intent" });

    let executionId = "";
    try {
      // A plain transfer unless the caller supplies something else. Supplying
      // to a lending pool is not a transfer, but it is still value leaving the
      // treasury, so it must pass through the same policy, ledger and
      // idempotency rather than around them.
      const submitted = submit
        ? await submit(intentId)
        : await this.client.transfer(
            {
              chainId: String(movement.chainId),
              recipientAddress: movement.to,
              // The boundary: exact integer base units in, decimal string out.
              amount: formatUnits(BigInt(movement.amount), movement.decimals),
              tokenAddress: movement.token ?? undefined,
            },
            intentId,
          );

      executionId = submitted.executionId;
      await this.ledger.append({ ...base, status: "submitted", executionId });

      // Direct transfers complete synchronously: the POST already carries a
      // terminal status, and there is no workflow execution to poll — the
      // /workflows/executions/* endpoints 404 for these. Only poll when the
      // response says the work is still running.
      const final =
        executionId && !isTerminal(submitted.status)
          ? await this.client.awaitExecution(executionId)
          : submitted;

      if (isSuccess(final.status)) {
        const entry = await this.ledger.append({
          ...base,
          status: "confirmed",
          executionId,
          transactionHashes: final.transactionHashes,
          transactionLinks: final.transactionLinks,
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
   * Resolve every open intent by replaying it under its original idempotency
   * key.
   *
   * This is the payoff of intent-first logging. Confirmed against the live API:
   * a recognised idempotency key returns the ORIGINAL execution, flagged
   * `idempotentReplay: true`, without running a second transaction. So replay
   * is not a guess about what happened —
   *
   *   - if the movement did execute, the server hands back the original
   *     transaction hash and we close the intent with the truth;
   *   - if it never executed, it executes now, completing a movement policy
   *     already approved before it was ever written down.
   *
   * Either way the ledger ends up agreeing with the chain, which is the only
   * state from which it is safe to move more money.
   */
  reconcile(): Promise<{ resolved: number; stillOpen: number; details: string[] }> {
    return this.mutex.run(() => this.reconcileExclusive());
  }

  private async reconcileExclusive(): Promise<{
    resolved: number;
    stillOpen: number;
    details: string[];
  }> {
    const open = await this.ledger.openIntents();
    const details: string[] = [];
    let resolved = 0;

    for (const entry of open) {
      try {
        const result = await this.client.transfer(
          {
            chainId: String(entry.chainId),
            recipientAddress: entry.to,
            amount: formatUnits(BigInt(entry.amount), entry.decimals),
            tokenAddress: entry.token ?? undefined,
          },
          entry.intentId,
        );

        const how = result.idempotentReplay ? "already executed" : "completed now";

        if (isSuccess(result.status)) {
          await this.ledger.append({
            ...entry,
            status: "confirmed",
            executionId: result.executionId,
            transactionHashes: result.transactionHashes,
            transactionLinks: result.transactionLinks,
          });
          details.push(
            `${entry.intentId}: confirmed, ${how} (${result.transactionHashes.join(", ") || "no hash"})`,
          );
          resolved++;
        } else if (isTerminal(result.status)) {
          await this.ledger.append({
            ...entry,
            status: "failed",
            executionId: result.executionId,
            error: `execution finished as ${result.status}`,
          });
          details.push(`${entry.intentId}: failed (${result.status})`);
          resolved++;
        } else {
          details.push(`${entry.intentId}: still ${result.status}`);
        }
      } catch (error) {
        // Leave it open. An intent we could not resolve must keep blocking
        // further movement rather than being quietly written off.
        details.push(
          `${entry.intentId}: unresolved (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }

    return { resolved, stillOpen: open.length - resolved, details };
  }

  /**
   * The chain a payout goes out on.
   *
   * This used to prefer a private-mempool chain and silently redirect there
   * when the treasury sat elsewhere — so a treasury funded on Base would send
   * its payouts on Ethereum mainnet, where it holds nothing. Every transfer
   * would fail, and the MEV protection bought nothing because no value moved.
   *
   * Money moves on the chain that holds it. Private routing is a property of
   * that chain, not a reason to change it. `payoutChainId` exists for a
   * deliberate cross-chain payout, and is the caller's responsibility to fund.
   */
  payoutChain(): number {
    return this.config.treasury.payoutChainId ?? this.config.treasury.chainId;
  }

  /** Whether payouts on the chosen chain get MEV-protected submission. */
  payoutChainIsPrivate(): boolean {
    return PRIVATE_MEMPOOL_CHAINS.includes(this.payoutChain());
  }
}
