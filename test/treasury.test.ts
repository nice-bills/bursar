import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { splitByShares, configSchema, type Contributor } from "../src/config.js";
import { Ledger } from "../src/ledger/store.js";
import { PolicyEngine } from "../src/policy/engine.js";

const contributors: Contributor[] = [
  { name: "model", address: `0x${"1".repeat(40)}`, shareBps: 5000 },
  { name: "tools", address: `0x${"2".repeat(40)}`, shareBps: 3000 },
  { name: "host", address: `0x${"3".repeat(40)}`, shareBps: 2000 },
];

describe("splitByShares", () => {
  test("splits cleanly when the amount divides evenly", () => {
    const parts = splitByShares(10_000n, contributors);
    assert.deepEqual(
      parts.map((p) => p.amount),
      [5000n, 3000n, 2000n],
    );
  });

  test("never loses a wei to integer division", () => {
    // 7 wei across 50/30/20 is 3.5 / 2.1 / 1.4 — every split has a remainder.
    const amount = 7n;
    const parts = splitByShares(amount, contributors);
    const total = parts.reduce((sum, p) => sum + p.amount, 0n);
    assert.equal(total, amount, "sum of splits must equal the input exactly");
  });

  test("hands the remainder to the largest shareholder, deterministically", () => {
    const parts = splitByShares(7n, contributors);
    assert.equal(parts[0]?.contributor.name, "model");
    // 3 (floor of 3.5) + 1 remainder wei.
    assert.equal(parts[0]?.amount, 4n);
    assert.deepEqual(splitByShares(7n, contributors), parts, "must be stable across calls");
  });

  test("handles amounts far beyond Number.MAX_SAFE_INTEGER", () => {
    const amount = 10n ** 30n + 7n;
    const parts = splitByShares(amount, contributors);
    assert.equal(parts.reduce((sum, p) => sum + p.amount, 0n), amount);
  });
});

describe("config validation", () => {
  const base = {
    treasury: { chainId: 11155111 },
    contributors,
    policy: { maxPerTransfer: "100", maxPerDay: "1000" },
  };

  test("accepts a valid config", () => {
    assert.equal(configSchema.safeParse(base).success, true);
  });

  test("rejects shares that do not sum to 10000", () => {
    const result = configSchema.safeParse({
      ...base,
      contributors: [{ name: "solo", address: `0x${"4".repeat(40)}`, shareBps: 9999 }],
    });
    assert.equal(result.success, false);
  });

  test("rejects duplicate contributor addresses", () => {
    const result = configSchema.safeParse({
      ...base,
      contributors: [
        { name: "a", address: `0x${"5".repeat(40)}`, shareBps: 5000 },
        { name: "b", address: `0x${"5".repeat(40)}`, shareBps: 5000 },
      ],
    });
    assert.equal(result.success, false);
  });

  test("rejects a float target that cannot raise the balance", () => {
    const result = configSchema.safeParse({
      ...base,
      float: [{ chainId: 1, minBalance: "100", targetBalance: "50" }],
    });
    assert.equal(result.success, false);
  });

  test("rejects a per-transfer cap that exceeds the daily cap", () => {
    const result = configSchema.safeParse({
      ...base,
      policy: { maxPerTransfer: "2000", maxPerDay: "1000" },
    });
    assert.equal(result.success, false);
  });
});

describe("Ledger.intentId", () => {
  const input = {
    leg: "payout" as const,
    chainId: 1,
    to: `0x${"a".repeat(40)}`,
    amount: "1000",
    token: null,
    period: "2026-09-10",
  };

  test("is stable for the same movement in the same period", () => {
    assert.equal(Ledger.intentId(input), Ledger.intentId(input));
  });

  test("ignores recipient casing, so checksummed and lowercase agree", () => {
    assert.equal(
      Ledger.intentId(input),
      Ledger.intentId({ ...input, to: input.to.toUpperCase().replace("0X", "0x") }),
    );
  });

  test("changes when the period changes", () => {
    assert.notEqual(Ledger.intentId(input), Ledger.intentId({ ...input, period: "2026-09-11" }));
  });

  test("changes when a deliberate nonce is supplied", () => {
    assert.notEqual(Ledger.intentId(input), Ledger.intentId({ ...input, nonce: "second" }));
  });
});

