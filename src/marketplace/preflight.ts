/**
 * The service Bursar sells.
 *
 * ## Why a treasury needs to earn something
 *
 * Bursar's claim is that agents which handle money need a policy layer between
 * the model and the mempool. The obvious objection is that almost no agent
 * earns anything yet, so there is nothing to govern — the problem is real but
 * scheduled for later.
 *
 * This is the answer to that. Bursar publishes a workflow to KeeperHub's
 * marketplace, priced per call in USDC over x402. Callers pay, the money lands
 * in the treasury, and the treasury splits it through the same policy engine
 * that governs everything else. The revenue being split is revenue that exists.
 *
 * ## What it sells
 *
 * A payout preflight. An agent about to send `amount` asks whether doing so
 * would leave it below the gas it needs to keep operating. The failure is
 * mundane and extremely common: an agent pays out its balance, strands itself
 * with no gas, and stops — after the payment, so the money is gone and the
 * agent cannot act on the consequences. Reading your own balance is easy;
 * remembering to do it before every spend is what nobody does.
 *
 * It is worth a cent because it is a read the caller must not skip and will.
 */

import type { WorkflowDefinition } from "../treasury/workflows.js";
import { WEB3 } from "../treasury/workflows.js";

/** The catalogue slug. Stable for the life of the listing — callers bind to it. */
export const PREFLIGHT_SLUG = "bursar-payout-preflight";

/**
 * Base. KeeperHub settles x402 here, and a listing must name a chain the
 * platform recognises as a payment or data chain — Sepolia is rejected outright.
 */
export const PREFLIGHT_CHAIN_ID = "8453";
export const PREFLIGHT_CHAIN = "base";

/**
 * How a node refers to a value the caller supplied.
 *
 * Caller inputs come through the trigger node, using the same
 * `{{@nodeId:Label.field}}` shape as node-to-node references — the trigger is
 * just another node. This is not documented anywhere; it was settled by
 * publishing three listings that differed only in this reference and calling
 * each one. `{{input.payer}}` and `{{payer}}` both fail with "Unresolved
 * template reference(s)". Only this form resolves.
 *
 * Kept in one constant so there is exactly one place to correct.
 */
export const INPUT_REF = (field: string): string => `{{@trigger-1:Manual.${field}}}`;

/**
 * The caller's side of the contract.
 *
 * Published with the listing, so `search_workflows` shows an agent exactly what
 * to send without reading any prose. Amounts are in wei, as strings: a JSON
 * number cannot hold 18 decimals of ether without losing the low digits, and
 * the low digits are the ones that decide a comparison against a floor.
 */
export const PREFLIGHT_INPUT_SCHEMA = {
  type: "object",
  required: ["payer", "amountWei", "gasReserveWei"],
  properties: {
    payer: {
      type: "string",
      description: "The address that would send the payment — usually the agent's own wallet.",
      pattern: "^0x[a-fA-F0-9]{40}$",
    },
    amountWei: {
      type: "string",
      description: "The payment being considered, in wei. Decimal string, no exponent.",
      pattern: "^[0-9]+$",
    },
    gasReserveWei: {
      type: "string",
      description:
        "Native balance the agent must keep to stay operational, in wei. " +
        "0.002 ETH — roughly a day of routine transactions — is a sensible value " +
        "if you have no figure of your own.",
      pattern: "^[0-9]+$",
    },
  },
} as const;

/**
 * 0.002 ETH. Enough for a day of ordinary transactions on an L2.
 *
 * Offered to callers as a suggestion, not applied as a default: the gate is a
 * platform-evaluated expression referencing `gasReserveWei` directly, so an
 * omitted value leaves an unresolved template reference rather than falling
 * back to anything. The input is required for that reason.
 */
export const DEFAULT_GAS_RESERVE_WEI = "2000000000000000";

/**
 * What the caller gets back.
 *
 * `safe` is the answer; everything else is the evidence for it. A verdict an
 * agent cannot check is a verdict it has to take on trust, and the entire point
 * of this project is not doing that.
 */
export const PREFLIGHT_OUTPUT_MAPPING = {
  safe: "Whether the payment leaves the payer above its gas reserve.",
  balanceWei: "The payer's native balance at the moment of the check, in wei.",
  remainingWei: "What would be left after the payment, in wei.",
  shortfallWei: "How far below the reserve that leaves them. Zero when safe.",
} as const;

/**
 * Compose the preflight workflow.
 *
 * Two nodes and a gate: read the live balance, then branch on whether the
 * remainder clears the reserve. The arithmetic happens in the condition
 * expression on integer wei, never on a decimal string — `0.1 + 0.2` is the
 * classic way to be wrong about money, and a balance check that is wrong at the
 * boundary is worse than no check, because it is trusted.
 */
export function payoutPreflightWorkflow(): WorkflowDefinition {
  const balanceRef = "{{@check-balance:Check Balance.balanceWei}}";
  const amount = INPUT_REF("amountWei");
  const reserve = INPUT_REF("gasReserveWei");

  return {
    // A listed workflow that is not enabled answers every caller with 503.
    enabled: true,
    name: "Bursar Payout Preflight",
    description:
      "Before an agent sends a payment, check the payment will not strand it. " +
      "Reads the payer's live native balance, subtracts the amount about to go out, " +
      "and reports whether what remains clears the gas reserve the agent needs to keep " +
      "operating. Pay $0.01 USDC per call. Published by plugin-bursar.",
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
        id: "check-balance",
        type: "action",
        data: {
          type: "action",
          label: "Check Balance",
          config: {
            actionType: WEB3.checkBalance,
            // The listing targets one chain, declared on the listing itself, so
            // the caller does not choose it and cannot be sent to a chain the
            // price was not quoted for.
            network: PREFLIGHT_CHAIN_ID,
            address: INPUT_REF("payer"),
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
          label: "Survives The Payment?",
          // Integer wei throughout. The subtraction is written into the
          // expression rather than precomputed because the balance is only
          // known at execution time.
          config: {
            actionType: "Condition",
            condition: `${balanceRef} - ${amount} >= ${reserve}`,
          },
          status: "idle",
        },
        position: { x: 504, y: 116 },
      },
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "check-balance" },
      { id: "e2", source: "check-balance", target: "gate" },
    ],
  };
}

/**
 * Read a preflight result, from either side of the wire.
 *
 * Bursar calls its own listing in the demo — the seller consuming the service it
 * sells — so this parser is used by the caller, not the workflow. It is
 * deliberately strict about the shape and returns null rather than guessing,
 * because a preflight that reports "safe" by accident is the one failure mode
 * that matters here.
 */
export interface PreflightVerdict {
  safe: boolean;
  balanceWei: bigint;
  remainingWei: bigint;
  shortfallWei: bigint;
}

export function readPreflight(
  output: unknown,
  amountWei: bigint,
  gasReserveWei: bigint,
): PreflightVerdict | null {
  const o = output as Record<string, unknown> | null;
  const raw = o?.balanceWei ?? (o?.balance as Record<string, unknown> | undefined)?.balanceWei;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;

  const balanceWei = BigInt(raw);
  const remainingWei = balanceWei - amountWei;
  const safe = remainingWei >= gasReserveWei;

  return {
    safe,
    balanceWei,
    remainingWei,
    shortfallWei: safe ? 0n : gasReserveWei - remainingWei,
  };
}
