/**
 * BursarService — the treasury, mounted into an ElizaOS agent's lifecycle.
 *
 * This is a Service rather than a bag of helpers because an ElizaOS agent is a
 * long-lived process: the runtime starts it once, every action and provider
 * shares the same instance, and `stop()` is called on shutdown. That matters
 * for a treasury specifically — the ledger's open-intent invariant only holds
 * if there is exactly one writer per agent.
 */

import { createHash } from "node:crypto";

import { Service, type IAgentRuntime } from "@elizaos/core";


import { loadConfig, splitByShares, type BursarConfig } from "../config.js";
import { KeeperHubClient } from "../keeperhub/client.js";
import { Ledger, dailyPeriod, type LedgerEntry } from "../ledger/store.js";
import { PolicyEngine } from "../policy/engine.js";
import { Executor, type MoveOutcome } from "../treasury/executor.js";
import { formatUnits, NATIVE_DECIMALS } from "../units.js";
import {
  gasFloatWorkflow,
  nativeBalanceWorkflow,
  readBalanceOutput,
  erc20BalanceWorkflow,
  readErc20Output,
  aaveSupplyWorkflow,
  ERC20_APPROVE_ABI,
} from "../treasury/workflows.js";
import { assetPolicyFor } from "../config.js";

/** Settings arrive loosely typed; every value we read is a string or absent. */
function setting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return value === undefined || value === null ? undefined : String(value);
}


export interface SweepReport {
  symbol: string;
  token: string | null;
  /** Base units held before the sweep, or null when the read failed. */
  balance: string | null;
  /** Base units actually moved, or null when nothing moved. */
  swept: string | null;
  note: string;
}

