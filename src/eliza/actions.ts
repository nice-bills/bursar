/**
 * Treasury actions.
 *
 * Each action's `validate` is a real gate, not a `return true`. An action that
 * cannot succeed should never be offered to the model — otherwise the agent
 * confidently attempts a payout with no treasury configured and has to explain
 * a failure it could have avoided.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

import { BursarService } from "./service.js";
import { extractAmount } from "./amount.js";
import { formatUnits, NATIVE_DECIMALS } from "../units.js";

function getService(runtime: IAgentRuntime): BursarService | undefined {
  return runtime.getService<BursarService>(BursarService.serviceType) ?? undefined;
}

/** Every treasury action needs a started service; most need an unlocked one. */
async function treasuryReady(runtime: IAgentRuntime): Promise<boolean> {
  return getService(runtime) !== undefined;
}

async function respond(
  callback: HandlerCallback | undefined,
  text: string,
): Promise<void> {
  await callback?.({ text });
}

export const payContributorsAction: Action = {
  name: "PAY_CONTRIBUTORS",
  similes: ["DISTRIBUTE_REVENUE", "SPLIT_EARNINGS", "PAY_OUT", "SETTLE_SHARES"],
  description:
    "Distribute an amount of the agent's revenue to its configured contributors by their " +
    "share percentages, executing each payout onchain through KeeperHub. Use when asked to " +
    "pay out, distribute earnings, or settle revenue shares.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (!(await treasuryReady(runtime))) return false;
    // Refuse to offer a payout when no amount is stated — guessing how much of
    // the treasury to distribute is not a recoverable mistake.
    return extractAmount(message.content?.text ?? "", NATIVE_DECIMALS).ok;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getService(runtime);
    if (!service) {
      return { success: false, error: "Bursar treasury service is not running." };
    }

    const parsed = extractAmount(message.content?.text ?? "", NATIVE_DECIMALS);
    if (!parsed.ok) {
      // Say why. An agent that just declines cannot ask a useful follow-up.
      const text = `I did not distribute anything: ${parsed.reason}.`;
      await respond(callback, text);
      return { success: false, text, error: parsed.reason };
    }
    const amount = parsed.amount;

    const report = await service.payContributors(amount);

    const confirmed = report.outcomes.filter((o) => o.outcome.result === "confirmed");
    const blocked = report.outcomes.filter((o) => o.outcome.result === "blocked");
    const failed = report.outcomes.filter((o) => o.outcome.result === "failed");
    const skipped = report.outcomes.filter((o) => o.outcome.result === "skipped");

    const lines: string[] = [
      `Distributing ${formatUnits(amount, NATIVE_DECIMALS)} across ${report.outcomes.length} contributors:`,
    ];

    for (const o of report.outcomes) {
      const pretty = formatUnits(BigInt(o.amount), NATIVE_DECIMALS);
      if (o.outcome.result === "confirmed") {
        const link =
          o.outcome.entry.transactionLinks?.[0] ?? o.outcome.transactionHashes[0] ?? "";
        lines.push(`  ${o.contributor}: ${pretty} paid — ${link}`);
      } else if (o.outcome.result === "skipped") {
        lines.push(`  ${o.contributor}: ${pretty} already paid this period, skipped`);
      } else if (o.outcome.result === "blocked") {
        lines.push(`  ${o.contributor}: ${pretty} blocked — ${o.outcome.reason}`);
      } else if (o.outcome.result === "held") {
        lines.push(
          `  ${o.contributor}: ${pretty} held for approval — ${o.outcome.reason}\n` +
            `    approve with: ${o.outcome.intentId}`,
        );
      } else {
        lines.push(`  ${o.contributor}: ${pretty} failed — ${o.outcome.error}`);
      }
    }

    if (failed.length > 0) {
      lines.push("Run RECONCILE_TREASURY before attempting further payouts.");
    }
    if (report.outcomes.some((o) => o.outcome.result === "held")) {
      lines.push("Some payouts need a person. Ask me to list pending approvals.");
    }

    const text = lines.join("\n");
    await respond(callback, text);

    return {
      // Partial success is still failure for money: if anyone who should have
      // been paid was not, the caller needs to know without parsing prose.
      // Held is not success: nothing moved, and someone has to decide.
      success:
        failed.length === 0 &&
        blocked.length === 0 &&
        !report.outcomes.some((o) => o.outcome.result === "held"),
      text,
      data: {
        total: report.total,
        confirmed: confirmed.length,
        skipped: skipped.length,
        blocked: blocked.length,
        failed: failed.length,
        transactionHashes: confirmed.flatMap((o) =>
          o.outcome.result === "confirmed" ? o.outcome.transactionHashes : [],
        ),
      },
    };
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "pay out 0.01 to the contributors" } },
      {
        name: "{{agent}}",
        content: {
          text: "Distributing 0.01 across 3 contributors through KeeperHub.",
          actions: ["PAY_CONTRIBUTORS"],
        },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "we earned 0.5 this week, split it" } },
      {
        name: "{{agent}}",
        content: {
          text: "Splitting 0.5 by the configured shares and executing each payout onchain.",
          actions: ["PAY_CONTRIBUTORS"],
        },
      },
    ],
  ],
};

