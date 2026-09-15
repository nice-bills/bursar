import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ledger, dailyPeriod, type Leg } from "../src/ledger/store.js";
import { readPaymentChallenge } from "../src/keeperhub/mcp.js";
import {
  readPreflight,
  payoutPreflightWorkflow,
  PREFLIGHT_INPUT_SCHEMA,
  DEFAULT_GAS_RESERVE_WEI,
} from "../src/marketplace/preflight.js";

async function scratchLedger(): Promise<{ ledger: Ledger; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bursar-market-"));
  const ledger = new Ledger(join(dir, "ledger.jsonl"));
  return { ledger, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function record(
  ledger: Ledger,
  leg: Leg,
  amount: string,
  status: "confirmed" | "intent" = "confirmed",
  valueUsdCents?: string,
): Promise<void> {
  const intentId = Ledger.intentId({
    leg,
    chainId: 8453,
    to: `0x${"a".repeat(40)}`,
    amount,
    token: null,
    period: dailyPeriod(),
    nonce: `${leg}-${amount}-${status}`,
  });
  await ledger.append({
    intentId,
    status,
    leg,
    chainId: 8453,
    to: `0x${"a".repeat(40)}`,
    amount,
    token: null,
    decimals: 18,
    memo: `${leg} test`,
    ...(valueUsdCents ? { valueUsdCents } : {}),
  });
}

describe("revenue is counted apart from spending", () => {
  test("an earning does not consume the daily spend cap", async () => {
    // The regression this guards: every cap aggregate works by summing entry
    // amounts, so income filed in the same ledger would read as money that left.
    // The treasury would then refuse payouts it had the funds for — and would do
    // it for a reason no one could see, because nothing was actually spent.
    const { ledger, cleanup } = await scratchLedger();
    try {
      const since = new Date(Date.now() - 60_000);
      await record(ledger, "payout", "1000");
      await record(ledger, "earning", "9999999");

      assert.equal(await ledger.movedSince(since), 1000n, "earnings leaked into spend");
    } finally {
      await cleanup();
    }
  });

  test("an earning does not consume the cross-asset USD ceiling either", async () => {
    const { ledger, cleanup } = await scratchLedger();
    try {
      const since = new Date(Date.now() - 60_000);
      await record(ledger, "payout", "1000", "confirmed", "250");
      await record(ledger, "earning", "9999999", "confirmed", "100000");

      assert.equal(await ledger.valueMovedSince(since), 250n);
    } finally {
      await cleanup();
    }
  });

  test("earnedSince totals income and ignores outbound legs", async () => {
    const { ledger, cleanup } = await scratchLedger();
    try {
      const since = new Date(Date.now() - 60_000);
      await record(ledger, "earning", "10000");
      await record(ledger, "earning", "5000");
      await record(ledger, "payout", "777");

      assert.equal(await ledger.earnedSince(since), 15000n);
    } finally {
      await cleanup();
    }
  });

  test("unsettled income is not counted as earned", async () => {
    // Splitting revenue that has not landed is how a treasury pays out money it
    // does not have.
    const { ledger, cleanup } = await scratchLedger();
    try {
      const since = new Date(Date.now() - 60_000);
      await record(ledger, "earning", "10000", "intent");

      assert.equal(await ledger.earnedSince(since), 0n);
    } finally {
      await cleanup();
    }
  });
});

describe("reading an x402 challenge", () => {
  test("an accepts envelope is read as payment terms", () => {
    const challenge = readPaymentChallenge({
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "10000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x069C76420DD98cAfa97cc1D349BC1cC708284032",
          resource: "https://app.keeperhub.com/api/mcp/workflows/bursar-payout-preflight/call",
        },
      ],
    });

    assert.ok(challenge);
    assert.equal(challenge.maxAmountRequired, "10000"); // $0.01 at 6 decimals
    assert.equal(challenge.network, "base");
    assert.equal(challenge.payTo, "0x069C76420DD98cAfa97cc1D349BC1cC708284032");
  });

  test("a bare payment requirement is read too", () => {
    const challenge = readPaymentChallenge({ maxAmountRequired: "10000", network: "base" });
    assert.ok(challenge);
    assert.equal(challenge.maxAmountRequired, "10000");
  });

  test("an undecodable 402 still counts as a demand for payment", () => {
    // Reading a challenge we cannot parse as "no challenge" would mean treating
    // a paid call as free — the one misreading with a cost attached.
    const challenge = readPaymentChallenge(null, "HTTP 402: Payment Required");
    assert.ok(challenge, "a 402 must never read as free");
  });

  test("an ordinary result is not mistaken for a challenge", () => {
    assert.equal(readPaymentChallenge({ balanceWei: "1000", success: true }, "ok"), null);
    assert.equal(readPaymentChallenge(null, ""), null);
  });
});

