/**
 * Aave v3, read as well as written.
 *
 * ## Why this file exists
 *
 * Bursar could already supply surplus to Aave. That is a push: we decide, Aave
 * receives. It says nothing about whether supplying was a good idea, whether the
 * position is actually earning, or whether the money can come back when the
 * treasury needs it — and a treasury that can only put money somewhere has not
 * integrated with a protocol, it has sent it away.
 *
 * So this reads Aave's own contract state through KeeperHub and lets that state
 * decide:
 *
 *   - `get-user-reserve-data` gives the live supply rate, so surplus is only
 *     deployed when Aave is actually paying enough to be worth the gas.
 *   - The same call gives `currentATokenBalance`, which is principal *plus*
 *     accrued interest. Comparing it against what we supplied is the only
 *     honest proof the position earned anything.
 *   - `get-user-account-data` gives the health factor, which governs whether
 *     the position is safe to leave alone.
 *   - `withdraw` closes the loop: when the operating wallet runs dry, the
 *     treasury pulls its own money back out of Aave rather than stalling.
 *
 * The result is a round trip driven by the protocol's real numbers, not a
 * one-way transfer into an address we hope is a lending pool.
 *
 * ## Units
 *
 * Aave speaks in three different fixed-point scales and mixing them up is the
 * expensive kind of mistake, so each is converted at the edge and never carried
 * around raw:
 *
 *   - rates are **ray**, 27 decimals
 *   - the health factor is **wad**, 18 decimals
 *   - base-currency amounts are 8 decimals (USD, on every v3 market)
 */

import type { WorkflowDefinition } from "../treasury/workflows.js";

/** Aave's fixed-point scales. */
const RAY = 10n ** 27n;
const WAD = 10n ** 18n;

/**
 * Health factor returned when an account has no debt.
 *
 * Aave hands back `type(uint256).max` rather than a sentinel, so anything near
 * it means "nothing borrowed" rather than "extraordinarily healthy". Treating
 * that as a number would put absurd values in the ledger and in front of a
 * person deciding whether to act.
 */
const NO_DEBT_THRESHOLD = 10n ** 30n;

/** Overall account state, as Aave reports it. */
export interface AaveAccountData {
  /** 8-decimal USD. */
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  /** Basis points. */
  currentLiquidationThreshold: bigint;
  ltv: bigint;
  /**
   * Health factor in wad, or null when there is no debt.
   *
   * Null is deliberate: "no debt" is a different fact from "a very large
   * number", and only one of them can be compared against a threshold.
   */
  healthFactorWad: bigint | null;
}

/** One asset's position, as Aave reports it. */
export interface AaveReserveData {
  /** Supplied balance including accrued interest — the number that grows. */
  currentATokenBalance: bigint;
  currentVariableDebtTokenBalance: bigint;
  /** Supply rate in ray. */
  liquidityRateRay: bigint;
  usageAsCollateralEnabled: boolean;
}

/**
 * Aave's supply rate as basis points.
 *
 * Ray is 27 decimals and a basis point is 1/10000, so the conversion is a
 * division by 1e23. Done in integers and rounded down: a yield gate that
 * rounds up would deploy into a rate that does not clear it.
 */
export function rayToBps(ray: bigint): bigint {
  return ray / (RAY / 10_000n);
}

/** Render a ray rate as a percentage, for humans. */
export function formatApy(ray: bigint): string {
  const bps = rayToBps(ray);
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

/** Render a wad health factor, or say plainly that there is no debt. */
export function formatHealthFactor(wad: bigint | null): string {
  if (wad === null) return "no debt";
  return (Number((wad * 100n) / WAD) / 100).toFixed(2);
}

/**
 * Unwrap a node's output.
 *
 * The Aave read nodes nest their fields under `result` alongside `success` and
 * `addressLink`, while other nodes return fields at the top level. Confirmed by
 * execution, not assumed — so both shapes are accepted and neither parser
 * cares which surface it was handed.
 */
function unwrap(output: unknown): Record<string, unknown> | null {
  const o = output as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const inner = o.result;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return o;
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
    // Some readings arrive as decimal strings; take the integer part rather
    // than throwing away the whole reading.
    if (/^\d+\.\d+$/.test(trimmed)) return BigInt(trimmed.split(".")[0]!);
  }
  return null;
}

/**
 * Parse `aave-v3/get-user-account-data`.
 *
 * Returns null rather than a partial reading. Every caller here is deciding
 * whether to move money, and a half-read position is worse than no reading,
 * because it looks like an answer.
 */