export const reconcileTreasuryAction: Action = {
  name: "RECONCILE_TREASURY",
  similes: ["RECONCILE", "CHECK_PENDING_PAYMENTS", "RESOLVE_TREASURY", "UNLOCK_TREASURY"],
  description:
    "Resolve any treasury movement whose outcome is unknown by replaying it under its " +
    "original idempotency key, so the ledger agrees with the chain. Use when the treasury " +
    "is locked, a payout's status is unclear, or after a crash or restart.",

  validate: treasuryReady,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getService(runtime);
    if (!service) {
      return { success: false, error: "Bursar treasury service is not running." };
    }

    const open = await service.openIntents();
    if (open.length === 0) {
      const text = "Nothing to reconcile — every treasury movement is already resolved.";
      await respond(callback, text);
      return { success: true, text, data: { resolved: 0, stillOpen: 0 } };
    }

    const result = await service.reconcile();
    const text = [
      `Reconciled ${result.resolved} of ${open.length} open movement(s).`,
      ...result.details.map((d) => `  ${d}`),
      result.stillOpen > 0
        ? `${result.stillOpen} still unresolved; the treasury stays locked.`
        : "Treasury is unlocked.",
    ].join("\n");

    await respond(callback, text);
    return {
      success: result.stillOpen === 0,
      text,
      data: { resolved: result.resolved, stillOpen: result.stillOpen },
    };
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "did that payout actually go through?" } },
      {
        name: "{{agent}}",
        content: {
          text: "Checking with KeeperHub by replaying the movement under its original key.",
          actions: ["RECONCILE_TREASURY"],
        },
      },
    ],
  ],
};

export const treasuryReportAction: Action = {
  name: "TREASURY_REPORT",
  similes: ["TREASURY_STATEMENT", "WHERE_DID_THE_MONEY_GO", "SHOW_PAYOUTS", "TREASURY_STATUS"],
  description:
    "Produce a statement of every treasury movement with its transaction hash, plus " +
    "confirmed totals per leg. Use when asked where the money went, for a treasury " +
    "summary, or for proof that a payout happened.",

  validate: treasuryReady,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getService(runtime);
    if (!service) {
      return { success: false, error: "Bursar treasury service is not running." };
    }

    const statement = await service.statement();
    await respond(callback, statement);
    return { success: true, text: statement };
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "where did the money go this month?" } },
      {
        name: "{{agent}}",
        content: {
          text: "Here is the treasury statement, with a transaction hash for every line.",
          actions: ["TREASURY_REPORT"],
        },
      },
    ],
  ],
};

export const checkFloatAction: Action = {
  name: "CHECK_GAS_FLOAT",
  similes: ["TOP_UP_GAS", "CHECK_GAS", "REFILL_GAS", "AM_I_RUNNING_OUT_OF_GAS"],
  description:
    "Install and run the agent's gas keeper on KeeperHub: it reads the operating balance on " +
    "a schedule and tops it up from the treasury when it falls below the floor, so the agent " +
    "stays funded even while it is down. Use when asked about gas, whether the agent can keep " +
    "working, or to refill the operating wallet.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = getService(runtime);
    // Pointless to offer when no float target is configured.
    return service !== undefined && service.treasuryConfig.float.length > 0;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getService(runtime);
    if (!service) {
      return { success: false, error: "Bursar treasury service is not running." };
    }

    const reports = await service.checkFloat();
    // The keeper evaluates the balance on-platform and only reports what it
    // did, so there is no balance to echo unless it acted.
    const lines = reports.map(
      (r) =>
        `  chain ${r.chainId} ${r.address}: ${r.note}` +
        (r.topUp ? ` (${r.topUp} added)` : ""),
    );

    const text = ["Gas keeper:", ...lines].join("\n");
    await respond(callback, text);

    return {
      success: reports.every((r) => !/finished as/.test(r.note)),
      text,
      data: { reports },
    };
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "are you going to run out of gas?" } },
      {
        name: "{{agent}}",
        content: {
          text: "Checking my operating balance through the KeeperHub monitor.",
          actions: ["CHECK_GAS_FLOAT"],
        },
      },
    ],
  ],
};

