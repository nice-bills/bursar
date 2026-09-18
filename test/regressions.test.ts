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

describe("the rolling 24h window actually rolls", () => {
  test("a movement older than the window stops counting against the cap", async () => {
    // `append` stamps `at` itself, so before the clock seam existed there was
    // no way to construct an aged ledger — the mechanism by which a daily cap
    // resets was unreachable from the public API and had no test at all.
    await withExecutor(
      { maxPerTransfer: "1000", maxPerDay: "1000", allowlist: [`0x${"9".repeat(40)}`] },
      async ({ executor, ledger }) => {
        const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
        await ledger.append(
          {
            intentId: "spent-yesterday",
            leg: "payout",
            chainId: 11155111,
            to: `0x${"9".repeat(40)}`,
            amount: "1000",
            token: null,
            decimals: 18,
            memo: "yesterday's payout",
            submission: { kind: "transfer" },
            status: "confirmed",
            transactionHashes: [`0x${"1".repeat(64)}`],
          },
          yesterday,
        );

        // Yesterday's spend filled the cap. Today's must still go through.
        const outcome = await executor.move(payout(`0x${"9".repeat(40)}`, "1000"), "today");
        assert.equal(
          outcome.result,
          "confirmed",
          `a 25-hour-old movement must not consume today's budget: ${JSON.stringify(outcome)}`,
        );
      },
    );
  });

  test("a movement inside the window still counts", async () => {
    await withExecutor(
      { maxPerTransfer: "1000", maxPerDay: "1000", allowlist: [`0x${"9".repeat(40)}`] },
      async ({ executor, ledger }) => {
        await ledger.append(
          {
            intentId: "spent-an-hour-ago",
            leg: "payout",
            chainId: 11155111,
            to: `0x${"9".repeat(40)}`,
            amount: "1000",
            token: null,
            decimals: 18,
            memo: "recent payout",
            submission: { kind: "transfer" },
            status: "confirmed",
            transactionHashes: [`0x${"2".repeat(64)}`],
          },
          new Date(Date.now() - 60 * 60 * 1000),
        );

        const outcome = await executor.move(payout(`0x${"9".repeat(40)}`, "1000"), "today");
        assert.equal(outcome.result, "blocked");
      },
    );
  });
});

describe("splitByShares hands the remainder to the largest holder", () => {
  test("even when the largest holder is not first", async () => {
    // The existing fixture puts the largest share at index 0, so an
    // implementation that simply did `allocations[0] += remainder` passed it.
    // Here the largest is last, and the amount does not divide cleanly.
    const { splitByShares } = await import("../src/config.js");
    const holders = [
      { name: "small", address: `0x${"1".repeat(40)}`, shareBps: 2000 },
      { name: "medium", address: `0x${"2".repeat(40)}`, shareBps: 3000 },
      { name: "large", address: `0x${"3".repeat(40)}`, shareBps: 5000 },
    ];

    const split = splitByShares(11n, holders);
    assert.equal(
      split.reduce((sum, a) => sum + a.amount, 0n),
      11n,
      "every wei must be allocated, remainder included",
    );

    const biggest = split.reduce((a, b) => (b.amount > a.amount ? b : a));
    assert.equal(
      biggest.contributor.name,
      "large",
      "the remainder goes to the largest shareholder, not to the first",
    );
  });

  test("allocates every wei even when no one can be paid a whole unit", async () => {
    const { splitByShares } = await import("../src/config.js");
    const split = splitByShares(3n, [
      { name: "a", address: `0x${"1".repeat(40)}`, shareBps: 2500 },
      { name: "b", address: `0x${"2".repeat(40)}`, shareBps: 2500 },
      { name: "c", address: `0x${"3".repeat(40)}`, shareBps: 2500 },
      { name: "d", address: `0x${"4".repeat(40)}`, shareBps: 2500 },
    ]);
    assert.equal(split.reduce((sum, a) => sum + a.amount, 0n), 3n);
  });
});

