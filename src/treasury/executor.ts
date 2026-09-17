/**
 * The one path through which value moves under this process's own policy.
 *
 * Sweep, payout and yield funnel through `move()`, so the policy check, the
 * intent record, the idempotency key and the reconciliation hook exist exactly
 * once. Adding another leg of that kind gets all of it for free, and cannot
 * accidentally opt out.
 *
 * Two legs reach the chain by other routes, and it is worth being precise about
 * why rather than letting the sentence above imply otherwise:
 *
 *   - `float` is decided and executed by a KeeperHub keeper on a schedule, so
 *     it keeps working while the agent is down — which is the only time running
 *     out of gas matters. It is recorded here after the fact so it still shows
 *     up in the ledger.
 *   - `purchase` is an x402 invoice signed locally by the payer key, because
 *     x402 settlement is client-side. It goes through the same policy engine
 *     (see `lucid/pay.ts`) and the same ledger, just not through `move()`.
 */

import type { BursarConfig } from "../config.js";
import { PRIVATE_MEMPOOL_CHAINS } from "../config.js";
import type { KeeperHubClient } from "../keeperhub/client.js";
import { isSuccess, isTerminal, type ExecutionResult } from "../keeperhub/client.js";
import { Ledger, type LedgerEntry, type SubmissionRoute } from "../ledger/store.js";
import { formatUnits } from "../units.js";
import { ERC20_APPROVE_ABI } from "./workflows.js";
import type { Movement, PolicyEngine } from "../policy/engine.js";

/**
 * How a movement reaches the chain.
 *
 * Receives the intent id so whatever it calls uses the same idempotency key,
 * which is what makes replay-based reconciliation work for non-transfers too.
 *
 * Callers describe the route (see `SubmissionRoute`) rather than passing a
 * closure, because the route has to outlive the call: a movement held for a
 * person is submitted hours later, and a movement interrupted mid-flight is
 * replayed by `reconcile()` in a different process entirely. Neither can
 * reconstruct a closure, and both used to silently fall back to a plain
 * transfer — which, for an Aave supply, sends the tokens to the pool contract
 * and loses them.
 */
export type Submit = (idempotencyKey: string) => Promise<ExecutionResult>;

export type MoveOutcome =
  | { result: "confirmed"; entry: LedgerEntry; transactionHashes: string[] }
  | { result: "failed"; entry: LedgerEntry; error: string }
  | { result: "skipped"; reason: string; intentId: string }
  | { result: "blocked"; reason: string; verdict: "deny" }
  /** Written down and waiting for a person. Nothing has been sent. */
  | { result: "held"; intentId: string; reason: string; entry: LedgerEntry };

