/**
 * Agent-authored workflows.
 *
 * The gas float is the one leg that does not belong in our process. An agent
 * that has crashed cannot notice it has run out of gas, and a treasury that
 * only tops up while the agent is healthy protects nothing. So the float lives
 * on KeeperHub's schedule instead: it keeps running when the agent does not.
 *
 * This composes the workflow JSON; KeeperHub stores, schedules, and executes
 * it. Node shapes here mirror workflows read back from the live API rather
 * than the documented examples, which differ in places.
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
export function gasFloatWorkflow(
  float: FloatTarget & { address: string },
  cron = "0 * * * *",
): WorkflowDefinition {
  const network = String(float.chainId);
  const floorLabel = formatUnits(BigInt(float.minBalance), NATIVE_DECIMALS);
  const topUp = (BigInt(float.targetBalance) - BigInt(float.minBalance)).toString();
  const topUpLabel = formatUnits(BigInt(topUp), NATIVE_DECIMALS);

  const balanceLabel = "Read Operating Balance";

  return {
    name: `Bursar Gas Float — chain ${float.chainId}`,
    description:
      `Keep the agent's operating wallet above ${floorLabel} native on chain ${float.chainId}. ` +
      `When it dips below, send ${topUpLabel} from the treasury so the agent does not stall ` +
      `mid-task. Authored by plugin-bursar.`,

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
          label: balanceLabel,
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
      {
        id: "step-2",
        type: "action",
        data: {
          type: "action",
          label: "Below Floor?",
          config: {
            actionType: "Condition",
            condition: `{{@step-1:${balanceLabel}.balance.balance}} < ${float.minBalance}`,
            group: {
              id: "group-1",
              logic: "AND",
              rules: [
                {
                  id: "rule-1",
                  operator: "<",
                  leftOperand: `{{@step-1:${balanceLabel}.balance.balance}}`,
                  rightOperand: float.minBalance,
                },
              ],
            },
          },
          status: "idle",
          description: `Gate: only top up when below ${floorLabel}`,
        },
        position: { x: 504, y: 116 },
      },
      {
        id: "step-3",
        type: "action",
        data: {
          type: "action",
          label: "Top Up Gas",
          config: {
            actionType: WEB3.transferFunds,
            network,
            // `recipientAddress`, matching the direct-execution API — not
            // `recipient`, which the validator rejects as an unknown field.
            recipientAddress: float.address,
            // Decimal string, matching the direct-execution API's convention.
            amount: topUpLabel,
          },
          status: "idle",
          description: `Send ${topUpLabel} from the treasury to the operating wallet`,
        },
        position: { x: 756, y: 116 },
      },
    ],

    edges: [
      { id: "e1", source: "trigger-1", target: "step-1" },
      { id: "e2", source: "step-1", target: "step-2" },
      { id: "e3", source: "step-2", target: "step-3" },
    ],
  };
}
