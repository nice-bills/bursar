import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configSchema, type Contributor } from "../src/config.js";
import { Ledger, dailyPeriod } from "../src/ledger/store.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { readAgentCard, LucidAgent, decodeChallengeHeader } from "../src/lucid/client.js";
import { planPayment, chainIdFromNetwork } from "../src/lucid/pay.js";
import { readPaymentChallenge, type PaymentChallenge } from "../src/keeperhub/mcp.js";
import {
  settle,
  createPayingFetch,
  payerAddress,
  payerConfigured,
  SettlementError,
} from "../src/lucid/settle.js";

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

/**
 * The card a running Lucid agent actually serves, abridged to the parts that
 * decide anything. Captured from `examples/lucid-agent` — not hand-written,
 * because every assumption made about this shape before it was fetched turned
 * out to be wrong in the direction that reads a paid entrypoint as free.
 */
const SERVED_CARD = {
  protocolVersion: "1.0",
  name: "counterparty-oracle",
  version: "1.0.0",
  description: "Answers whether an address is safe to pay. Free health check, priced verdict.",
  capabilities: { streaming: false, pushNotifications: false },
  // The A2A view: every capability, none of the prices.
  skills: [
    { id: "health", name: "health", description: "Liveness check. Free." },
    { id: "counterparty-check", name: "counterparty-check", description: "Vouch for a payee." },
  ],
  // The Lucid view: keyed by name, and where the pricing lives.
  entrypoints: {
    health: {
      description: "Liveness check. Free.",
      input_schema: { type: "object", properties: {} },
    },
    "counterparty-check": {
      description: "Given an address, report whether this oracle vouches for it as a payee.",
      input_schema: {
        type: "object",
        properties: { address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" } },
        required: ["address"],
      },
      payment_protocol: "x402",
      network: "eip155:84532",
      pricing: { invoke: "10000" },
    },
  },
  // And the asset, which appears exactly once, here.
  payments: [
    {
      method: "x402",
      payee: ORACLE,
      network: "eip155:84532",
      endpoint: "https://x402.org/facilitator",
      priceModel: { default: "10000" },
      extensions: {
        x402: {
          scheme: "exact",
          network: "eip155:84532",
          payTo: ORACLE,
          facilitatorUrl: "https://x402.org/facilitator",
          price: { amount: "10000", asset: USDC },
        },
      },
    },
  ],
};

describe("the card a real agent serves", () => {
  test("keyed entrypoints win over the skills array", () => {
    // Both list the same two capabilities. Only one of them carries pricing,
    // and preferring the array because it is an array reads the paid
    // entrypoint as free — which is how the connector calls it without asking
    // anyone, and learns the price from the 402.
    const card = readAgentCard(SERVED_CARD);
    assert.equal(card.entrypoints.length, 2);

    const paid = card.entrypoints.find((e) => e.key === "counterparty-check");
    assert.equal(paid?.priced, true, "the priced entrypoint must not read as free");
    assert.equal(paid?.priceAmount, "10000");
  });

  test("the asset is taken from the card's payment methods", () => {
    // An entrypoint states its price and network; the asset it is denominated
    // in appears once, at the top of the card. A price without its asset is a
    // number with no units, and the treasury refuses to pay those.
    const card = readAgentCard(SERVED_CARD);
    const paid = card.entrypoints.find((e) => e.key === "counterparty-check");
    assert.equal(paid?.priceAsset, USDC);
    assert.equal(paid?.payTo, ORACLE);
    assert.equal(paid?.network, "eip155:84532");
  });

  test("a free entrypoint does not inherit the card's price", () => {
    const card = readAgentCard(SERVED_CARD);
    const free = card.entrypoints.find((e) => e.key === "health");
    assert.equal(free?.priced, false);
    assert.equal(free?.priceAmount, undefined);
    assert.equal(free?.priceAsset, undefined);
  });

  test("the published input schema survives", () => {
    const card = readAgentCard(SERVED_CARD);
    const paid = card.entrypoints.find((e) => e.key === "counterparty-check");
    const schema = paid?.inputSchema as { required?: string[] };
    assert.deepEqual(schema?.required, ["address"]);
  });
});

describe("a challenge carried in the headers", () => {
  const terms = {
    x402Version: 2,
    error: "Payment required",
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        amount: "10000",
        asset: USDC,
        payTo: ORACLE,
      },
    ],
  };

  test("base64 payment-required is decoded", () => {
    // Confirmed against the running agent: the 402 body is `{}` and the terms
    // travel in this header. Reading only the body reports a paid call as free.
    const headers = new Headers({
      "payment-required": Buffer.from(JSON.stringify(terms)).toString("base64"),
    });
    const decoded = decodeChallengeHeader(headers);
    const challenge = readPaymentChallenge(decoded, "");
    assert.ok(challenge);
    assert.equal(challenge.maxAmountRequired, "10000");
    assert.equal(challenge.asset, USDC);
    assert.equal(challenge.payTo, ORACLE);
  });

  test("a header sent as plain JSON is read too", () => {
    const headers = new Headers({ "payment-required": JSON.stringify(terms) });
    assert.ok(readPaymentChallenge(decodeChallengeHeader(headers), ""));
  });

  test("no payment header yields nothing rather than throwing", () => {
    assert.equal(decodeChallengeHeader(new Headers()), null);
    assert.equal(decodeChallengeHeader(new Headers({ "payment-required": "@@@" })), null);
  });
});

