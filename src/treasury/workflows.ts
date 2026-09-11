/**
 * Agent-authored workflows.
 *
 * Bursar composes these; KeeperHub stores, schedules, and executes them. Node
 * shapes mirror workflows read back from the live API rather than the
 * documented examples, which differ in places.
 *
 * ## Why the float is split across two systems
 *
 * The intent was a self-contained keeper: read balance, compare to a floor,
 * top up — all on KeeperHub's schedule, so it keeps working when the agent is
 * down. The balance half runs green. The comparison does not: a Condition node
 * cannot read a `web3/check-balance` node's output.
 *
 * Every reference form fails identically, in freshly created workflows:
 *
 *   {{@step-1:Bal.balanceWei}}   {{step-1.balanceWei}}   {{@step-1:Bal.balance}}
 *
 *   "Unresolved template reference(s) ... resolver did not match."
 *
 * The field is real — executing the balance node alone returns
 * `{ address, balance, balanceWei, addressLink, success }` — and the `@form`
 * matches what KeeperHub's own Aave template uses. So core web3 node outputs
 * appear not to be registered with the template resolver.
 *
 * Until that is resolved upstream, the workflow below is the half that works:
 * a scheduled balance reading. `BursarService.checkFloat()` consumes its
 * output and decides in-process, which also means the top-up inherits the
 * policy engine, the ledger, and idempotency — protections a pure workflow
 * would not have had.
 */

import type { FloatTarget } from "../config.js";
import { formatUnits, NATIVE_DECIMALS } from "../units.js";

/**
 * Built-in web3 node action types.
 *
 * Discovered from the platform's own validator, not the docs: the documented
 * `web3.getNativeBalance` / `web3.transferNative` names are rejected as unknown
 * action types. The live names are slash-separated kebab-case, matching the
 * protocol nodes (`aave-v3/get-user-account-data`).
 */
export const WEB3 = {
  checkBalance: "web3/check-balance",
  transferFunds: "web3/transfer-funds",
  readContract: "web3/read-contract",
  writeContract: "web3/write-contract",
} as const;

interface WorkflowNode {
  id: string;
  type: "trigger" | "action";
  data: {
    type: "trigger" | "action";
    label: string;
    config: Record<string, unknown>;
    status: "idle";
    description?: string;
  };
  position: { x: number; y: number };
}

interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * Build the gas-float keeper for one chain.
 *
 * Reads the operating wallet's native balance on a schedule; if it has fallen
 * below the floor, tops it back up to target from the treasury signer.
 *
 * The top-up is `target - min` rather than `target - balance` deliberately: the
 * amount must be fixed at authoring time so the transaction is deterministic.
 * Nothing is inferred at execution, which is the property KeeperHub exists to
 * provide — and it means the same run twice cannot drain the treasury by
 * reacting to its own effect.
 */
export function floatMonitorWorkflow(
  float: FloatTarget & { address: string },
  cron = "0 * * * *",
): WorkflowDefinition {
  const network = String(float.chainId);
  const floorLabel = formatUnits(BigInt(float.minBalance), NATIVE_DECIMALS);

  return {
    name: `Bursar Float Monitor — chain ${float.chainId}`,
    description:
      `Read the agent's operating balance on chain ${float.chainId} every hour. ` +
      `Bursar compares it against the ${floorLabel} floor and tops up when needed. ` +
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
        id: "step-1",
        type: "action",
        data: {
          type: "action",
          label: "Read Operating Balance",
          config: {
            actionType: WEB3.checkBalance,
            network,
            address: float.address,
          },
          status: "idle",
          description: "Native balance of the wallet the agent spends gas from",
        },
        position: { x: 252, y: 116 },
      },
    ],

    edges: [{ id: "e1", source: "trigger-1", target: "step-1" }],
  };
}

/** Short address tag, so workflows for different holders get different names. */
function tag(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Read a native balance on demand.
 *
 * Deliberately separate from the scheduled float monitor. Workflows are
 * upserted by name, so sharing one would mean a sweep's balance read silently
 * rewriting the float keeper's trigger — and it would have to invent threshold
 * values it does not have to satisfy the shape.
 */
export function nativeBalanceWorkflow(chainId: number, holder: string): WorkflowDefinition {
  return {
    name: `Bursar Native Balance ${tag(holder)} — chain ${chainId}`,
    description: `Read the native balance of ${holder} on chain ${chainId}. Authored by plugin-bursar.`,
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        data: { type: "trigger", label: "Manual", config: { triggerType: "Manual" }, status: "idle" },
        position: { x: 0, y: 116 },
      },
      {
        id: "step-1",
        type: "action",
        data: {
          type: "action",
          label: "Read Native Balance",
          config: { actionType: WEB3.checkBalance, network: String(chainId), address: holder },
          status: "idle",
        },
        position: { x: 252, y: 116 },
      },
    ],
    edges: [{ id: "e1", source: "trigger-1", target: "step-1" }],
  };
}

