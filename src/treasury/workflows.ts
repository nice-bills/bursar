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
