/**
 * Discover a Lucid Agent, call it, and let the treasury decide about the bill.
 *
 *   npm run lucid                      # against http://localhost:4021
 *   npm run lucid -- --url https://... # against any agent card
 *
 * This is the connector KeeperHub's issue #2329 describes, driven end to end:
 *
 *   1. read /.well-known/agent-card.json and list what is on offer
 *   2. call a free entrypoint, proving the transport works before money enters
 *   3. call a priced one, and get the 402 quote instead of a result
 *   4. hand that quote to Bursar's policy engine
 *
 * Step 4 is the point. Their issue protects the money with a low-balance payer
 * key and a per-call price cap; this asks the questions a cap cannot — who is
 * being paid, how much has gone out today, what it is worth across assets, and
 * whether a person should see it first.
 */

import "dotenv/config";

import { loadConfig } from "../src/config.js";
import { Ledger } from "../src/ledger/store.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { Valuation } from "../src/treasury/valuation.js";
import { KeeperHubClient } from "../src/keeperhub/client.js";
import { KeeperHubMcp } from "../src/keeperhub/mcp.js";
import { LucidAgent, LucidError } from "../src/lucid/client.js";
import { planPayment } from "../src/lucid/pay.js";
import { settle, payerConfigured, payerAddress, SettlementError } from "../src/lucid/settle.js";

/**
 * Relax the price-staleness bound for this run only.
 *
 * Testnet Chainlink feeds publish rarely — the Base Sepolia USDC/USD feed can
 * sit a day between updates — so the production bound of an hour refuses every
 * valuation against them. That refusal is correct and worth seeing, which is
 * why it is the default here; this flag exists so the rest of the flow can be
 * demonstrated too, without editing the bound that protects real money.
 */
const ageIndex = process.argv.indexOf("--max-price-age");
const MAX_PRICE_AGE = ageIndex >= 0 ? readPositiveInt("--max-price-age", process.argv[ageIndex + 1]) : undefined;

/**
 * Parse a flag that loosens a money guard, or stop.
 *
 * `Number(undefined)` is `NaN`, `NaN` is not nullish so it wins the `??` that
 * falls back to the configured bound, and every `age > NaN` comparison is
 * false — so a mistyped flag silently switched the staleness check off on a
 * path that signs payments.
 */
function readPositiveInt(flag: string, raw: string | undefined): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value <= 0) {
    console.error(`${flag} needs a positive whole number of seconds, got ${raw ?? "nothing"}.`);
    process.exit(1);
  }
  return value;
}

/** Actually pay, rather than stopping at the decision. */
const SETTLE = process.argv.includes("--settle");

const urlIndex = process.argv.indexOf("--url");
const AGENT_URL = urlIndex >= 0 ? readUrl(process.argv[urlIndex + 1]) : (process.env.LUCID_AGENT_URL ?? "http://localhost:4021");

/** `--url` with nothing after it used to sail through a `!` and fail deep inside. */
function readUrl(raw: string | undefined): string {
  if (!raw || !/^https?:\/\//i.test(raw)) {
    console.error(`--url needs an http(s) URL, got ${raw ?? "nothing"}.`);
    process.exit(1);
  }
  return raw;
}

/** Counterparty-supplied text, reduced to a short plain label. */
const safeLabel = (raw: string): string =>
  raw.replace(/[\r\n]+/g, " ").replace(/[^\w .,:@/-]/g, "").trim().slice(0, 64) || "unnamed agent";

const rule = (title: string): void => {
  console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);
};