/** Minimal ERC-20 ABI for a balance read, stringified as the API requires. */
const ERC20_BALANCE_ABI = JSON.stringify([
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
]);

/**
 * Read an ERC-20 balance.
 *
 * `web3/check-balance` is native-only — it rejects a `token` field — so token
 * balances go through a contract read instead.
 */
export function erc20BalanceWorkflow(
  chainId: number,
  token: string,
  holder: string,
  symbol: string,
): WorkflowDefinition {
  return {
    name: `Bursar ${symbol} Balance ${tag(holder)} — chain ${chainId}`,
    description:
      `Read the ${symbol} balance of ${holder} on chain ${chainId}. Authored by plugin-bursar.`,
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        data: {
          type: "trigger",
          label: "Manual",
          config: { triggerType: "Manual" },
          status: "idle",
        },
        position: { x: 0, y: 116 },
      },
      {
        id: "step-1",
        type: "action",
        data: {
          type: "action",
          label: "Read Token Balance",
          config: {
            actionType: WEB3.readContract,
            network: String(chainId),
            contractAddress: token,
            abi: ERC20_BALANCE_ABI,
            abiFunction: "balanceOf",
            functionArgs: JSON.stringify([holder]),
          },
          status: "idle",
          description: `balanceOf(${holder})`,
        },
        position: { x: 252, y: 116 },
      },
    ],
    edges: [{ id: "e1", source: "trigger-1", target: "step-1" }],
  };
}

/**
 * Supply an asset to Aave v3.
 *
 * Uses KeeperHub's own aave-v3 plugin rather than hand-encoding a Pool call,
 * so the pool address and ABI are the platform's problem rather than ours.
 *
 * Note the unit: this node takes `amount` in base units, while the direct
 * `/execute/transfer` API takes a decimal string. Same platform, opposite
 * conventions — Bursar holds base units internally and converts only where
 * each surface demands it.
 */
export function aaveSupplyWorkflow(
  chainId: number,
  asset: string,
  amountBaseUnits: string,
  onBehalfOf: string,
  symbol: string,
): WorkflowDefinition {
  return {
    name: `Bursar Aave Supply ${symbol} — chain ${chainId}`,
    description:
      `Supply ${symbol} to Aave v3 on chain ${chainId} on behalf of ${onBehalfOf}. ` +
      `Authored by plugin-bursar.`,
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        data: {
          type: "trigger",
          label: "Manual",
          config: { triggerType: "Manual" },
          status: "idle",
        },
        position: { x: 0, y: 116 },
      },
      {
        id: "step-1",
        type: "action",
        data: {
          type: "action",
          label: "Supply to Aave",
          config: {
            actionType: "aave-v3/supply",
            network: String(chainId),
            asset,
            amount: amountBaseUnits,
            onBehalfOf,
          },
          status: "idle",
          description: `supply ${symbol} to the lending pool`,
        },
        position: { x: 252, y: 116 },
      },
    ],
    edges: [{ id: "e1", source: "trigger-1", target: "step-1" }],
  };
}

/** ERC-20 approve, stringified ABI as the contract-call API requires. */
export const ERC20_APPROVE_ABI = JSON.stringify([
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
]);

/** Output of a `web3/read-contract` balanceOf call, confirmed by execution. */
export function readErc20Output(output: unknown): bigint | null {
  const o = output as { result?: { balance?: unknown } } | null;
  const raw = o?.result?.balance;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/** Output shape of a `web3/check-balance` node, confirmed by execution. */
export interface BalanceReading {
  address: string;
  /** Decimal string, e.g. "0.4999926". */
  balance: string;
  /** Base units — use this for comparisons. */
  balanceWei: string;
  addressLink?: string;
  success: boolean;
}

export function readBalanceOutput(output: unknown): BalanceReading | null {
  const o = output as Record<string, unknown> | null;
  if (!o || typeof o.balanceWei !== "string") return null;
  return {
    address: String(o.address ?? ""),
    balance: String(o.balance ?? ""),
    balanceWei: o.balanceWei,
    addressLink: typeof o.addressLink === "string" ? o.addressLink : undefined,
    success: Boolean(o.success),
  };
}