describe("settlement pays the approved invoice, or nothing", () => {
  const PAYER = `0x${"1".repeat(64)}`;
  const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const PAYEE = `0x${"b".repeat(40)}`;

  const plan = {
    outcome: "pay" as const,
    reason: "within policy",
    amount: "10000",
    asset: ASSET,
    payTo: PAYEE,
    chainId: 84532,
    decimals: 6,
    intentId: "invoice-1",
    priced: "0.01 USDC",
  };

  const challenge = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          maxAmountRequired: "10000",
          asset: ASSET,
          payTo: PAYEE,
          resource: "https://agent.example/entrypoints/check/invoke",
          maxTimeoutSeconds: 60,
          ...over,
        },
      ],
    });

  async function withLedger<T>(fn: (ledger: Ledger) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "bursar-settle-"));
    try {
      return await fn(new Ledger(join(dir, "ledger.jsonl")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("a re-quote with different terms is refused, and nothing is recorded as paid", async () => {
    // The paying wrapper issues its OWN unpaid request and signs whatever 402
    // comes back from that — so the terms policy approved are not automatically
    // the terms that get signed. This is the whole reason the guard exists.
    await withLedger(async (ledger) => {
      const { settle } = await import("../src/lucid/settle.js");

      const hostile: typeof globalThis.fetch = async () =>
        new Response(challenge({ maxAmountRequired: "990000", payTo: `0x${"c".repeat(40)}` }), {
          status: 402,
          headers: { "content-type": "application/json" },
        });

      const result = await settle(
        plan,
        { url: "https://agent.example/entrypoints/check/invoke", input: {} },
        ledger,
        { BURSAR_PAYER_PRIVATE_KEY: PAYER } as never,
        undefined,
        hostile,
      );

      assert.equal(result.paid, false);
      assert.match(result.error ?? "", /changed between approval and payment/);

      const entries = [...(await ledger.latestByIntent()).values()];
      assert.equal(entries.length, 1);
      assert.notEqual(entries[0]?.status, "confirmed", "a refused invoice is never confirmed");
    });
  });

  test("an entrypoint that answers 200 without ever charging is recorded as confirmed", async () => {
    await withLedger(async (ledger) => {
      const { settle } = await import("../src/lucid/settle.js");

      const free: typeof globalThis.fetch = async () =>
        new Response(JSON.stringify({ output: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });

      const result = await settle(
        plan,
        { url: "https://agent.example/entrypoints/check/invoke", input: {} },
        ledger,
        { BURSAR_PAYER_PRIVATE_KEY: PAYER } as never,
        undefined,
        free,
      );

      assert.equal(result.paid, true);
      assert.deepEqual(result.output, { ok: true });

      const entry = [...(await ledger.latestByIntent()).values()][0];
      assert.equal(entry?.status, "confirmed");
    });
  });

  test("a policy re-check at payment time stops the payment and records nothing new", async () => {
    // planPayment reads the caps; settle writes the movement. Anything can
    // happen in between — including another invoice doing the same thing.
    await withLedger(async (ledger) => {
      const { settle } = await import("../src/lucid/settle.js");

      let called = false;
      const never: typeof globalThis.fetch = async () => {
        called = true;
        return new Response("{}", { status: 200 });
      };

      const result = await settle(
        plan,
        { url: "https://agent.example/entrypoints/check/invoke", input: {} },
        ledger,
        { BURSAR_PAYER_PRIVATE_KEY: PAYER } as never,
        { evaluate: async () => ({ verdict: "deny", reason: "daily cap reached" }) },
        never,
      );

      assert.equal(result.paid, false);
      assert.match(result.error ?? "", /daily cap reached/);
      assert.equal(called, false, "nothing may be sent once the re-check refuses");
      assert.equal((await ledger.latestByIntent()).size, 0, "no intent is written either");
    });
  });
});

describe("a tool result is only read as a payment challenge when it is one", () => {
  test("a successful result carrying an accepts array is still read as a challenge", async () => {
    // Gating strictly on isError would have broken the marketplace proof if the
    // server returns its 402 as a successful tool result — which is its choice.
    const { readPaymentChallenge } = await import("../src/keeperhub/mcp.js");
    const challenge = readPaymentChallenge(
      {
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            maxAmountRequired: "10000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x8d9abc5b07917229159886be02e5eed1dc7fbdc9",
          },
        ],
      },
      "",
    );
    assert.ok(challenge, "an accepts array is unmistakably a challenge");
    assert.equal(challenge.maxAmountRequired, "10000");
  });

  test("a successful result that merely contains the number 402 is not a challenge", async () => {
    const { readPaymentChallenge } = await import("../src/keeperhub/mcp.js");
    // The loose "is 402 anywhere in the text" match is what used to fire on a
    // block number. It is only consulted for error results now, so a success
    // body has to be read structurally — and this one has no price and no payee.
    assert.equal(
      readPaymentChallenge({ blockNumber: 402, success: true }, ""),
      null,
      "a block number is not a price",
    );
    assert.equal(
      readPaymentChallenge({ chainId: 402, amountTransferred: "1000" }, ""),
      null,
      "an echoed amount with no payee is not a challenge",
    );
  });
});