export const sweepEarningsAction: Action = {
  name: "SWEEP_EARNINGS",
  similes: ["COLLECT_EARNINGS", "CONSOLIDATE_FUNDS", "SWEEP", "COLLECT_REVENUE"],
  description:
    "Consolidate the agent's earnings into the treasury, moving each configured asset that " +
    "is above its dust threshold. Use when asked to collect, sweep, or consolidate earnings.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = getService(runtime);
    return service !== undefined && service.treasuryConfig.sweep !== undefined;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getService(runtime);
    if (!service) {
      return { success: false, error: "Bursar treasury service is not running." };
    }

    const reports = await service.sweep();
    if (reports.length === 0) {
      const text = "No sweep is configured, so there is nothing to collect.";
      await respond(callback, text);
      return { success: true, text };
    }

    const text = [
      "Sweeping earnings into the treasury:",
      ...reports.map((r) => `  ${r.symbol}: ${r.note}`),
    ].join("\n");

    await respond(callback, text);
    return {
      success: reports.every((r) => movementSucceeded(r.note, r.balance)),
      text,
      data: { reports },
    };
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "collect what we've earned" } },
      {
        name: "{{agent}}",
        content: {
          text: "Consolidating earnings into the treasury through KeeperHub.",
          actions: ["SWEEP_EARNINGS"],
        },
      },
    ],
  ],
};

export const deployYieldAction: Action = {
  name: "DEPLOY_SURPLUS",
  similes: ["EARN_YIELD", "SUPPLY_TO_AAVE", "PUT_SURPLUS_TO_WORK", "DEPOSIT_SURPLUS"],
  description:
    "Supply treasury surplus above the configured buffer into Aave v3 to earn yield. Use " +
    "when asked to put idle funds to work, earn yield, or deposit surplus.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = getService(runtime);
    return service !== undefined && service.treasuryConfig.yield?.enabled === true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getService(runtime);
    if (!service) {
      return { success: false, error: "Bursar treasury service is not running." };
    }

    const report = await service.deployYield();
    if (!report) {
      const text = "Yield is not enabled, so there is nothing to deploy.";
      await respond(callback, text);
      return { success: true, text };
    }

    const text = `Surplus deployment — ${report.symbol}: ${report.note}`;
    await respond(callback, text);
    return { success: movementSucceeded(report.note, report.balance), text, data: { report } };
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "put the idle funds to work" } },
      {
        name: "{{agent}}",
        content: {
          text: "Supplying the surplus above our buffer into Aave v3.",
          actions: ["DEPLOY_SURPLUS"],
        },
      },
    ],
  ],
};

/**
 * Approval is a human act, so the agent's job is to surface the decision and
 * carry it out — not to make it. The action reads what is held and, when the
 * message clearly authorises one, releases it.
 */
