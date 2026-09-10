/**
 * BursarService — the treasury, mounted into an ElizaOS agent's lifecycle.
 *
 * This is a Service rather than a bag of helpers because an ElizaOS agent is a
 * long-lived process: the runtime starts it once, every action and provider
 * shares the same instance, and `stop()` is called on shutdown. That matters
 * for a treasury specifically — the ledger's open-intent invariant only holds
 * if there is exactly one writer per agent.
 */

import { Service, type IAgentRuntime } from "@elizaos/core";


import { loadConfig, splitByShares, type BursarConfig } from "../config.js";
import { KeeperHubClient } from "../keeperhub/client.js";
import { Ledger, dailyPeriod, type LedgerEntry } from "../ledger/store.js";
import { PolicyEngine } from "../policy/engine.js";
import { Executor, type MoveOutcome } from "../treasury/executor.js";
import { formatUnits, NATIVE_DECIMALS } from "../units.js";
import { floatMonitorWorkflow, readBalanceOutput } from "../treasury/workflows.js";

/** Settings arrive loosely typed; every value we read is a string or absent. */
function setting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return value === undefined || value === null ? undefined : String(value);
}


export interface FloatReport {
  chainId: number;
  address: string;
  /** Decimal string, or null when the reading failed. */
  balance: string | null;
  /** Decimal string when a top-up was attempted. */
  topUp: string | null;
  note: string;
}

export interface PayoutReport {
  total: string;
  outcomes: Array<{
    contributor: string;
    address: string;
    amount: string;
    outcome: MoveOutcome;
  }>;
}

export class BursarService extends Service {
  static override serviceType = "bursar";

  override capabilityDescription =
    "Manages the agent's onchain treasury: pays contributors their revenue share, " +
    "keeps operational gas topped up, and reconciles every movement through KeeperHub.";

  private client!: KeeperHubClient;
  private ledger!: Ledger;
  private executor!: Executor;
  private treasuryCfg!: BursarConfig;

  static override async start(runtime: IAgentRuntime): Promise<BursarService> {
    const service = new BursarService(runtime);
    await service.initialize(runtime);
    return service;
  }

  private async initialize(runtime: IAgentRuntime): Promise<void> {
    // Settings come from the character file or environment, which is how
    // ElizaOS expects plugins to be configured.
    const apiKey = setting(runtime, "KEEPERHUB_API_KEY");
    if (!apiKey) {
      throw new Error(
        "KEEPERHUB_API_KEY is not set. Add it to the character's secrets or the " +
          "environment before loading plugin-bursar.",
      );
    }

    const configPath = setting(runtime, "BURSAR_CONFIG_PATH") ?? "bursar.config.json";
    const ledgerPath = setting(runtime, "BURSAR_LEDGER_PATH") ?? "data/ledger.jsonl";

    this.treasuryCfg = await loadConfig(configPath);
    this.client = new KeeperHubClient({
      apiKey,
      baseUrl: setting(runtime, "KEEPERHUB_BASE_URL"),
    });
    this.ledger = new Ledger(ledgerPath);
    this.executor = new Executor(
      this.client,
      this.ledger,
      new PolicyEngine(this.treasuryCfg, this.ledger),
      this.treasuryCfg,
    );
  }

  override async stop(): Promise<void> {
    // Nothing to tear down: the client is stateless and the ledger is written
    // append-only per call, so there is no buffered state to lose on shutdown.
  }

  get treasuryConfig(): BursarConfig {
    return this.treasuryCfg;
  }

  /**
   * Distribute revenue to contributors by their configured shares.
   *
   * Each contributor is a separate movement, so one failed payout does not roll
   * back the others — and each is independently idempotent, so a retry pays
   * only whoever is still owed.
   */
  async payContributors(revenueBaseUnits: bigint, period = dailyPeriod()): Promise<PayoutReport> {
    const allocations = splitByShares(revenueBaseUnits, this.treasuryCfg.contributors);
    const chainId = this.executor.payoutChain();
    const outcomes: PayoutReport["outcomes"] = [];

    for (const { contributor, amount } of allocations) {
      if (amount <= 0n) continue;

      const outcome = await this.executor.move(
        {
          leg: "payout",
          chainId,
          to: contributor.address,
          amount: amount.toString(),
          token: null,
          decimals: NATIVE_DECIMALS,
          memo: `revenue share for ${contributor.name} (${contributor.shareBps} bps)`,
        },
        period,
      );

      outcomes.push({
        contributor: contributor.name,
        address: contributor.address,
        amount: amount.toString(),
        outcome,
      });
    }

    return { total: revenueBaseUnits.toString(), outcomes };
  }

