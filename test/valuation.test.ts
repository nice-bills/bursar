import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configSchema } from "../src/config.js";
import { Ledger } from "../src/ledger/store.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { Valuation, formatUsd, ValuationError } from "../src/treasury/valuation.js";
import type { KeeperHubClient } from "../src/keeperhub/client.js";
import type { Movement } from "../src/policy/engine.js";

const TOKEN = `0x${"a".repeat(40)}`;
const ETH_FEED = `0x${"e".repeat(40)}`;
const TOKEN_FEED = `0x${"f".repeat(40)}`;

const contributors = [
  { name: "a", address: `0x${"1".repeat(40)}`, shareBps: 5000 },
  { name: "b", address: `0x${"2".repeat(40)}`, shareBps: 5000 },
];

/** A feed that answers with a fixed price, as Chainlink would. */
function feedClient(prices: Record<string, { answer: string; ageSeconds?: number }>) {
  return {
    async contractCall(params: { contractAddress: string; functionName: string }) {
      const entry = prices[params.contractAddress.toLowerCase()];
      if (!entry) throw new Error(`no feed at ${params.contractAddress}`);
      const result =
        params.functionName === "decimals"
          ? "8"
          : {
              answer: entry.answer,
              updatedAt: String(Math.floor(Date.now() / 1000) - (entry.ageSeconds ?? 0)),
            };
      return { raw: { result }, output: null } as never;
    },
  } as unknown as KeeperHubClient;
}

// ETH at $2,524.66 and a token at $11.50, both 8 decimals like the real feeds.
const PRICES = {
  [ETH_FEED.toLowerCase()]: { answer: "252466000000" },
  [TOKEN_FEED.toLowerCase()]: { answer: "1150000000" },
};

function config(extra: Record<string, unknown> = {}) {
  return configSchema.parse({
    treasury: { chainId: 11155111 },
    contributors,
    policy: {
      maxPerTransfer: "10000000000000000000",
      maxPerDay: "20000000000000000000",
      nativePriceFeed: ETH_FEED,
      assets: {
        [TOKEN]: {
          symbol: "LINK",
          decimals: 18,
          maxPerTransfer: "100000000000000000000",
          maxPerDay: "200000000000000000000",
          priceFeed: TOKEN_FEED,
        },
      },
      ...extra,
    },
  });
}

async function withLedger<T>(fn: (ledger: Ledger) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bursar-val-"));
  try {
    return await fn(new Ledger(join(dir, "ledger.jsonl")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function movement(over: Record<string, unknown> = {}): Movement {
  return {
    leg: "payout" as const,
    chainId: 11155111,
    to: contributors[0]!.address,
    amount: "1000000000000000000", // 1 whole unit
    token: null as string | null,
    decimals: 18,
    memo: "test",
    ...over,
  };
}

describe("valuation", () => {
  test("prices a whole unit against an 8-decimal feed", async () => {
    const v = new Valuation(feedClient(PRICES));
    const cents = await v.valueInCents(10n ** 18n, 18, 1, ETH_FEED);
    assert.equal(cents, 252466n, "1 ETH at $2,524.66 is 252466 cents");
  });

  test("rounds down, so a valuation never overstates the ceiling's headroom", async () => {
    const v = new Valuation(feedClient(PRICES));
    // One wei is worth a vanishing fraction of a cent.
    assert.equal(await v.valueInCents(1n, 18, 1, ETH_FEED), 0n);
  });

  test("refuses a stale price rather than valuing against it", async () => {
    const v = new Valuation(
      feedClient({ [ETH_FEED.toLowerCase()]: { answer: "252466000000", ageSeconds: 7200 } }),
      60_000,
      3600,
    );
    await assert.rejects(() => v.valueInCents(10n ** 18n, 18, 1, ETH_FEED), ValuationError);
  });

  test("formats cents as money", () => {
    assert.equal(formatUsd(252466n), "$2,524.66");
    assert.equal(formatUsd(5n), "$0.05");
    assert.equal(formatUsd(0n), "$0.00");
  });
});

describe("cross-asset ceiling", () => {
  test("allows a movement inside the ceiling", async () => {
    await withLedger(async (ledger) => {
      const engine = new PolicyEngine(
        config({ maxPerDayUsd: "500000" }), // $5,000
        ledger,
        undefined,
        new Valuation(feedClient(PRICES)),
      );
      const m = movement();
      assert.equal((await engine.evaluate(m)).verdict, "allow");
      assert.equal(m.valueUsdCents, "252466", "the valuation is handed back to be recorded");
    });
  });

  test("counts value across different assets against one ceiling", async () => {
    // This is the gap per-asset caps leave: each asset is individually fine.
    await withLedger(async (ledger) => {
      await ledger.append({
        intentId: "earlier", status: "confirmed", leg: "payout", chainId: 11155111,
        to: contributors[0]!.address, amount: "1000000000000000000", token: null,
        decimals: 18, valueUsdCents: "252466", memo: "1 ETH already gone",
      });

      const engine = new PolicyEngine(
        config({ maxPerDayUsd: "300000" }), // $3,000
        ledger,
        undefined,
        new Valuation(feedClient(PRICES)),
      );

      // 100 LINK is ~$1,150 — well inside LINK's own cap, but it tips the total.
      const decision = await engine.evaluate(
        movement({ token: TOKEN, amount: "100000000000000000000" }),
      );
      assert.equal(decision.verdict, "deny");
      assert.match((decision as { reason: string }).reason, /ceiling/);
    });
  });

  test("fails closed when the price cannot be read", async () => {
    await withLedger(async (ledger) => {
      const broken = {
        async contractCall() { throw new Error("feed unreachable"); },
      } as unknown as KeeperHubClient;

      const decision = await new PolicyEngine(
        config({ maxPerDayUsd: "500000" }),
        ledger,
        undefined,
        new Valuation(broken),
      ).evaluate(movement());

      // A ceiling that cannot be evaluated is not a ceiling.
      assert.equal(decision.verdict, "deny");
      assert.match((decision as { reason: string }).reason, /could not value/);
    });
  });

  test("refuses an asset with no feed while a ceiling is set", async () => {
    await withLedger(async (ledger) => {
      const decision = await new PolicyEngine(
        config({ maxPerDayUsd: "500000" }),
        ledger,
        undefined,
        // No valuation supplied at all.
      ).evaluate(movement());
      assert.equal(decision.verdict, "deny");
      assert.match((decision as { reason: string }).reason, /price feed/);
    });
  });

  test("a config with a ceiling but no feeds is rejected at load", () => {
    const result = configSchema.safeParse({
      treasury: { chainId: 1 },
      contributors,
      policy: { maxPerTransfer: "100", maxPerDay: "1000", maxPerDayUsd: "500000" },
    });
    assert.equal(result.success, false);
  });

  test("no ceiling configured means no price read at all", async () => {
    await withLedger(async (ledger) => {
      const exploding = {
        async contractCall() { throw new Error("should not be called"); },
      } as unknown as KeeperHubClient;
      const decision = await new PolicyEngine(
        config(), ledger, undefined, new Valuation(exploding),
      ).evaluate(movement());
      assert.equal(decision.verdict, "allow");
    });
  });
});