export const pendingApprovalsAction: Action = {
  name: "REVIEW_PENDING",
  similes: ["PENDING_APPROVALS", "WHAT_NEEDS_APPROVAL", "APPROVE_PAYOUT", "RELEASE_PAYMENT"],
  description:
    "List treasury movements held for human approval, and release one when the operator " +
    "approves it by name or id. Use when asked what is pending, what needs sign-off, or to " +
    "approve or decline a held payment.",

  validate: treasuryReady,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getService(runtime);
    if (!service) {
      return { success: false, error: "Bursar treasury service is not running." };
    }

    const held = await service.pending();
    if (held.length === 0) {
      const text = "Nothing is waiting on approval.";
      await respond(callback, text);
      return { success: true, text, data: { pending: 0 } };
    }

    const said = (message.content?.text ?? "").toLowerCase();
    const approving = /\b(approve|release|authorise|authorize|go ahead|yes)\b/.test(said);
    const declining = /\b(decline|reject|deny|cancel|no)\b/.test(said);

    // Only act on a decision that names its target. "Approve it" with three
    // held payments is not an instruction, it is an ambiguity — and with one
    // held payment it is still not one, because "yes" in an unrelated sentence
    // would release it. The eight characters are the whole point: they prove
    // the decision is about this movement.
    const named = held.find((e) => said.includes(e.intentId.slice(-8).toLowerCase()));

    // "no, do not approve that" matches both verbs. Both matching means the
    // sentence has not decided anything, and approving was winning by order.
    if (approving && declining) {
      const text =
        `That reads as both an approval and a refusal, so I did nothing. ` +
        `Say "approve ${held[0]!.intentId.slice(-8)}" or "decline ${held[0]!.intentId.slice(-8)}".`;
      await respond(callback, text);
      return { success: false, text, error: "ambiguous decision" };
    }

    if ((approving || declining) && named) {
      // An approval is an act with an author. Without a configured approver
      // anyone in the room can release a payment by typing a word, which is not
      // a human-in-the-loop control — it is the absence of one.
      const approver = runtime.getSetting("BURSAR_APPROVER");
      if (!approver) {
        const text =
          `No approver is configured, so I cannot act on that. Set BURSAR_APPROVER to the ` +
          `id of the person allowed to release payments, then ask again.`;
        await respond(callback, text);
        return { success: false, text, error: "no approver configured" };
      }
      if (String(message.entityId ?? "") !== String(approver)) {
        const text =
          `Only the configured approver can release or decline a held movement, and this ` +
          `message is not from them. ${held.length} movement(s) still waiting.`;
        await respond(callback, text);
        return { success: false, text, error: "not the configured approver" };
      }
      return decide(service, named, approving, runtime, callback);
    }

    const lines = [
      `${held.length} movement(s) waiting on approval:`,
      ...held.map(
        (e) =>
          `  ${e.intentId.slice(-8)} · ${formatUnits(BigInt(e.amount), e.decimals)} → ${e.to}\n` +
          `    ${e.memo}\n` +
          `    held because ${e.heldReason ?? "it exceeded the approval threshold"}`,
      ),
      approving || declining
        ? "Name which one, by the eight characters shown."
        : "Approve or decline one by naming those eight characters.",
    ];

    const text = lines.join("\n");
    await respond(callback, text);
    return { success: true, text, data: { pending: held.length } };
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "anything waiting on me?" } },
      {
        name: "{{agent}}",
        content: {
          text: "Two payments are held above the approval threshold.",
          actions: ["REVIEW_PENDING"],
        },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "approve a3f91c22" } },
      {
        name: "{{agent}}",
        content: { text: "Releasing that payment now.", actions: ["REVIEW_PENDING"] },
      },
    ],
  ],
};

/**
 * Whether a movement report describes something that actually happened.
 *
 * `balance !== null` only says the balance was readable. A sweep the policy
 * engine blocked, or one held for a person, has a perfectly readable balance
 * and moved nothing — reporting that as success tells the model its instruction
 * was carried out.
 */
function movementSucceeded(note: string, balance: string | null): boolean {
  if (balance === null) return false;
  return !/^(blocked|held|failed)\b/.test(note);
}

async function decide(
  service: BursarService,
  entry: { intentId: string; amount: string; decimals: number; to: string },
  approving: boolean,
  runtime: IAgentRuntime,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const who = String(runtime.getSetting("BURSAR_APPROVER") ?? "operator");
  const pretty = formatUnits(BigInt(entry.amount), entry.decimals);

  if (!approving) {
    const declined = await service.decline(entry.intentId, who);
    const text = declined
      ? `Declined ${pretty} to ${entry.to}. Nothing was sent.`
      : `${entry.intentId.slice(-8)} was already decided, so I left it alone.`;
    await respond(callback, text);
    return { success: declined, text, data: { declined: entry.intentId } };
  }

  const outcome = await service.approve(entry.intentId, who);
  const text =
    outcome.result === "confirmed"
      ? `Approved and sent ${pretty} to ${entry.to} — ` +
        `${outcome.entry.transactionLinks?.[0] ?? outcome.transactionHashes[0] ?? ""}`
      : outcome.result === "blocked"
        ? `Approved, but it still could not go: ${outcome.reason}`
        : `Approved, but the result was ${outcome.result}.`;

  await respond(callback, text);
  return { success: outcome.result === "confirmed", text, data: { approved: entry.intentId } };
}

export const treasuryActions: Action[] = [
  pendingApprovalsAction,
  deployYieldAction,
  sweepEarningsAction,
  payContributorsAction,
  checkFloatAction,
  reconcileTreasuryAction,
  treasuryReportAction,
];
