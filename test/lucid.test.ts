import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configSchema, type Contributor } from "../src/config.js";
import { Ledger, dailyPeriod } from "../src/ledger/store.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { readAgentCard, LucidAgent } from "../src/lucid/client.js";
import { planPayment, chainIdFromNetwork } from "../src/lucid/pay.js";
import type { PaymentChallenge } from "../src/keeperhub/mcp.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ORACLE = "0x069C76420DD98cAfa97cc1D349BC1cC708284032";

const contributors: Contributor[] = [
  { name: "model", address: `0x${"1".repeat(40)}`, shareBps: 10_000 },
];

function config(overrides: Record<string, unknown> = {}) {
  return configSchema.parse({
    treasury: { chainId: 84532 },
    contributors,
    policy: {
      maxPerTransfer: "1000000000000000",
      maxPerDay: "2000000000000000",
      allowlist: [ORACLE],
      assets: {
        [USDC]: {
          symbol: "USDC",
          decimals: 6,
          maxPerTransfer: "50000",
          maxPerDay: "200000",
        },
      },
      ...overrides,
    },
  });
}

async function withLedger<T>(fn: (ledger: Ledger) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bursar-lucid-"));
  try {
    return await fn(new Ledger(join(dir, "ledger.jsonl")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const challenge = (over: Partial<PaymentChallenge> = {}): PaymentChallenge => ({
  maxAmountRequired: "10000",
  network: "eip155:84532",
  asset: USDC,
  payTo: ORACLE,
  raw: null,
  ...over,
});

describe("reading an agent card", () => {
  test("reads entrypoints, pricing and extensions", () => {
    const card = readAgentCard({
      name: "counterparty-oracle",
      version: "1.0.0",
      description: "Answers whether an address is safe to pay.",
      capabilities: { extensions: [{ uri: "https://x402.org/ext/v2" }, "erc8004"] },
      entrypoints: [
        { key: "health", description: "Liveness check. Free." },
        {
          key: "counterparty-check",
          description: "Vouch for a payee.",
          paymentProtocol: "x402",
          x402: {
            offers: [
              {
                scheme: "exact",
                network: "eip155:84532",
                payTo: ORACLE,
                price: { amount: "10000", asset: USDC },
              },
            ],
          },
        },
      ],
    });

    assert.equal(card.name, "counterparty-oracle");
    assert.equal(card.entrypoints.length, 2);
    assert.deepEqual(card.extensions, ["https://x402.org/ext/v2", "erc8004"]);

    const free = card.entrypoints.find((e) => e.key === "health");
    assert.equal(free?.priced, false);

    const paid = card.entrypoints.find((e) => e.key === "counterparty-check");
    assert.equal(paid?.priced, true);
    assert.equal(paid?.priceAmount, "10000");
    assert.equal(paid?.priceAsset, USDC);
    assert.equal(paid?.payTo, ORACLE);
  });

  test("a paid entrypoint with no readable terms is still paid", () => {
    // The dangerous direction: reading an entrypoint as free means calling it
    // without asking anyone, then discovering the price from the 402.
    const card = readAgentCard({
      name: "x",
      entrypoints: [{ key: "mystery", paymentProtocol: "x402" }],
    });
    assert.equal(card.entrypoints[0]?.priced, true);
  });

  test("reads the bare price and pricing-object shapes too", () => {
    const bare = readAgentCard({ name: "x", entrypoints: [{ key: "a", price: "0.01" }] });
    assert.equal(bare.entrypoints[0]?.priced, true);
    assert.equal(bare.entrypoints[0]?.priceAmount, "0.01");

    const obj = readAgentCard({
      name: "x",
      entrypoints: [{ key: "b", pricing: { amount: "500", asset: USDC } }],
    });
    assert.equal(obj.entrypoints[0]?.priceAmount, "500");
  });

  test("an A2A-shaped card listing skills is understood", () => {
    const card = readAgentCard({ name: "x", skills: [{ id: "summarise" }] });
    assert.equal(card.entrypoints[0]?.key, "summarise");
  });

  test("entrypoints without a key are dropped rather than invented", () => {
    const card = readAgentCard({ name: "x", entrypoints: [{ description: "no key" }] });
    assert.equal(card.entrypoints.length, 0);
  });
});

describe("invoking an entrypoint", () => {
  function agentReturning(status: number, body: unknown, capture?: (r: Request) => void) {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capture?.(new Request(String(url), init));
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return new LucidAgent("http://agent.test", fetchImpl);
  }

  test("unwraps the output envelope", async () => {
    const agent = agentReturning(200, { output: { ok: true, name: "oracle" } });
    const outcome = await agent.invoke("health", {});
    assert.deepEqual(outcome.output, { ok: true, name: "oracle" });
    assert.equal(outcome.challenge, null);
  });

  test("a 402 comes back as a quote, not an exception", async () => {
    // The agent naming its price is the expected path for a paid entrypoint.
    // Throwing here would make the caller treat a price list as a failure.
    const agent = agentReturning(402, {
      x402Version: 2,
      accepts: [{ scheme: "exact", network: "eip155:84532", amount: "10000", payTo: ORACLE }],
    });
    const outcome = await agent.invoke("counterparty-check", { address: ORACLE });
    assert.equal(outcome.status, 402);
    assert.ok(outcome.challenge);
    assert.equal(outcome.challenge.maxAmountRequired, "10000");
    assert.equal(outcome.challenge.payTo, ORACLE);
  });

  test("posts to the entrypoint path with an input envelope", async () => {
    let seen: Request | undefined;
    const agent = agentReturning(200, { output: {} }, (r) => (seen = r));
    await agent.invoke("counterparty-check", { address: ORACLE });
    assert.match(seen!.url, /\/entrypoints\/counterparty-check\/invoke$/);
    assert.equal(seen!.method, "POST");
    assert.deepEqual(await seen!.json(), { input: { address: ORACLE } });
  });

  test("a settled signature rides on the retry", async () => {
    let seen: Request | undefined;
    const agent = agentReturning(200, { output: {} }, (r) => (seen = r));
    await agent.invoke("counterparty-check", { address: ORACLE }, "sig-abc");
    assert.equal(seen!.headers.get("x-payment"), "sig-abc");
  });

  test("a real failure still throws", async () => {
    const agent = agentReturning(500, { error: "boom" });
    await assert.rejects(() => agent.invoke("health", {}));
  });
});

describe("network identifiers", () => {
  test("reads CAIP-2 and bare decimals", () => {
    assert.equal(chainIdFromNetwork("eip155:84532"), 84532);
    assert.equal(chainIdFromNetwork("8453"), 8453);
  });

  test("refuses anything it cannot place", () => {
    for (const bad of [undefined, "", "base", "solana:xyz", "eip155:", "0x2105"]) {
      assert.equal(chainIdFromNetwork(bad), null, `should refuse ${JSON.stringify(bad)}`);
    }
  });
});

describe("deciding whether to pay an invoice", () => {
  const memo = "counterparty check from counterparty-oracle";

  async function plan(ch: PaymentChallenge | null, cfg = config()) {
    return withLedger(async (ledger) => {
      const policy = new PolicyEngine(cfg, ledger);
      return { plan: await planPayment(ch, { policy, ledger, config: cfg, memo }), ledger };
    });
  }

  test("pays an invoice that clears policy", async () => {
    const { plan: p } = await plan(challenge());
    assert.equal(p.outcome, "pay");
    assert.equal(p.priced, "0.01 USDC");
    assert.ok(p.intentId);
  });

  test("refuses a payee that is not on the allowlist", async () => {
    // The question a price cap cannot ask.
    const p = (await plan(challenge({ payTo: `0x${"9".repeat(40)}` }))).plan;
    assert.equal(p.outcome, "refuse");
    assert.match(p.reason, /allowlist/i);
  });

  test("refuses an amount over the asset's per-transfer cap", async () => {
    const p = (await plan(challenge({ maxAmountRequired: "60000" }))).plan;
    assert.equal(p.outcome, "refuse");
  });

  test("holds for a person above the USD approval threshold", async () => {
    // The gap this covers: `requireApprovalAbove` is denominated in the native
    // asset, so it can only govern native movements. An agent paying invoices
    // pays in stablecoins, which means without a USD-denominated threshold an
    // invoice of any size is paid without a human ever seeing it.
    const cfg = config({
      // $0.005 — below the $0.01 invoice.
      requireApprovalAboveUsd: "0",
      assets: {
        [USDC]: {
          symbol: "USDC",
          decimals: 6,
          maxPerTransfer: "50000",
          maxPerDay: "200000",
          priceFeed: `0x${"c".repeat(40)}`,
        },
      },
    });

    // A stablecoin priced at $1.00, read the way the ceiling reads one.
    const valuation = {
      valueInCents: async (amount: bigint, decimals: number) =>
        (amount * 100n) / 10n ** BigInt(decimals),
    };

    const p = await withLedger(async (ledger) => {
      const policy = new PolicyEngine(cfg, ledger, undefined, valuation as never);
      return planPayment(challenge(), { policy, ledger, config: cfg, memo });
    });

    assert.equal(p.outcome, "hold");
    assert.match(p.reason, /approval threshold/);
  });

  test("a token movement with no feed is refused rather than waved through", async () => {
    // Fail closed, the same way the ceiling does. A threshold that cannot be
    // evaluated must not become a threshold that does not apply.
    const cfg = config({ requireApprovalAboveUsd: "100000" });
    const p = (await plan(challenge(), cfg)).plan;
    assert.equal(p.outcome, "refuse");
    assert.match(p.reason, /no price feed/);
  });

  test("refuses an asset with no configured limits", async () => {
    // Without an entry there are no caps and no decimals, so the amount is not
    // a number anyone can reason about.
    const p = (await plan(challenge({ asset: `0x${"7".repeat(40)}` }))).plan;
    assert.equal(p.outcome, "refuse");
    assert.match(p.reason, /no policy\.assets entry/);
  });

  test("refuses an unreadable price", async () => {
    for (const bad of [undefined, "", "0.01", "1e4", "-1"]) {
      const p = (await plan(challenge({ maxAmountRequired: bad }))).plan;
      assert.equal(p.outcome, "refuse", `should refuse ${JSON.stringify(bad)}`);
    }
  });

  test("refuses an invoice with no payee or no asset", async () => {
    assert.equal((await plan(challenge({ payTo: undefined }))).plan.outcome, "refuse");
    assert.equal((await plan(challenge({ asset: undefined }))).plan.outcome, "refuse");
  });

  test("refuses a settlement network it cannot place", async () => {
    const p = (await plan(challenge({ network: "solana:mainnet" }))).plan;
    assert.equal(p.outcome, "refuse");
    assert.match(p.reason, /unrecognised settlement network/);
  });

  test("refuses when there is no challenge at all", async () => {
    assert.equal((await plan(null)).plan.outcome, "refuse");
  });

  test("will not buy the same answer twice in one period", async () => {
    // Same invoice, same period, same key. Paying again buys nothing.
    await withLedger(async (ledger) => {
      const cfg = config();
      const policy = new PolicyEngine(cfg, ledger);
      const first = await planPayment(challenge(), { policy, ledger, config: cfg, memo });
      assert.equal(first.outcome, "pay");

      await ledger.append({
        intentId: first.intentId!,
        status: "confirmed",
        leg: "purchase",
        chainId: 84532,
        to: ORACLE,
        amount: "10000",
        token: USDC,
        decimals: 6,
        memo,
      });

      const second = await planPayment(challenge(), { policy, ledger, config: cfg, memo });
      assert.equal(second.outcome, "refuse");
      assert.match(second.reason, /already paid/);
      assert.equal(second.intentId, first.intentId);
    });
  });

  test("a purchase counts against the day like any other spend", async () => {
    await withLedger(async (ledger) => {
      const since = new Date(Date.now() - 60_000);
      await ledger.append({
        intentId: Ledger.intentId({
          leg: "purchase", chainId: 84532, to: ORACLE, amount: "10000",
          token: USDC, period: dailyPeriod(),
        }),
        status: "confirmed",
        leg: "purchase",
        chainId: 84532,
        to: ORACLE,
        amount: "10000",
        token: USDC,
        decimals: 6,
        memo,
      });
      // Buying is spending. If it did not count, an agent could drain the
      // treasury one invoice at a time without touching the payout budget.
      assert.equal(await ledger.movedSince(since, USDC), 10_000n);
    });
  });
});
