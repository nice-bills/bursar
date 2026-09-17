/**
 * Regressions found by review, each pinned by the behaviour it broke.
 *
 * Every test here failed before the fix it guards. They are grouped by what the
 * defect actually cost rather than by module, because that is the thing worth
 * not doing twice.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configSchema } from "../src/config.js";
import { Ledger } from "../src/ledger/store.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { Executor } from "../src/treasury/executor.js";
import { readReserveData, shouldDeploy } from "../src/yield/aave.js";
import { assertChallengeMatchesPlan, SettlementError } from "../src/lucid/settle.js";
import { extractAmount } from "../src/eliza/amount.js";
import { NATIVE_DECIMALS } from "../src/units.js";
import type { ExecutionResult, KeeperHubClient } from "../src/keeperhub/client.js";

const contributors = [
  { name: "a", address: `0x${"1".repeat(40)}`, shareBps: 5000 },
  { name: "b", address: `0x${"2".repeat(40)}`, shareBps: 5000 },
];

interface Recorded {
  kind: "transfer" | "workflow" | "contractCall";
  key: string;
  detail?: string;
}

/** A client that records which API each movement actually reached. */
function recordingClient(): { client: KeeperHubClient; seen: Recorded[] } {
  const seen: Recorded[] = [];
  const ok = (key: string): ExecutionResult => ({
    executionId: `exec-${key.slice(-8)}`,
    status: "completed",
    transactionHashes: [`0x${key.slice(-8)}`],
    transactionLinks: [],
    transactions: [{ hash: `0x${key.slice(-8)}` }],
    idempotentReplay: false,
    output: null,
    raw: {},
  });
  const client = {
    async transfer(params: { recipientAddress: string }, key: string): Promise<ExecutionResult> {
      seen.push({ kind: "transfer", key, detail: params.recipientAddress });
      return ok(key);
    },
    async executeWorkflow(id: string, _input: unknown, key: string): Promise<ExecutionResult> {
      seen.push({ kind: "workflow", key, detail: id });
      return ok(key);
    },
    async contractCall(params: { contractAddress: string }, key: string): Promise<ExecutionResult> {
      seen.push({ kind: "contractCall", key, detail: params.contractAddress });
      return ok(key);
    },
  } as unknown as KeeperHubClient;
  return { client, seen };
}

