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

describe("PolicyEngine — per-asset limits", () => {
  const TOKEN = `0x${"a".repeat(40)}`;

  async function decide(
    policyExtra: Record<string, unknown>,
    movementExtra: Record<string, unknown>,
  ) {
    const dir = await mkdtemp(join(tmpdir(), "bursar-token-"));
    try {
      const ledger = new Ledger(join(dir, "ledger.jsonl"));
      const config = configSchema.parse({
        treasury: { chainId: 11155111 },
        contributors,
        policy: {
          maxPerTransfer: "1000000000000000000",
          maxPerDay: "2000000000000000000",
          ...policyExtra,
        },
      });
      return await new PolicyEngine(config, ledger).evaluate({
        leg: "yield",
        chainId: 11155111,
        to: contributors[0]!.address,
        amount: "1000000",
        token: TOKEN,
        decimals: 6,
        memo: "usdc",
        ...movementExtra,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("refuses a token with no configured limits", async () => {
    // 1000 USDC is 1e9 base units, which would read as dust against a
    // wei ceiling and slip through every native limit.
    const decision = await decide({}, {});
    assert.equal(decision.verdict, "deny");
    assert.match((decision as { reason: string }).reason, /no entry in policy\.assets/);
  });

  test("allows a token that is configured and within its own caps", async () => {
    const decision = await decide(
      {
        assets: {
          [TOKEN]: {
            symbol: "USDC",
            decimals: 6,
            maxPerTransfer: "10000000",
            maxPerDay: "50000000",
          },
        },
      },
      {},
    );
    assert.equal(decision.verdict, "allow");
  });

  test("measures the token against its own ceiling, not the native one", async () => {
    // 2 USDC against a 1 USDC cap must fail, even though 2e6 is far below
    // the native 1e18 ceiling.
    const decision = await decide(
      {
        assets: {
          [TOKEN]: {
            symbol: "USDC",
            decimals: 6,
            maxPerTransfer: "1000000",
            maxPerDay: "50000000",
          },
        },
      },
      { amount: "2000000" },
    );
    assert.equal(decision.verdict, "deny");
    assert.match((decision as { reason: string }).reason, /USDC maxPerTransfer/);
  });

  test("refuses a decimals mismatch rather than rescaling silently", async () => {
    // Treating 6-decimal USDC as 18-decimal is a millionfold error.
    const decision = await decide(
      {
        assets: {
          [TOKEN]: {
            symbol: "USDC",
            decimals: 6,
            maxPerTransfer: "10000000",
            maxPerDay: "50000000",
          },
        },
      },
      { decimals: 18 },
    );
    assert.equal(decision.verdict, "deny");
    assert.match((decision as { reason: string }).reason, /decimals/);
  });

  test("matches the token address case-insensitively", async () => {
    const decision = await decide(
      {
        assets: {
          [TOKEN.toUpperCase().replace("0X", "0x")]: {
            symbol: "USDC",
            decimals: 6,
            maxPerTransfer: "10000000",
            maxPerDay: "50000000",
          },
        },
      },
      {},
    );
    assert.equal(decision.verdict, "allow");
  });

  test("rejects an asset whose per-transfer cap exceeds its daily cap", () => {
    const result = configSchema.safeParse({
      treasury: { chainId: 1 },
      contributors,
      policy: {
        maxPerTransfer: "100",
        maxPerDay: "1000",
        assets: {
          [TOKEN]: { symbol: "USDC", decimals: 6, maxPerTransfer: "500", maxPerDay: "100" },
        },
      },
    });
    assert.equal(result.success, false);
  });
});

describe("PolicyEngine — the platform's cap is the one that binds", () => {
  const contributor = contributors[0]!;

  async function decide(
    remaining: bigint,
    amount: string,
    localMaxPerDay = "1000000000000000000",
  ) {
    const dir = await mkdtemp(join(tmpdir(), "bursar-budget-"));
    try {
      const ledger = new Ledger(join(dir, "ledger.jsonl"));
      const config = configSchema.parse({
        treasury: { chainId: 11155111 },
        contributors,
        policy: { maxPerTransfer: "1000000000000000000", maxPerDay: localMaxPerDay },
      });
      const engine = new PolicyEngine(config, ledger, async () => ({
        effectiveDailyCapWei: 20000000000000000n,
        dailyUsedWei: 20000000000000000n - remaining,
        remainingWei: remaining,
        usingDefaultCap: true,
      }));
      return await engine.evaluate({
        leg: "payout",
        chainId: 11155111,
        to: contributor.address,
        amount,
        token: null,
        decimals: 18,
        memo: "budget test",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("refuses what the platform will not honour, even when local policy allows it", async () => {
    // The local ceiling says 1 ETH; KeeperHub has 0.001 left today. A movement
    // that passes every local check and then fails at the API is worse than
    // one refused here, because the ledger never learns which it was.
    const decision = await decide(1000000000000000n, "500000000000000000");
    assert.equal(decision.verdict, "deny");
    assert.match((decision as { reason: string }).reason, /KeeperHub|daily cap/i);
  });

  test("says how much is actually left, not just that it refused", async () => {
    const decision = await decide(1000000000000000n, "500000000000000000");
    assert.match((decision as { reason: string }).reason, /1000000000000000/);
  });

  test("allows a movement that fits inside the remaining platform budget", async () => {
    const decision = await decide(10000000000000000n, "1000000000000000");
    assert.equal(decision.verdict, "allow");
  });

  test("still works with no reader, so it runs offline and in tests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bursar-budget-"));
    try {
      const ledger = new Ledger(join(dir, "ledger.jsonl"));
      const config = configSchema.parse({
        treasury: { chainId: 11155111 },
        contributors,
        policy: { maxPerTransfer: "1000", maxPerDay: "2000" },
      });
      const decision = await new PolicyEngine(config, ledger).evaluate({
        leg: "payout",
        chainId: 11155111,
        to: contributor.address,
        amount: "500",
        token: null,
        decimals: 18,
        memo: "offline",
      });
      assert.equal(decision.verdict, "allow");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a reader that throws does not take the treasury down", async () => {
    // Losing sight of the platform's budget is a reason to fall back to local
    // limits, not a reason to stop paying anyone.
    const dir = await mkdtemp(join(tmpdir(), "bursar-budget-"));
    try {
      const ledger = new Ledger(join(dir, "ledger.jsonl"));
      const config = configSchema.parse({
        treasury: { chainId: 11155111 },
        contributors,
        policy: { maxPerTransfer: "1000", maxPerDay: "2000" },
      });
      const engine = new PolicyEngine(config, ledger, async () => {
        throw new Error("MCP unreachable");
      });
      const decision = await engine.evaluate({
        leg: "payout",
        chainId: 11155111,
        to: contributor.address,
        amount: "500",
        token: null,
        decimals: 18,
        memo: "degraded",
      });
      assert.equal(decision.verdict, "allow");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