describe("PolicyEngine", () => {
  async function withLedger<T>(fn: (ledger: Ledger) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "bursar-test-"));
    try {
      return await fn(new Ledger(join(dir, "ledger.jsonl")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const config = configSchema.parse({
    treasury: { chainId: 11155111 },
    contributors,
    policy: { maxPerTransfer: "1000", maxPerDay: "2000" },
  });

  const movement = {
    leg: "payout" as const,
    chainId: 11155111,
    to: contributors[0]!.address,
    amount: "500",
    token: null,
    decimals: 18,
    memo: "test",
  };

  test("allows a movement inside every limit", async () => {
    await withLedger(async (ledger) => {
      const decision = await new PolicyEngine(config, ledger).evaluate(movement);
      assert.equal(decision.verdict, "allow");
    });
  });

  test("denies a recipient that is not on the allowlist", async () => {
    await withLedger(async (ledger) => {
      const decision = await new PolicyEngine(config, ledger).evaluate({
        ...movement,
        to: `0x${"9".repeat(40)}`,
      });
      assert.equal(decision.verdict, "deny");
      assert.match((decision as { reason: string }).reason, /allowlist/);
    });
  });

  test("denies an amount over the per-transfer ceiling", async () => {
    await withLedger(async (ledger) => {
      const decision = await new PolicyEngine(config, ledger).evaluate({
        ...movement,
        amount: "1001",
      });
      assert.equal(decision.verdict, "deny");
      assert.match((decision as { reason: string }).reason, /maxPerTransfer/);
    });
  });

  test("counts in-flight movements against the daily cap", async () => {
    await withLedger(async (ledger) => {
      // Submitted but unconfirmed: the money may already be gone.
      await ledger.append({
        intentId: "prior",
        status: "submitted",
        leg: "payout",
        chainId: 11155111,
        to: contributors[1]!.address,
        amount: "1800",
        token: null,
        decimals: 18,
        memo: "in flight",
      });

      const decision = await new PolicyEngine(config, ledger).evaluate(movement);
      assert.equal(decision.verdict, "deny");
      assert.match((decision as { reason: string }).reason, /maxPerDay|unreconciled/);
    });
  });

  test("blocks new movements while an intent is unreconciled", async () => {
    await withLedger(async (ledger) => {
      await ledger.append({
        intentId: "stuck",
        status: "intent",
        leg: "sweep",
        chainId: 11155111,
        to: contributors[0]!.address,
        amount: "1",
        token: null,
        decimals: 18,
        memo: "crashed mid-flight",
      });

      const decision = await new PolicyEngine(config, ledger).evaluate(movement);
      assert.equal(decision.verdict, "deny");
      assert.match((decision as { reason: string }).reason, /unreconciled/);
    });
  });

  test("escalates above the approval threshold instead of denying", async () => {
    await withLedger(async (ledger) => {
      const escalating = configSchema.parse({
        treasury: { chainId: 11155111 },
        contributors,
        policy: { maxPerTransfer: "1000", maxPerDay: "2000", requireApprovalAbove: "100" },
      });
      const decision = await new PolicyEngine(escalating, ledger).evaluate(movement);
      assert.equal(decision.verdict, "needs_approval");
    });
  });

  test("rejects a non-integer amount rather than coercing it", async () => {
    await withLedger(async (ledger) => {
      const decision = await new PolicyEngine(config, ledger).evaluate({
        ...movement,
        amount: "1.5",
      });
      assert.equal(decision.verdict, "deny");
    });
  });
});

describe("PolicyEngine — assets it cannot yet measure", () => {
  test("refuses ERC-20 movements rather than comparing them to a native cap", async () => {
    // 1000 USDC is 1e9 base units, which would read as dust against a
    // wei-denominated ceiling and slip through every limit.
    const dir = await mkdtemp(join(tmpdir(), "bursar-token-"));
    try {
      const ledger = new Ledger(join(dir, "ledger.jsonl"));
      const config = configSchema.parse({
        treasury: { chainId: 11155111 },
        contributors,
        policy: { maxPerTransfer: "1000000000000000000", maxPerDay: "2000000000000000000" },
      });

      const decision = await new PolicyEngine(config, ledger).evaluate({
        leg: "yield",
        chainId: 11155111,
        to: contributors[0]!.address,
        amount: "1000000000",
        token: `0x${"a".repeat(40)}`,
        decimals: 6,
        memo: "usdc",
      });

      assert.equal(decision.verdict, "deny");
      assert.match((decision as { reason: string }).reason, /native asset only|per-asset/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