/**
 * A daily cap is a serial invariant: two movements that each read the ledger
 * before either writes will both see room under the cap and both proceed. That
 * is a real double-spend, not a theoretical one — ElizaOS dispatches actions
 * concurrently, so two payouts can be in flight at once.
 *
 * The whole of `move()` is held, not just the check, because the intent must be
 * durable before the next caller evaluates policy. Payouts therefore execute
 * one at a time. For a treasury that is the correct trade: throughput is worth
 * nothing if the balance is wrong.
 *
 * The lock belongs to the Ledger (`ledger.serialize`) rather than to this
 * class, so that the x402 purchase path — which records movements without
 * going through the Executor — contends for the same lock instead of racing it.
 */
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
  move(
    movement: Movement,
    period: string,
    nonce?: string,
    route?: SubmissionRoute,
  ): Promise<MoveOutcome> {
    return this.ledger.serialize(() => this.moveExclusive(movement, period, nonce, route));
  }

  /** Turn a recorded route back into the call that performs it. */
  private submitFor(route: SubmissionRoute, movement: Movement): Submit {
    if (route.kind === "workflow") {
      const { workflowId, allowance } = route;
      return async (idempotencyKey) => {
        if (allowance) {
          // Scoped to exactly the amount about to move, and granted only now —
          // after policy has cleared the movement, not before it was asked.
          await this.client.contractCall(
            {
              chainId: String(allowance.chainId),
              contractAddress: allowance.token,
              abi: ERC20_APPROVE_ABI,
              functionName: "approve",
              functionArgs: JSON.stringify([allowance.spender, allowance.amount]),
            },
            `${idempotencyKey}-allowance`,
          );
        }
        return this.client.executeWorkflow(workflowId, {}, idempotencyKey);
      };
    }
    return (idempotencyKey) =>
      this.client.transfer(
        {
          chainId: String(movement.chainId),
          recipientAddress: movement.to,
          amount: formatUnits(BigInt(movement.amount), movement.decimals),
          tokenAddress: movement.token ?? undefined,
        },
        idempotencyKey,
      );
  }

  private async moveExclusive(
    movement: Movement,
    period: string,
    nonce?: string,
    route: SubmissionRoute = { kind: "transfer" },
    existingIntentId?: string,
  ): Promise<MoveOutcome> {
    const intentId = existingIntentId ?? Ledger.intentId({
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

    // A movement already released by a person skips straight past the
    // threshold that held it; that decision is what approval means.
    const released = await this.ledger.isApproved(intentId);

    const decision = await this.policy.evaluate(movement);

    // Built AFTER the evaluation, not before: pricing the movement is part of
    // evaluating it, and `valueUsdCents` does not exist until the engine has
    // read the feed. Snapshotting the movement first captured an undefined
    // every time, which left the cross-asset ceiling summing nothing.
    const base = {
      intentId,
      leg: movement.leg,
      chainId: movement.chainId,
      to: movement.to,
      amount: movement.amount,
      token: movement.token,
      decimals: movement.decimals,
      valueUsdCents: movement.valueUsdCents,
      memo: movement.memo,
      submission: route,
    };

    if (decision.verdict === "deny") {
      return { result: "blocked", reason: decision.reason, verdict: "deny" };
    }

    if (decision.verdict === "needs_approval" && !released) {
      // Held, not refused. Writing it down is the whole point: a request that
      // needs a person is worthless if it evaporates when the agent gives up,
      // and a person cannot approve something nobody recorded.
      const entry = await this.ledger.append({
        ...base,
        status: "awaiting_approval",
        heldReason: decision.reason,
      });
      return { result: "held", intentId, reason: decision.reason, entry };
    }

    // Record the intent BEFORE submitting. If the process dies on the next
    // line, reconcile() can still find this and ask the chain what happened.
    await this.ledger.append({ ...base, status: "intent" });

    let executionId = "";
    try {
      // A plain transfer unless the route says otherwise. Supplying to a
      // lending pool is not a transfer, but it is still value leaving the
      // treasury, so it must pass through the same policy, ledger and
      // idempotency rather than around them.
      const submitted = await this.submitFor(route, movement)(intentId);

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
        // A success carrying no transaction hash is not proof anything moved —
        // a gated workflow reports the same status when its condition is false.
        // Recording that as confirmed consumes the daily cap and makes the
        // intent permanently `skipped` on retry, for a movement that never
        // happened. Leave it open for reconcile to settle against the chain.
        if (final.transactionHashes.length === 0) {
          const entry = await this.ledger.append({
            ...base,
            status: "submitted",
            executionId,
            error:
              `execution ${final.status} but reported no transaction hash, so whether it ` +
              `moved is unknown. Run reconcile before moving more value.`,
          });
          return {
            result: "failed",
            entry,
            error: `${final.status} with no transaction hash — unresolved`,
          };
        }

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

  /** Movements waiting on a person. */
  pending(): Promise<LedgerEntry[]> {
    return this.ledger.awaitingApproval();
  }

  /**
   * Release a held movement and carry it out.
   *
   * Approval is recorded before the money moves, so the decision survives a
   * crash between deciding and sending, exactly as the intent does.
   */
  async approve(intentId: string, decidedBy: string): Promise<MoveOutcome> {
    return this.ledger.serialize(async () => {
      const held = (await this.ledger.latestByIntent()).get(intentId);
      if (!held || held.status !== "awaiting_approval") {
        return {
          result: "blocked" as const,
          verdict: "deny" as const,
          reason: held
            ? `${intentId} is ${held.status}, not awaiting approval`
            : `no held movement with id ${intentId}`,
        };
      }

      await this.ledger.append({ ...held, status: "approved", decidedBy });

      // Re-enter the normal path. Every other check runs again on the way
      // through — approval lifts the threshold, not the allowlist or the caps.
      //
      // The route comes from the held row, not from a default: this movement
      // may be an Aave supply, and sending it as a plain transfer would put the
      // tokens inside the pool contract with nothing minted back.
      return this.moveExclusive(
        {
          leg: held.leg,
          chainId: held.chainId,
          to: held.to,
          amount: held.amount,
          token: held.token,
          decimals: held.decimals,
          ...(held.valueUsdCents ? { valueUsdCents: held.valueUsdCents } : {}),
          memo: held.memo,
        },
        "",
        undefined,
        held.submission ?? { kind: "transfer" },
        intentId,
      );
    });
  }

  /**
   * Refuse a held movement, so it stops showing up as a decision to make.
   *
   * Serialised with the rest, because "approve it" and "cancel it" can arrive
   * together: read-then-append outside the lock lets both see the same held row
   * and lets the decline land after the approval has already submitted.
   */
  async decline(intentId: string, decidedBy: string): Promise<boolean> {
    return this.ledger.serialize(async () => {
      const held = (await this.ledger.latestByIntent()).get(intentId);
      if (!held || held.status !== "awaiting_approval") return false;
      await this.ledger.append({ ...held, status: "declined", decidedBy });
      return true;
    });
  }

  /**
   * Give up on an intent that cannot be resolved, on a person's say-so.
   *
   * `reconcile()` can only close what it can replay. An intent whose submission
   * keeps failing for a reason replaying will not change — a revoked key, a bad
   * token address, an x402 payee that no longer exists — otherwise stays open
   * forever, and an open intent blocks every movement on its chain. Without
   * this the only way out was editing the JSONL by hand.
   *
   * It records a decision, it does not assert an outcome: check the chain
   * before calling it.
   */
  async abandon(intentId: string, decidedBy: string, reason: string): Promise<boolean> {
    return this.ledger.serialize(async () => {
      const entry = (await this.ledger.latestByIntent()).get(intentId);
      if (!entry) return false;
      if (entry.status !== "intent" && entry.status !== "submitted") return false;
      await this.ledger.append({
        ...entry,
        status: "abandoned",
        decidedBy,
        error: `abandoned: ${reason}`,
      });
      return true;
    });
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
    return this.ledger.serialize(() => this.reconcileExclusive());
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
      const route: SubmissionRoute = entry.submission ?? { kind: "transfer" };

      // Not every movement can be resolved by replaying it. An x402 purchase
      // was paid from the payer key, so KeeperHub has never seen this
      // idempotency key and "replaying" it would be a second real payment.
      // Report it and leave it open rather than guess.
      if (route.kind === "x402") {
        details.push(
          `${entry.intentId}: still open — paid over x402 to ${route.url}, which cannot be ` +
            `replayed safely. Check the payee's records, then close it with ` +
            `abandon("${entry.intentId}", ...).`,
        );
        continue;
      }

      try {
        const result = await this.submitFor(route, {
          leg: entry.leg,
          chainId: entry.chainId,
          to: entry.to,
          amount: entry.amount,
          token: entry.token,
          decimals: entry.decimals,
          memo: entry.memo,
        })(entry.intentId);

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