export interface YieldReport {
  symbol: string;
  asset: string;
  /** Base units held, or null when the read failed. */
  balance: string | null;
  supplied: string | null;
  note: string;
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
    // One writer per ledger file. Fails loudly if another process holds it.
    await this.ledger.acquire();
    this.executor = new Executor(
      this.client,
      this.ledger,
      new PolicyEngine(this.treasuryCfg, this.ledger),
      this.treasuryCfg,
    );
  }

  override async stop(): Promise<void> {
    // The client is stateless and the ledger is written append-only per call,
    // so there is no buffered state to lose — only the write lock to hand back.
    await this.ledger?.release();
  }

  get treasuryConfig(): BursarConfig {
    return this.treasuryCfg;
  }

  /** Chain payouts leave on, and whether it gets MEV-protected submission. */
  payoutRouting(): { chainId: number; privateMempool: boolean } {
    return {
      chainId: this.executor.payoutChain(),
      privateMempool: this.executor.payoutChainIsPrivate(),
    };
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
   * Keep the operating wallet funded.
   *
   * The decision lives on KeeperHub, not here. The keeper reads the balance,
   * compares it to the floor and tops up on a schedule, so it keeps working
   * while the agent is down — which is the only time running out of gas
   * actually matters.
   *
   * The top-up is `target - min`, fixed when the workflow is authored rather
   * than derived from the reading, so a run cannot chase its own effect.
   */
  async checkFloat(): Promise<FloatReport[]> {
    const reports: FloatReport[] = [];

    for (const float of this.treasuryCfg.float) {
      const workflow = gasFloatWorkflow(float);
      const workflowId = await this.ensureWorkflow(workflow.name, workflow);

      // Run it now too, so "am I low on gas?" gets an answer rather than a
      // promise about the next hour.
      const run = await this.client.executeWorkflow(
        workflowId,
        {},
        `float-${workflowId}-${Date.now()}`,
      );
      const final = await this.client.awaitExecution(run.executionId);
      const toppedUp = final.transactionHashes.length > 0;
      const floorLabel = formatUnits(BigInt(float.minBalance), NATIVE_DECIMALS);

      reports.push({
        chainId: float.chainId,
        address: float.address,
        balance: null,
        topUp: toppedUp
          ? formatUnits(BigInt(float.targetBalance) - BigInt(float.minBalance), NATIVE_DECIMALS)
          : null,
        note: toppedUp
          ? `keeper installed and topped up — ${final.transactionLinks[0] ?? final.transactionHashes[0]}`
          : final.status === "success"
            ? `keeper installed, running hourly; balance is above the ${floorLabel} floor`
            : `keeper ran but finished as ${final.status}`,
      });
    }

    return reports;
  }


  /**
   * Author the workflow if absent, update it if present. Never duplicates.
   *
   * The idempotency key carries a hash of the definition, not just its name.
   * A stable key would be indistinguishable from a replay, so an edited
   * workflow could be answered from the original write and never actually
   * applied — the failure mode being a keeper that silently keeps running the
   * old logic.
   */
  private async ensureWorkflow(name: string, workflow: unknown): Promise<string> {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(workflow))
      .digest("hex")
      .slice(0, 16);

    const existing = await this.client.listWorkflows();
    const rows = (Array.isArray(existing) ? existing : []) as Array<{ id: string; name: string }>;
    const found = rows.find((r) => r.name === name);

    if (found) {
      await this.client.updateWorkflow(found.id, workflow, `wf-${found.id}-${fingerprint}`);
      return found.id;
    }
    const created = await this.client.createWorkflow(workflow, `wf-${fingerprint}`);
    return String((created as { id?: string })?.id ?? "");
  }

  /**
   * Consolidate earnings into the treasury.
   *
   * Balances are read through KeeperHub — native via the check-balance node,
   * tokens via a contract read, since check-balance is native-only. The amount
   * moved is capped by policy rather than clipped to it silently: sweeping the
   * whole balance would routinely exceed the per-transfer ceiling and be
   * refused, so we move as much as the ceiling allows and say what is left.
   */
  async sweep(period = dailyPeriod()): Promise<SweepReport[]> {
    const sweepConfig = this.treasuryCfg.sweep;
    if (!sweepConfig) return [];

    const destination = sweepConfig.destination ?? this.treasuryCfg.treasury.address;
    if (!destination) {
      return [
        {
          symbol: "-",
          token: null,
          balance: null,
          swept: null,
          note: "no sweep destination and no treasury address configured",
        },
      ];
    }

    const holder = this.treasuryCfg.treasury.address ?? destination;

    // Sweeping to yourself moves nothing, but it still burns gas and consumes
    // the daily cap — so it is not harmless, it is a slow leak that also eats
    // the budget a real payout needs.
    if (holder.toLowerCase() === destination.toLowerCase()) {
      return [
        {
          symbol: "-",
          token: null,
          balance: null,
          swept: null,
          note:
            `sweep destination ${destination} is the treasury's own wallet, so there is ` +
            `nothing to consolidate. Set sweep.destination to a different address.`,
        },
      ];
    }

    const reports: SweepReport[] = [];

    for (const asset of sweepConfig.assets) {
      const balance = await this.readBalance(sweepConfig.chainId, asset.token, holder, asset.symbol);
      if (balance === null) {
        reports.push({
          symbol: asset.symbol,
          token: asset.token,
          balance: null,
          swept: null,
          note: "balance could not be read",
        });
        continue;
      }

      const floor = BigInt(asset.minAmount);
      // Native: leave the floor behind as gas. Tokens: the floor is only a
      // dust threshold, so the whole balance is fair game once it is cleared.
      const available = asset.token === null ? balance - floor : balance;

      if (balance < floor || available <= 0n) {
        reports.push({
          symbol: asset.symbol,
          token: asset.token,
          balance: balance.toString(),
          swept: null,
          note: `below the ${formatUnits(floor, asset.decimals)} ${asset.symbol} threshold`,
        });
        continue;
      }

      const ceiling =
        asset.token === null
          ? BigInt(this.treasuryCfg.policy.maxPerTransfer)
          : BigInt(assetPolicyFor(this.treasuryCfg.policy, asset.token)?.maxPerTransfer ?? "0");

      if (ceiling <= 0n) {
        reports.push({
          symbol: asset.symbol,
          token: asset.token,
          balance: balance.toString(),
          swept: null,
          note: `no policy.assets entry for ${asset.symbol}; refusing to move it`,
        });
        continue;
      }

      const amount = available < ceiling ? available : ceiling;
      const outcome = await this.executor.move(
        {
          leg: "sweep",
          chainId: sweepConfig.chainId,
          to: destination,
          amount: amount.toString(),
          token: asset.token,
          decimals: asset.decimals,
          memo: `sweep ${asset.symbol} to treasury`,
        },
        period,
      );

      const remaining = available - amount;
      reports.push({
        symbol: asset.symbol,
        token: asset.token,
        balance: balance.toString(),
        swept: outcome.result === "confirmed" ? amount.toString() : null,
        note:
          outcome.result === "confirmed"
            ? `swept ${formatUnits(amount, asset.decimals)} ${asset.symbol}` +
              (remaining > 0n
                ? `, ${formatUnits(remaining, asset.decimals)} left by the per-transfer cap`
                : "") +
              ` — ${outcome.entry.transactionLinks?.[0] ?? outcome.transactionHashes[0] ?? ""}`
            : outcome.result === "blocked"
              ? `blocked: ${outcome.reason}`
              : outcome.result === "skipped"
                ? "already swept this period"
                : `failed: ${outcome.error}`,
      });
    }

    return reports;
  }

  /**
   * Put surplus to work in Aave.
   *
   * Yield is the last claim on the money: the buffer stays liquid, and only
   * what exceeds it is supplied. The supply runs through the executor like any
   * other movement, so the pool has to be on the allowlist and the amount has
   * to clear the asset's caps — depositing into a lending pool is still value
   * leaving the treasury.
   */
  async deployYield(period = dailyPeriod()): Promise<YieldReport | null> {
    const cfg = this.treasuryCfg.yield;
    if (!cfg?.enabled) return null;

    const holder = this.treasuryCfg.treasury.address;
    if (!holder) {
      return { symbol: "-", asset: "", balance: null, supplied: null, note: "no treasury address" };
    }

    const assetPolicy = assetPolicyFor(this.treasuryCfg.policy, cfg.asset);
    if (!assetPolicy) {
      return {
        symbol: "-",
        asset: cfg.asset,
        balance: null,
        supplied: null,
        note: `no policy.assets entry for ${cfg.asset}; refusing to supply it`,
      };
    }

    const balance = await this.readBalance(cfg.chainId, cfg.asset, holder, assetPolicy.symbol);
    if (balance === null) {
      return {
        symbol: assetPolicy.symbol,
        asset: cfg.asset,
        balance: null,
        supplied: null,
        note: "balance could not be read",
      };
    }

    const buffer = BigInt(cfg.buffer);
    const surplus = balance - buffer;
    if (surplus <= 0n) {
      return {
        symbol: assetPolicy.symbol,
        asset: cfg.asset,
        balance: balance.toString(),
        supplied: null,
        note: `no surplus above the ${formatUnits(buffer, assetPolicy.decimals)} buffer`,
      };
    }

    const ceiling = BigInt(assetPolicy.maxPerTransfer);
    const amount = surplus < ceiling ? surplus : ceiling;

    // The pool must be able to pull the tokens before it can be supplied to.
    // Approve is authority, not a transfer, so it is not a ledger movement —
    // but it is scoped to exactly the amount about to be supplied rather than
    // an unlimited allowance.
    const pool = await this.aavePoolAddress(cfg.chainId);
    await this.client.contractCall(
      {
        chainId: String(cfg.chainId),
        contractAddress: cfg.asset,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        functionArgs: JSON.stringify([pool, amount.toString()]),
      },
      `approve-${cfg.asset}-${amount}-${period}`,
    );

    const workflow = aaveSupplyWorkflow(
      cfg.chainId,
      cfg.asset,
      amount.toString(),
      holder,
      assetPolicy.symbol,
    );
    const workflowId = await this.ensureWorkflow(workflow.name, workflow);

    const outcome = await this.executor.move(
      {
        leg: "yield",
        chainId: cfg.chainId,
        to: pool,
        amount: amount.toString(),
        token: cfg.asset,
        decimals: assetPolicy.decimals,
        memo: `supply ${assetPolicy.symbol} to Aave v3`,
      },
      period,
      undefined,
      (idempotencyKey) => this.client.executeWorkflow(workflowId, {}, idempotencyKey),
    );

    return {
      symbol: assetPolicy.symbol,
      asset: cfg.asset,
      balance: balance.toString(),
      supplied: outcome.result === "confirmed" ? amount.toString() : null,
      note:
        outcome.result === "confirmed"
          ? `supplied ${formatUnits(amount, assetPolicy.decimals)} ${assetPolicy.symbol} — ` +
            `${outcome.entry.transactionLinks?.[0] ?? outcome.transactionHashes[0] ?? ""}`
          : outcome.result === "blocked"
            ? `blocked: ${outcome.reason}`
            : outcome.result === "skipped"
              ? "already supplied this period"
              : `failed: ${outcome.error}`,
    };
  }

  /** The Aave v3 Pool, read from the protocol's own address provider. */
  private async aavePoolAddress(chainId: number): Promise<string> {
    const configured = this.treasuryCfg.yield?.poolAddress;
    if (configured) return configured;
    throw new Error(
      `No Aave pool address configured for chain ${chainId}. Set yield.poolAddress.`,
    );
  }

  /** Balance in base units, read through KeeperHub. */
  private async readBalance(
    chainId: number,
    token: string | null,
    holder: string,
    symbol: string,
  ): Promise<bigint | null> {
    if (token === null) {
      const workflow = nativeBalanceWorkflow(chainId, holder);
      const id = await this.ensureWorkflow(workflow.name, workflow);
      const run = await this.client.executeWorkflow(id, {}, `bal-${id}-${Date.now()}`);
      const final = await this.client.awaitExecution(run.executionId);
      const reading = readBalanceOutput(final.output);
      return reading ? BigInt(reading.balanceWei) : null;
    }

    const workflow = erc20BalanceWorkflow(chainId, token, holder, symbol);
    const id = await this.ensureWorkflow(workflow.name, workflow);
    const run = await this.client.executeWorkflow(id, {}, `bal-${id}-${Date.now()}`);
    const final = await this.client.awaitExecution(run.executionId);
    return readErc20Output(final.output);
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