export function readAccountData(output: unknown): AaveAccountData | null {
  const o = unwrap(output);
  if (!o) return null;

  const collateral = toBigInt(o.totalCollateralBase);
  const debt = toBigInt(o.totalDebtBase);
  if (collateral === null || debt === null) return null;

  const hf = toBigInt(o.healthFactor);

  return {
    totalCollateralBase: collateral,
    totalDebtBase: debt,
    availableBorrowsBase: toBigInt(o.availableBorrowsBase) ?? 0n,
    currentLiquidationThreshold: toBigInt(o.currentLiquidationThreshold) ?? 0n,
    ltv: toBigInt(o.ltv) ?? 0n,
    healthFactorWad: hf === null || hf >= NO_DEBT_THRESHOLD ? null : hf,
  };
}

/** Parse `aave-v3/get-user-reserve-data`. */
export function readReserveData(output: unknown): AaveReserveData | null {
  const o = unwrap(output);
  if (!o) return null;

  const supplied = toBigInt(o.currentATokenBalance);
  if (supplied === null) return null;

  const collateralFlag = o.usageAsCollateralEnabled;

  return {
    currentATokenBalance: supplied,
    currentVariableDebtTokenBalance: toBigInt(o.currentVariableDebtTokenBalance) ?? 0n,
    liquidityRateRay: toBigInt(o.liquidityRate) ?? 0n,
    usageAsCollateralEnabled: collateralFlag === true || collateralFlag === "true",
  };
}

/**
 * Should surplus go into Aave right now?
 *
 * The gate is the protocol's live supply rate. Supplying into a rate that has
 * collapsed costs gas to earn nothing, and the rate is knowable before we
 * spend the gas — so we read it and decline.
 *
 * Returns the reason either way, because a treasury that silently does nothing
 * is indistinguishable from one that is broken.
 */
export interface YieldDecision {
  deploy: boolean;
  reason: string;
  apyBps: bigint;
}

export function shouldDeploy(
  reserve: AaveReserveData | null,
  minApyBps: bigint,
): YieldDecision {
  if (!reserve) {
    // Fail closed. Not knowing the rate is not the same as the rate being fine.
    return { deploy: false, reason: "Aave's reserve data could not be read", apyBps: 0n };
  }

  const apyBps = rayToBps(reserve.liquidityRateRay);
  if (apyBps < minApyBps) {
    return {
      deploy: false,
      reason:
        `Aave is paying ${formatApy(reserve.liquidityRateRay)} on this reserve, ` +
        `below the ${(Number(minApyBps) / 100).toFixed(2)}% floor`,
      apyBps,
    };
  }

  return {
    deploy: true,
    reason: `Aave is paying ${formatApy(reserve.liquidityRateRay)}`,
    apyBps,
  };
}

/**
 * Interest earned on a position.
 *
 * `currentATokenBalance` accrues continuously, so the difference against what
 * was supplied is the yield — the one number that proves the integration did
 * something rather than just moved money out of reach.
 *
 * Never returns a negative: aToken balances do not shrink on their own, so a
 * negative here means the principal figure is wrong (a partial withdrawal not
 * accounted for, most likely), and reporting a negative yield would be
 * inventing a loss that did not happen.
 */
export function accruedInterest(reserve: AaveReserveData, suppliedPrincipal: bigint): bigint {
  const delta = reserve.currentATokenBalance - suppliedPrincipal;
  return delta > 0n ? delta : 0n;
}

// --- workflows -------------------------------------------------------------

function manualTrigger() {
  return {
    id: "trigger-1",
    type: "trigger" as const,
    data: {
      type: "trigger" as const,
      label: "Manual",
      config: { triggerType: "Manual" },
      status: "idle" as const,
    },
    position: { x: 0, y: 116 },
  };
}