async function withExecutor<T>(
  policy: Record<string, unknown>,
  fn: (ctx: {
    executor: Executor;
    ledger: Ledger;
    seen: Recorded[];
    policyEngine: PolicyEngine;
  }) => Promise<T>,
  valuation?: ConstructorParameters<typeof PolicyEngine>[3],
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bursar-regress-"));
  try {
    const config = configSchema.parse({
      treasury: { chainId: 11155111 },
      contributors,
      policy,
    });
    const ledger = new Ledger(join(dir, "ledger.jsonl"));
    const { client, seen } = recordingClient();
    const policyEngine = new PolicyEngine(config, ledger, undefined, valuation);
    const executor = new Executor(client, ledger, policyEngine, config);
    return await fn({ executor, ledger, seen, policyEngine });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const payout = (to: string, amount: string, decimals = 18) => ({
  leg: "payout" as const,
  chainId: 11155111,
  to,
  amount,
  token: null,
  decimals,
  memo: "regression",
});

describe("a movement is submitted the way it was recorded", () => {
  test("approving a held workflow movement does not send it as a plain transfer", async () => {
    // Before: approve() re-entered the normal path with no submit callback, so
    // an approved Aave supply went out as a raw ERC-20 transfer TO the pool
    // contract — which mints nothing and cannot be recovered.
    await withExecutor(
      {
        maxPerTransfer: "1000",
        maxPerDay: "10000",
        requireApprovalAbove: "100",
        allowlist: [`0x${"9".repeat(40)}`],
      },
      async ({ executor, seen }) => {
        const held = await executor.move(payout(`0x${"9".repeat(40)}`, "500"), "p1", undefined, {
          kind: "workflow",
          workflowId: "wf-supply",
        });
        assert.equal(held.result, "held");
        if (held.result !== "held") return;

        const approved = await executor.approve(held.intentId, "operator");
        assert.equal(approved.result, "confirmed");

        assert.deepEqual(
          seen.map((s) => s.kind),
          ["workflow"],
          "the approved movement must go back out through its own workflow",
        );
        assert.equal(seen[0]?.detail, "wf-supply");
      },
    );
  });

  test("reconcile replays a workflow movement as a workflow", async () => {
    await withExecutor(
      { maxPerTransfer: "1000", maxPerDay: "10000", allowlist: [`0x${"9".repeat(40)}`] },
      async ({ executor, ledger, seen }) => {
        await ledger.append({
          intentId: "stuck-yield",
          leg: "yield",
          chainId: 11155111,
          to: `0x${"9".repeat(40)}`,
          amount: "500",
          token: `0x${"a".repeat(40)}`,
          decimals: 18,
          memo: "supply to Aave",
          submission: { kind: "workflow", workflowId: "wf-supply" },
          status: "submitted",
        });

        const result = await executor.reconcile();
        assert.equal(result.resolved, 1);
        assert.deepEqual(seen.map((s) => s.kind), ["workflow"]);
      },
    );
  });

  test("reconcile refuses to replay an x402 purchase, and says why", async () => {
    // KeeperHub never saw this intent id, so "replaying" it there is not an
    // idempotent no-op — it is a second, real payment.
    await withExecutor(
      { maxPerTransfer: "1000", maxPerDay: "10000" },
      async ({ executor, ledger, seen }) => {
        await ledger.append({
          intentId: "paid-over-x402",
          leg: "purchase",
          chainId: 84532,
          to: `0x${"7".repeat(40)}`,
          amount: "10000",
          token: `0x${"a".repeat(40)}`,
          decimals: 6,
          memo: "x402 invoice",
          submission: { kind: "x402", url: "https://agent.example/invoke" },
          status: "submitted",
        });

        const result = await executor.reconcile();
        assert.equal(seen.length, 0, "nothing may be re-sent for an x402 purchase");
        assert.equal(result.resolved, 0);
        assert.equal(result.stillOpen, 1);
        assert.match(result.details.join(" "), /x402|cannot be replayed/i);
      },
    );
  });
});

describe("the caps count what actually happened", () => {
  test("an approved movement is not counted against its own daily cap", async () => {
    // Before: `approved` was missing from NOT_SPENT, so approve() summed the
    // movement into movedToday and then added it again — a payout that exactly
    // filled the day's budget could never be approved, and then vanished from
    // the queue entirely.
    await withExecutor(
      {
        maxPerTransfer: "1000",
        maxPerDay: "1000",
        requireApprovalAbove: "500",
        allowlist: [`0x${"9".repeat(40)}`],
      },
      async ({ executor }) => {
        const held = await executor.move(payout(`0x${"9".repeat(40)}`, "1000"), "p1");
        assert.equal(held.result, "held");
        if (held.result !== "held") return;

        const approved = await executor.approve(held.intentId, "operator");
        assert.equal(
          approved.result,
          "confirmed",
          `approving a movement that fits the cap must work, got: ${JSON.stringify(approved)}`,
        );
      },
    );
  });

  test("the USD value reaches the ledger, so the cross-asset ceiling can sum it", async () => {
    // Before: the ledger row was snapshotted before policy priced the movement,
    // so valueUsdCents was always undefined and valueMovedSince returned 0n
    // forever — the daily USD ceiling bounded one movement and never the day.
    const valuation = {
      valueInCents: async () => 60000n,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await withExecutor(
      {
        maxPerTransfer: "1000",
        maxPerDay: "100000",
        maxPerDayUsd: "100000",
        nativePriceFeed: `0x${"f".repeat(40)}`,
        allowlist: [`0x${"9".repeat(40)}`],
      },
      async ({ executor, ledger }) => {
        const outcome = await executor.move(payout(`0x${"9".repeat(40)}`, "100"), "p1");
        assert.equal(outcome.result, "confirmed");

        const moved = await ledger.valueMovedSince(new Date(Date.now() - 60_000));
        assert.equal(moved, 60000n, "the confirmed movement must carry its USD value");
      },
      valuation,
    );
  });
});

describe("a native amount cannot be rescaled past the caps", () => {
  test("a native movement declaring the wrong decimals is refused", async () => {
    // Before: only the token branch checked decimals. A native movement with
    // decimals: 6 read as dust against an 18-decimal cap and was then submitted
    // as formatUnits(amount, 6) — ten ether where the cap saw 1e7 wei.
    await withExecutor(
      { maxPerTransfer: "1000000000000000000", maxPerDay: "1000000000000000000" },
      async ({ policyEngine }) => {
        const decision = await policyEngine.evaluate({
          ...payout(contributors[0]!.address, "10000000", 6),
        });
        assert.equal(decision.verdict, "deny");
        assert.match(decision.reason ?? "", /decimals/);
      },
    );
  });
});

describe("Aave's rate gate fails closed", () => {
  test("a readable position with an unreadable rate does not deploy", () => {
    // Before: liquidityRate defaulted to 0n, and with the shipped minApyBps of
    // 0 the comparison `0n < 0n` is false — so a malformed response deployed.
    const reserve = readReserveData({ result: { currentATokenBalance: "5165120505432263390" } });
    assert.ok(reserve, "the position itself is readable");
    assert.equal(reserve?.liquidityRateRay, undefined);

    for (const floor of [0n, 50n]) {
      const decision = shouldDeploy(reserve, floor);
      assert.equal(decision.deploy, false, `must refuse at a floor of ${floor}`);
      assert.match(decision.reason, /rate could not be read/);
    }
  });

  test("a rate that is present still gates normally", () => {
    const reserve = readReserveData({
      result: { currentATokenBalance: "1000", liquidityRate: "20000000000000000000000000" },
    });
    assert.equal(shouldDeploy(reserve, 50n).deploy, true);
    assert.equal(shouldDeploy(reserve, 500n).deploy, false);
  });
});

describe("x402 pays only the invoice that was approved", () => {
  const plan = {
    outcome: "pay" as const,
    reason: "within policy",
    amount: "10000",
    asset: `0x${"a".repeat(40)}`,
    payTo: `0x${"b".repeat(40)}`,
    chainId: 84532,
    decimals: 6,
    intentId: "intent-1",
  };

  const offer = (over: Record<string, unknown> = {}) => ({
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        maxAmountRequired: "10000",
        asset: `0x${"a".repeat(40)}`,
        payTo: `0x${"b".repeat(40)}`,
        ...over,
      },
    ],
  });

  test("the approved challenge passes", () => {
    assert.doesNotThrow(() => assertChallengeMatchesPlan(offer(), plan));
  });

  for (const [what, over] of [
    ["a raised price", { maxAmountRequired: "990000" }],
    ["a different payee", { payTo: `0x${"c".repeat(40)}` }],
    ["a different asset", { asset: `0x${"d".repeat(40)}` }],
    ["a different chain", { network: "eip155:8453" }],
  ] as const) {
    test(`${what} is refused before anything is signed`, () => {
      assert.throws(() => assertChallengeMatchesPlan(offer(over), plan), SettlementError);
    });
  }

  test("a second offer cannot smuggle different terms past the first", () => {
    // The SDK picks the first offer it has a scheme registered for, which need
    // not be the offer the policy engine read. So every offer must match.
    const body = {
      accepts: [
        offer().accepts[0],
        {
          scheme: "exact",
          network: "eip155:84532",
          maxAmountRequired: "990000",
          asset: `0x${"a".repeat(40)}`,
          payTo: `0x${"c".repeat(40)}`,
        },
      ],
    };
    assert.throws(() => assertChallengeMatchesPlan(body, plan), SettlementError);
  });

  test("an unreadable challenge is refused rather than paid blind", () => {
    assert.throws(() => assertChallengeMatchesPlan(null, plan), SettlementError);
  });
});

describe("amounts an LLM writes", () => {
  const parse = (text: string) => extractAmount(text, NATIVE_DECIMALS);
  const amountOf = (text: string): bigint => {
    const result = parse(text);
    assert.equal(result.ok, true, `expected "${text}" to parse`);
    return result.ok ? result.amount : 0n;
  };

  test("a leading decimal point is one half, not five", () => {
    // Before: the regex required a digit before the dot, so ".5" lost its "0."
    // and moved 5 ether. ".001" moved 1 ether — a 1000x overpayment.
    assert.equal(amountOf("pay out .5"), 500000000000000000n);
    assert.equal(amountOf("send .25"), 250000000000000000n);
    assert.equal(amountOf("distribute .001 to everyone"), 1000000000000000n);
  });

  test("wei is already base units and is not rescaled", () => {
    assert.equal(amountOf("send 3 wei"), 3n);
    assert.equal(amountOf("pay out 5 gwei"), 5000000000n);
  });

  test("digit grouping is refused, not silently truncated", () => {
    const result = parse("pay out 1,000");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /comma|separator/i);
  });

  test("a magnitude suffix is refused", () => {
    const result = parse("pay out 1.5k");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /suffix|full/i);
  });

  test("an amount denominated in another asset is refused", () => {
    const result = parse("pay out 20 USDC");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /USDC.*ETH|written in/i);
  });

  test("a question with a number in it is not a payment instruction", () => {
    // "who are the 3 contributors?" used to parse as three ether, which then
    // made PAY_CONTRIBUTORS a live action on a plain question.
    for (const text of ["who are the 3 contributors?", "we have 2 payouts pending"]) {
      assert.equal(parse(text).ok, false, `"${text}" must not parse as an amount`);
    }
  });

  test("the amounts that must still work, still work", () => {
    assert.equal(amountOf("pay out 0.01"), 10000000000000000n);
    assert.equal(amountOf("0.25"), 250000000000000000n);
    assert.equal(amountOf("transfer 2"), 2000000000000000000n);
    assert.equal(amountOf("distribute 0.01 ETH"), 10000000000000000n);
  });
});
