/**
 * Agent-authored workflows.
 *
 * Bursar composes these; KeeperHub stores, schedules, and executes them.
 *
 * ## The float is a self-contained keeper
 *
 * It reads the operating balance, compares it to a floor, and tops up — all on
 * KeeperHub's schedule, so it keeps working when the agent is down. That is the
 * whole point: an agent that has crashed cannot notice it has run out of gas.
 *
 * Node shapes here follow `list_action_schemas` on KeeperHub's MCP server,
 * which gives each action type's required fields, output fields, and a worked
 * templating example. Worth consulting before hand-rolling a node: a Condition
 * node, for instance, takes a `condition` expression and an optional
 * `conditionConfig`, and a top-level `group` key passes validation while
 * leaving the template reference unresolved at execution.
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
  checkTokenBalance: "web3/check-token-balance",
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
  /** Condition nodes expose "true" and "false" handles for if/else branching. */
  sourceHandle?: string;
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
/**
 * The gas keeper: read, compare, top up — entirely on KeeperHub's schedule.
 *
 * The top-up is `target - min`, fixed when the workflow is authored rather than
 * derived from the reading. The amount must not depend on the balance it is
 * about to change, or a run reacts to its own effect.
 */
export function gasFloatWorkflow(
  float: FloatTarget & { address: string },
  cron = "0 * * * *",
): WorkflowDefinition {
  const network = String(float.chainId);
  const floorLabel = formatUnits(BigInt(float.minBalance), NATIVE_DECIMALS);
  const topUp = (BigInt(float.targetBalance) - BigInt(float.minBalance)).toString();
  const topUpLabel = formatUnits(BigInt(topUp), NATIVE_DECIMALS);
  const balanceRef = "{{@check-balance:Check Balance.balanceWei}}";

  return {
    name: `Bursar Gas Keeper — chain ${float.chainId}`,
    description:
      `Keep ${float.address} above ${floorLabel} native on chain ${float.chainId}, topping ` +
      `up by ${topUpLabel} when it dips below. Runs on KeeperHub's schedule, so it survives ` +
      `the agent being down. Authored by plugin-bursar.`,
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
        id: "check-balance",
        type: "action",
        data: {
          type: "action",
          label: "Check Balance",
          config: { actionType: WEB3.checkBalance, network, address: float.address },
          status: "idle",
        },
        position: { x: 252, y: 116 },
      },
      {
        id: "gate",
        type: "action",
        data: {
          type: "action",
          label: "Below Floor?",
          // Compared on balanceWei so the gate is exact integer arithmetic.
          config: { actionType: "Condition", condition: `${balanceRef} < ${float.minBalance}` },
          status: "idle",
        },
        position: { x: 504, y: 116 },
      },
      {
        id: "top-up",
        type: "action",
        data: {
          type: "action",
          label: "Top Up Gas",
          config: {
            actionType: WEB3.transferFunds,
            network,
            recipientAddress: float.address,
            amount: topUpLabel,
          },
          status: "idle",
        },
        position: { x: 756, y: 116 },
      },
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "check-balance" },
      { id: "e2", source: "check-balance", target: "gate" },
      // Only the true branch tops up.
      { id: "e3", source: "gate", target: "top-up", sourceHandle: "true" },
    ],
  };
}

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

/**
 * Read an ERC-20 balance.
 *
 * `web3/check-token-balance` is the node for this. An earlier version used a
 * raw `web3/read-contract` balanceOf because probing had not turned this up —
 * `list_action_schemas` lists it plainly.
 */
export function erc20BalanceWorkflow(
  chainId: number,
  token: string,
  holder: string,
  symbol: string,
): WorkflowDefinition {
  return {
    name: `Bursar ${symbol} Balance ${tag(holder)} — chain ${chainId}`,
    description: `Read the ${symbol} balance of ${holder} on chain ${chainId}. Authored by plugin-bursar.`,
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        data: { type: "trigger", label: "Manual", config: { triggerType: "Manual" }, status: "idle" },
        position: { x: 0, y: 116 },
      },
      {
        id: "check-token-balance",
        type: "action",
        data: {
          type: "action",
          label: "Check Token Balance",
          config: {
            actionType: WEB3.checkTokenBalance,
            network: String(chainId),
            address: holder,
            // The node selects the token through a JSON config rather than a
            // bare address field.
            tokenConfig: JSON.stringify({
              mode: "custom",
              customToken: { address: token, symbol },
            }),
          },
          status: "idle",
        },
        position: { x: 252, y: 116 },
      },
    ],
    edges: [{ id: "e1", source: "trigger-1", target: "check-token-balance" }],
  };
}

/** Output of `web3/check-token-balance`: balance.balanceRaw holds base units. */
export function readErc20Output(output: unknown): bigint | null {
  const o = output as { balance?: { balanceRaw?: unknown } } | null;
  const raw = o?.balance?.balanceRaw;
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

/**
 * Supply an asset to Aave v3.
 *
 * Uses KeeperHub's own aave-v3 plugin rather than hand-encoding a Pool call, so
 * the pool address and ABI are the platform's concern rather than ours.
 *
 * Note the unit: this node takes `amount` in base units, while the direct
 * `/execute/transfer` API takes a decimal string. Bursar holds base units
 * internally and converts only where a surface demands it.
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
        data: { type: "trigger", label: "Manual", config: { triggerType: "Manual" }, status: "idle" },
        position: { x: 0, y: 116 },
      },
      {
        id: "supply",
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
        },
        position: { x: 252, y: 116 },
      },
    ],
    edges: [{ id: "e1", source: "trigger-1", target: "supply" }],
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