/** Short address tag, so workflows for different holders get different names. */
function tag(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Read overall account health from Aave's own Pool contract. */
export function aaveAccountDataWorkflow(chainId: number, user: string): WorkflowDefinition {
  return {
    name: `Bursar Aave Account ${tag(user)} — chain ${chainId}`,
    description:
      `Read Aave v3 account health for ${user} on chain ${chainId} — collateral, debt, ` +
      `and health factor, straight from the protocol. Authored by plugin-bursar.`,
    nodes: [
      manualTrigger(),
      {
        id: "account-data",
        type: "action",
        data: {
          type: "action",
          label: "Aave Account Data",
          config: {
            actionType: "aave-v3/get-user-account-data",
            network: String(chainId),
            user,
          },
          status: "idle",
        },
        position: { x: 252, y: 116 },
      },
    ],
    edges: [{ id: "e1", source: "trigger-1", target: "account-data" }],
  };
}

/** Read one asset's position: supplied balance, debt, and the live supply rate. */
export function aaveReserveDataWorkflow(
  chainId: number,
  asset: string,
  user: string,
  symbol: string,
): WorkflowDefinition {
  return {
    name: `Bursar Aave ${symbol} Position ${tag(user)} — chain ${chainId}`,
    description:
      `Read the Aave v3 ${symbol} position for ${user} on chain ${chainId} — supplied ` +
      `balance including accrued interest, and the live supply rate. Authored by plugin-bursar.`,
    nodes: [
      manualTrigger(),
      {
        id: "reserve-data",
        type: "action",
        data: {
          type: "action",
          label: "Aave Reserve Data",
          config: {
            actionType: "aave-v3/get-user-reserve-data",
            network: String(chainId),
            asset,
            user,
          },
          status: "idle",
        },
        position: { x: 252, y: 116 },
      },
    ],
    edges: [{ id: "e1", source: "trigger-1", target: "reserve-data" }],
  };
}

/**
 * A keeper that watches Aave and acts without us.
 *
 * Everything else in this file runs because Bursar decided to look. This runs
 * because KeeperHub's scheduler fired, reads Aave's own supply rate, and pulls
 * the position out if the protocol has stopped paying enough to justify leaving
 * capital there.
 *
 * That is the difference between consulting a protocol and being wired to one.
 * The agent can be down, the process can be dead, and the treasury still
 * reacts to Aave — which is the only condition under which reacting matters,
 * because a rate collapse does not wait for the agent to come back up.
 *
 * The withdrawal amount is fixed when the workflow is authored rather than read
 * from the position, for the same reason the gas keeper's top-up is: an amount
 * derived from the number it is about to change lets a run chase its own
 * effect.
 */
export function aaveRateKeeperWorkflow(
  chainId: number,
  asset: string,
  user: string,
  symbol: string,
  minRateRay: bigint,
  withdrawBaseUnits: string,
  cron = "0 * * * *",
): WorkflowDefinition {
  // The read node nests its fields under `result`, so the gate has to reach
  // through it. Confirmed by execution.
  const rateRef = "{{@reserve-data:Aave Reserve Data.result.liquidityRate}}";

  return {
    name: `Bursar Aave Rate Keeper ${symbol} — chain ${chainId}`,
    description:
      `Watch Aave v3's ${symbol} supply rate on chain ${chainId}. If it falls below ` +
      `${formatApy(minRateRay)}, withdraw ${withdrawBaseUnits} base units back to ${user}. ` +
      `Runs on KeeperHub's schedule, so it reacts while the agent is down. ` +
      `Authored by plugin-bursar.`,
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        data: {
          type: "trigger",
          label: "Hourly",
          config: { triggerType: "Schedule", scheduleCron: cron, scheduleTimezone: "UTC" },
          status: "idle",
        },
        position: { x: 0, y: 116 },
      },
      {
        id: "reserve-data",
        type: "action",
        data: {
          type: "action",
          label: "Aave Reserve Data",
          config: {
            actionType: "aave-v3/get-user-reserve-data",
            network: String(chainId),
            asset,
            user,
          },
          status: "idle",
        },
        position: { x: 252, y: 116 },
      },
      {
        id: "gate",
        type: "action",
        data: {
          type: "action",
          label: "Rate Below Floor?",
          // Compared in ray, as integers. Converting to a percentage first
          // would round the comparison at exactly the boundary that decides it.
          config: { actionType: "Condition", condition: `${rateRef} < ${minRateRay}` },
          status: "idle",
        },
        position: { x: 504, y: 116 },
      },
      {
        id: "withdraw",
        type: "action",
        data: {
          type: "action",
          label: "Withdraw from Aave",
          config: {
            actionType: "aave-v3/withdraw",
            network: String(chainId),
            asset,
            amount: withdrawBaseUnits,
            to: user,
          },
          status: "idle",
        },
        position: { x: 756, y: 116 },
      },
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "reserve-data" },
      { id: "e2", source: "reserve-data", target: "gate" },
      // Only the true branch withdraws. A rate that is fine must do nothing.
      { id: "e3", source: "gate", target: "withdraw", sourceHandle: "true" },
    ],
  };
}

/**
 * Pull supplied funds back out of Aave.
 *
 * The leg that makes this a treasury rather than a one-way door. When the
 * operating wallet runs dry, the money that was earning yield comes back and
 * the agent keeps working.
 *
 * `amount` is in the asset's base units, matching `aave-v3/supply`.
 */
export function aaveWithdrawWorkflow(
  chainId: number,
  asset: string,
  amountBaseUnits: string,
  to: string,
  symbol: string,
): WorkflowDefinition {
  return {
    name: `Bursar Aave Withdraw ${symbol} — chain ${chainId}`,
    description:
      `Withdraw ${symbol} from Aave v3 on chain ${chainId} back to ${to}. ` +
      `Authored by plugin-bursar.`,
    nodes: [
      manualTrigger(),
      {
        id: "withdraw",
        type: "action",
        data: {
          type: "action",
          label: "Withdraw from Aave",
          config: {
            actionType: "aave-v3/withdraw",
            network: String(chainId),
            asset,
            amount: amountBaseUnits,
            to,
          },
          status: "idle",
        },
        position: { x: 252, y: 116 },
      },
    ],
    edges: [{ id: "e1", source: "trigger-1", target: "withdraw" }],
  };
}