async function main(): Promise<void> {
  const agent = new LucidAgent(AGENT_URL);

  // 1 ─ discovery
  rule(`1. DISCOVER — ${AGENT_URL}/.well-known/agent-card.json`);
  const card = await agent.discover();
  console.log(`   ${card.name}${card.version ? ` v${card.version}` : ""}`);
  if (card.description) console.log(`   ${card.description}`);
  if (card.extensions.length > 0) {
    console.log(`   extensions: ${card.extensions.join(", ")}`);
  }
  console.log(`\n   entrypoints:`);
  for (const entry of card.entrypoints) {
    const price = entry.priced
      ? `${entry.priceAmount ?? "?"}${entry.priceAsset ? ` of ${entry.priceAsset}` : ""}`
      : "free";
    console.log(`     ${entry.key.padEnd(22)} ${price}`);
    if (entry.description) console.log(`       ${entry.description}`);
  }

  const free = card.entrypoints.find((e) => !e.priced);
  const paid = card.entrypoints.find((e) => e.priced);

  // 2 ─ the free call, so a transport fault cannot masquerade as a payment problem
  if (free) {
    rule(`2. INVOKE (free) — ${free.key}`);
    const outcome = await agent.invoke(free.key, {});
    console.log(`   ${JSON.stringify(outcome.output)}`);
  }

  if (!paid) {
    console.log("\nNo priced entrypoint on this agent — nothing for policy to decide.");
    return;
  }

  // 3 ─ the priced call, which answers with terms rather than a result
  rule(`3. INVOKE (priced) — ${paid.key}`);
  const outcome = await agent.invoke(paid.key, {
    address: "0x8d9abc5b07917229159886be02e5eed1dc7fbdc9",
  });

  if (!outcome.challenge) {
    console.log(`   answered without asking for payment: ${JSON.stringify(outcome.output)}`);
    return;
  }

  const c = outcome.challenge;
  console.log(`   HTTP ${outcome.status} — the agent wants paying first`);
  console.log(`     amount : ${c.maxAmountRequired ?? "(unstated)"}`);
  console.log(`     asset  : ${c.asset ?? "(unstated)"}`);
  console.log(`     network: ${c.network ?? "(unstated)"}`);
  console.log(`     payTo  : ${c.payTo ?? "(unstated)"}`);

  // 4 ─ the treasury's decision
  rule("4. POLICY — what Bursar makes of that bill");
  const config = await loadConfig(process.env.BURSAR_CONFIG_PATH ?? "bursar.config.json");
  const ledger = new Ledger(process.env.BURSAR_LEDGER_PATH ?? "data/ledger.jsonl");

  // The platform cap and price feeds are read the same way every other movement
  // reads them, so this decision is not a special case with softer rules.
  const apiKey = process.env.KEEPERHUB_API_KEY;
  const client = apiKey
    ? new KeeperHubClient({ apiKey, baseUrl: process.env.KEEPERHUB_BASE_URL })
    : null;
  const mcp = apiKey ? new KeeperHubMcp(apiKey, process.env.KEEPERHUB_MCP_URL) : null;

  const maxAge = MAX_PRICE_AGE ?? config.policy.maxPriceAgeSeconds;
  if (MAX_PRICE_AGE !== undefined) {
    console.log(`   (price staleness bound relaxed to ${MAX_PRICE_AGE}s for this run)`);
  }

  const policy = new PolicyEngine(
    config,
    ledger,
    mcp ? () => mcp.getSpendingLimits() : undefined,
    client ? new Valuation(client, 60_000, maxAge) : undefined,
  );

  const invokeUrl = `${AGENT_URL.replace(/\/+$/, "")}/entrypoints/${encodeURIComponent(paid.key)}/invoke`;

  const plan = await planPayment(outcome.challenge, {
    policy,
    ledger,
    config,
    // The card is written by the counterparty. It ends up in the ledger and
    // from there in the agent's context, so it is trimmed to something that
    // reads as a label rather than as instructions.
    memo: `${paid.key} from ${safeLabel(card.name)}`,
    url: invokeUrl,
  });

  const mark = plan.outcome === "pay" ? "✓" : plan.outcome === "hold" ? "⏸" : "✗";
  console.log(`   ${mark} ${plan.outcome.toUpperCase()} — ${plan.reason}`);
  if (plan.priced) console.log(`     price  : ${plan.priced}`);
  if (plan.intentId) console.log(`     intent : ${plan.intentId}`);

  if (plan.outcome !== "pay") {
    console.log(
      plan.outcome === "hold"
        ? "\n   Held for a person. Nothing has been sent and nothing will be\n" +
            "   without a decision — the queue is in `npm run demo`'s pending list."
        : "\n   Refused. The agent does not get to talk the treasury past this.",
    );
    return;
  }

  if (!SETTLE) {
    console.log(
      "\n   Policy cleared it. Re-run with --settle to sign the challenge and pay.\n" +
        (payerConfigured()
          ? `   Payer: ${payerAddress()}`
          : "   (set BURSAR_PAYER_PRIVATE_KEY first — a testnet key, funded with\n" +
            "    Base Sepolia USDC and a little ETH for gas)"),
    );
    return;
  }

  // 5 ─ settlement, which only ever runs on a plan the engine approved
  rule("5. SETTLE — signing the challenge and retrying");
  console.log(`   payer: ${payerAddress() ?? "(none)"}`);

  const result = await settle(
    plan,
    {
      url: invokeUrl,
      input: { address: "0x8d9abc5b07917229159886be02e5eed1dc7fbdc9" },
    },
    ledger,
  );

  if (result.paid) {
    console.log(`   ✓ paid — the agent answered:`);
    console.log(`     ${JSON.stringify(result.output)}`);
    if (result.receipt) console.log(`     receipt: ${result.receipt.slice(0, 120)}`);
    console.log(`\n   Recorded as a purchase against the day's caps.`);
  } else {
    console.log(`   ✗ not paid — ${result.error}`);
    console.log(
      `\n   The intent stays open rather than being closed, because we cannot\n` +
        `   tell from here whether the payment landed. That is what reconcile is for.`,
    );
  }
}

main().catch((error: unknown) => {
  if (error instanceof SettlementError) {
    console.error(`\n✗ ${error.message}`);
  } else if (error instanceof LucidError) {
    console.error(`\n✗ ${error.message}`);
    if (error.body) console.error(`  ${JSON.stringify(error.body).slice(0, 400)}`);
    console.error(
      `\n  Is the counterparty agent running?\n` +
        `    cd examples/lucid-agent && npm install && npm start`,
    );
  } else {
    console.error(`\n✗ ${error instanceof Error ? error.stack : String(error)}`);
  }
  process.exit(1);
});