describe("the preflight verdict", () => {
  const reserve = BigInt(DEFAULT_GAS_RESERVE_WEI);

  test("a payment that clears the reserve is safe", () => {
    const verdict = readPreflight({ balanceWei: "5000000000000000" }, 1_000_000_000_000_000n, reserve);
    assert.ok(verdict);
    assert.equal(verdict.safe, true);
    assert.equal(verdict.remainingWei, 4_000_000_000_000_000n);
    assert.equal(verdict.shortfallWei, 0n);
  });

  test("a payment that strands the agent is refused, with the shortfall", () => {
    const verdict = readPreflight({ balanceWei: "2500000000000000" }, 1_000_000_000_000_000n, reserve);
    assert.ok(verdict);
    assert.equal(verdict.safe, false);
    assert.equal(verdict.remainingWei, 1_500_000_000_000_000n);
    assert.equal(verdict.shortfallWei, 500_000_000_000_000n);
  });

  test("landing exactly on the reserve is safe", () => {
    // The boundary is where a float-based implementation would get this wrong,
    // and where being wrong is most expensive.
    const balance = (reserve + 1_000_000_000_000_000n).toString();
    const verdict = readPreflight({ balanceWei: balance }, 1_000_000_000_000_000n, reserve);
    assert.ok(verdict);
    assert.equal(verdict.safe, true);
    assert.equal(verdict.remainingWei, reserve);
  });

  test("one wei short is not safe", () => {
    const balance = (reserve + 1_000_000_000_000_000n - 1n).toString();
    const verdict = readPreflight({ balanceWei: balance }, 1_000_000_000_000_000n, reserve);
    assert.ok(verdict);
    assert.equal(verdict.safe, false);
    assert.equal(verdict.shortfallWei, 1n);
  });

  test("a reading it cannot trust returns nothing rather than a guess", () => {
    for (const bad of [null, {}, { balanceWei: 123 }, { balanceWei: "0x10" }, { balanceWei: "" }]) {
      assert.equal(readPreflight(bad, 1n, reserve), null, `should refuse ${JSON.stringify(bad)}`);
    }
  });

  test("a nested balance reading is accepted", () => {
    const verdict = readPreflight({ balance: { balanceWei: "5000000000000000" } }, 0n, reserve);
    assert.ok(verdict);
    assert.equal(verdict.balanceWei, 5_000_000_000_000_000n);
  });
});

describe("the published listing", () => {
  test("the workflow gates on the balance it just read", () => {
    const workflow = payoutPreflightWorkflow();
    const gate = workflow.nodes.find((n) => n.id === "gate");
    const condition = String(gate?.data.config.condition ?? "");

    assert.match(condition, /@check-balance:Check Balance\.balanceWei/);
    assert.ok(condition.includes(">="), "the reserve boundary must be inclusive");
  });

  test("every declared input is actually referenced by a node", () => {
    // A listing that advertises an input it ignores is a lie told to every agent
    // that reads the catalogue.
    const workflow = payoutPreflightWorkflow();
    const body = JSON.stringify(workflow);
    for (const field of Object.keys(PREFLIGHT_INPUT_SCHEMA.properties)) {
      assert.ok(body.includes(field), `input ${field} is advertised but never used`);
    }
  });

  test("amounts are declared as digit strings, not numbers", () => {
    // 18 decimals does not survive a JSON number, and the digits it loses are
    // the ones the comparison turns on.
    const props = PREFLIGHT_INPUT_SCHEMA.properties;
    assert.equal(props.amountWei.type, "string");
    assert.equal(props.gasReserveWei.type, "string");
    assert.match("1000000000000000", new RegExp(props.amountWei.pattern));
    assert.ok(!new RegExp(props.amountWei.pattern).test("1e15"));
  });
});