  /**
   * Keep the operating wallet above its floor.
   *
   * The balance comes from the agent-authored monitor workflow rather than a
   * local RPC call: it is the same reading KeeperHub's scheduler takes, so the
   * decision cannot disagree with the platform's own view.
   *
   * The top-up amount is `target - min`, fixed from config rather than derived
   * from the reading. A top-up computed from the balance it is about to change
   * can chase its own effect; a fixed amount cannot.
   */
  async checkFloat(period = dailyPeriod()): Promise<FloatReport[]> {
    const reports: FloatReport[] = [];

    for (const float of this.treasuryCfg.float) {
      const workflow = floatMonitorWorkflow(float);
      const workflowId = await this.ensureWorkflow(workflow.name, workflow);

      const run = await this.client.executeWorkflow(workflowId, {}, `float-${workflowId}-${Date.now()}`);
      const final = await this.client.awaitExecution(run.executionId);
      const reading = readBalanceOutput(final.output);

      if (!reading) {
        reports.push({
          chainId: float.chainId,
          address: float.address,
          balance: null,
          topUp: null,
          note: `could not read balance (execution ${final.status})`,
        });
        continue;
      }

      const balance = BigInt(reading.balanceWei);
      const floor = BigInt(float.minBalance);

      if (balance >= floor) {
        reports.push({
          chainId: float.chainId,
          address: float.address,
          balance: reading.balance,
          topUp: null,
          note: `above the ${formatUnits(floor, NATIVE_DECIMALS)} floor; nothing to do`,
        });
        continue;
      }

      const amount = (BigInt(float.targetBalance) - floor).toString();
      const outcome = await this.executor.move(
        {
          leg: "float",
          chainId: float.chainId,
          to: float.address,
          amount,
          token: null,
          decimals: NATIVE_DECIMALS,
          memo: `gas top-up: balance ${reading.balance} below floor`,
        },
        period,
      );

      reports.push({
        chainId: float.chainId,
        address: float.address,
        balance: reading.balance,
        topUp: formatUnits(BigInt(amount), NATIVE_DECIMALS),
        note:
          outcome.result === "confirmed"
            ? `topped up — ${outcome.transactionHashes[0] ?? ""}`
            : outcome.result === "blocked"
              ? `top-up blocked: ${outcome.reason}`
              : `top-up ${outcome.result}`,
      });
    }

    return reports;
  }

  /** Author the workflow if absent, update it if present. Never duplicates. */
  private async ensureWorkflow(name: string, workflow: unknown): Promise<string> {
    const existing = await this.client.listWorkflows();
    const rows = (Array.isArray(existing) ? existing : []) as Array<{ id: string; name: string }>;
    const found = rows.find((r) => r.name === name);

    if (found) {
      await this.client.updateWorkflow(found.id, workflow, `wf-${found.id}`);
      return found.id;
    }
    const created = await this.client.createWorkflow(workflow, `wf-${name}`);
    return String((created as { id?: string })?.id ?? "");
  }

  /** Resolve every open intent against the chain. See Executor.reconcile. */
  reconcile(): ReturnType<Executor["reconcile"]> {
    return this.executor.reconcile();
  }

  async openIntents(): Promise<LedgerEntry[]> {
    return this.ledger.openIntents();
  }

  /**
   * A human-readable statement of where the money went, assembled from the
   * ledger. Every confirmed line carries its transaction hash, so the report
   * is verifiable rather than merely claimed.
   */
  async statement(): Promise<string> {
    const entries = [...(await this.ledger.latestByIntent()).values()].sort((a, b) =>
      a.at.localeCompare(b.at),
    );

    if (entries.length === 0) {
      return "No treasury movements recorded yet.";
    }

    const lines: string[] = [];
    const totals = new Map<string, bigint>();

    for (const entry of entries) {
      const amount = formatUnits(BigInt(entry.amount), entry.decimals);
      const link = entry.transactionLinks?.[0] ?? entry.transactionHashes?.[0] ?? "";
      lines.push(
        `${entry.at}  ${entry.status.padEnd(9)} ${entry.leg.padEnd(6)} ` +
          `${amount} -> ${entry.to}${link ? `  ${link}` : ""}`,
      );
      if (entry.status === "confirmed") {
        totals.set(entry.leg, (totals.get(entry.leg) ?? 0n) + BigInt(entry.amount));
      }
    }

    const summary = [...totals.entries()]
      .map(([leg, total]) => `${leg}: ${formatUnits(total, NATIVE_DECIMALS)}`)
      .join(", ");

    const open = entries.filter((e) => e.status === "intent" || e.status === "submitted").length;

    return [
      lines.join("\n"),
      "",
      `Confirmed totals — ${summary || "none"}`,
      open > 0
        ? `${open} movement(s) unreconciled. Treasury is locked until RECONCILE_TREASURY runs.`
        : "All movements reconciled.",
    ].join("\n");
  }
}