/** A minimal approved plan, for the call sites that only exercise the signer. */
const APPROVED_PLAN = {
  outcome: "pay",
  reason: "within policy",
  amount: "10000",
  asset: `0x${"a".repeat(40)}`,
  payTo: `0x${"b".repeat(40)}`,
  chainId: 84532,
  decimals: 6,
  intentId: "test-intent",
} as const;

describe("settlement only ever follows approval", () => {
  test("refuses to pay a plan the engine did not approve", async () => {
    // The one ordering that must never reverse. `@x402/fetch` offers a fetch
    // that pays any 402 it meets, which would route money around the engine
    // rather than through it — so settlement asserts the decision was made.
    // A per-run temp path, not a fixed one in /tmp: these tests throw before
    // appending today, but a shared world-writable path is one refactor away
    // from colliding between concurrent runs and between users on one machine.
    const ledger = new Ledger(join(await mkdtemp(join(tmpdir(), "bursar-lucid-")), "ledger.jsonl"));
    for (const outcome of ["refuse", "hold"] as const) {
      await assert.rejects(
        () =>
          settle(
            { outcome, reason: "nope", intentId: "x", chainId: 84532, amount: "1",
              payTo: ORACLE, asset: USDC },
            { url: "http://agent.test/entrypoints/x/invoke", input: {} },
            ledger,
          ),
        SettlementError,
        `should refuse to settle a ${outcome} plan`,
      );
    }
  });

  test("refuses an approved plan that is missing its details", async () => {
    // A per-run temp path, not a fixed one in /tmp: these tests throw before
    // appending today, but a shared world-writable path is one refactor away
    // from colliding between concurrent runs and between users on one machine.
    const ledger = new Ledger(join(await mkdtemp(join(tmpdir(), "bursar-lucid-")), "ledger.jsonl"));
    await assert.rejects(
      () =>
        settle(
          { outcome: "pay", reason: "ok" },
          { url: "http://agent.test/entrypoints/x/invoke", input: {} },
          ledger,
        ),
      SettlementError,
    );
  });

  test("will not sign on a chain it has no signer for", () => {
    // A payer that signs on any chain the counterparty names is a payer the
    // counterparty can redirect.
    assert.throws(
      () =>
        createPayingFetch(1, APPROVED_PLAN, {
          BURSAR_PAYER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        } as never),
      SettlementError,
    );
  });

  test("reports a malformed key without printing it", () => {
    const env = { BURSAR_PAYER_PRIVATE_KEY: "obviously-not-a-key" } as never;
    assert.equal(payerAddress(env), null);
    try {
      createPayingFetch(84532, APPROVED_PLAN, env);
      assert.fail("should have refused");
    } catch (error) {
      const message = (error as Error).message;
      assert.match(message, /not a 32-byte hex key/);
      assert.ok(
        !message.includes("obviously-not-a-key"),
        "the key must never appear in an error message",
      );
    }
  });

  test("derives the payer address without exposing the key", () => {
    const env = { BURSAR_PAYER_PRIVATE_KEY: `0x${"1".repeat(64)}` } as never;
    const address = payerAddress(env);
    assert.match(address ?? "", /^0x[a-fA-F0-9]{40}$/);
    assert.equal(payerConfigured(env), true);
    assert.equal(payerConfigured({} as never), false);
  });
});

describe("a payment that was never attempted is never recorded", () => {
  test("no key means no ledger entry at all", async () => {
    // Recording an intent for a payment that could not even be signed leaves a
    // phantom open movement, and reconcile would go looking for it on a chain
    // where it cannot possibly appear.
    const dir = await mkdtemp(join(tmpdir(), "bursar-settle-"));
    try {
      const path = join(dir, "ledger.jsonl");
      const ledger = new Ledger(path);
      await assert.rejects(
        () =>
          settle(
            { outcome: "pay", reason: "ok", intentId: "i", chainId: 84532, amount: "10000",
              payTo: ORACLE, asset: USDC, decimals: 6 },
            { url: "http://agent.test/entrypoints/x/invoke", input: {} },
            ledger,
            {} as never,
          ),
        SettlementError,
      );
      assert.equal((await ledger.all()).length, 0, "nothing should have been written");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
