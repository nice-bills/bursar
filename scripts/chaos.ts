/**
 * Chaos: break the treasury on purpose and check it tells the truth afterwards.
 *
 * The reliability claims in the README are only worth what they survive. Each
 * scenario induces a real failure and asserts the recovery, against the live
 * API where money is involved.
 *
 *   npm run chaos              # offline scenarios only
 *   npm run chaos -- --execute # also the two that move real value
 */

import "dotenv/config";
import { mkdtemp, rm, writeFile, appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, configSchema } from "../src/config.js";
import { KeeperHubClient } from "../src/keeperhub/client.js";
import { Ledger, dailyPeriod } from "../src/ledger/store.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { Executor } from "../src/treasury/executor.js";
import { NATIVE_DECIMALS, formatUnits } from "../src/units.js";
import { nativeBalanceWorkflow, readBalanceOutput } from "../src/treasury/workflows.js";

const EXECUTE = process.argv.includes("--execute");

let passed = 0;
let failed = 0;

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`\n▸ ${name}\n`);
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

async function tempLedger(): Promise<{ ledger: Ledger; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bursar-chaos-"));
  return { ledger: new Ledger(join(dir, "ledger.jsonl")), dir };
}

async function main(): Promise<void> {
  const config = await loadConfig(process.env.BURSAR_CONFIG_PATH ?? "bursar.config.json");
  const apiKey = process.env.KEEPERHUB_API_KEY;

  // --- 1. A torn ledger line ------------------------------------------------
  await scenario("Ledger survives a half-written final line (hard kill mid-append)", async () => {
    const { ledger, dir } = await tempLedger();
    try {
      await ledger.append({
        intentId: "good-1", status: "confirmed", leg: "payout", chainId: 1,
        to: `0x${"1".repeat(40)}`, amount: "100", token: null, decimals: 18, memo: "intact",
      });
      // Simulate the process dying mid-write: a truncated JSON line.
      await appendFile(join(dir, "ledger.jsonl"), '{"intentId":"torn","stat', "utf8");

      const all = await ledger.all();
      check(all.length === 1, "reads the intact entry and skips the torn one");
      check(all[0]?.intentId === "good-1", "the surviving entry is the right one");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // --- 2. Unreconciled work blocks new spending -----------------------------
  await scenario("An unresolved movement locks the treasury", async () => {
    const { ledger, dir } = await tempLedger();
    try {
      await ledger.append({
        intentId: "stuck", status: "submitted", leg: "payout", chainId: config.treasury.chainId,
        to: config.contributors[0]!.address, amount: "1000", token: null, decimals: 18,
        memo: "crashed before we learned the outcome",
      });

      const decision = await new PolicyEngine(config, ledger).evaluate({
        leg: "payout", chainId: config.treasury.chainId, to: config.contributors[0]!.address,
        amount: "1000", token: null, decimals: 18, memo: "next payout",
      });

      check(decision.verdict === "deny", "further movement is denied");
      check(
        decision.verdict === "deny" && /unreconciled/.test(decision.reason),
        "the reason names the unreconciled movement",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // --- 3. In-flight money counts against the daily cap ----------------------
  await scenario("An in-flight transfer still counts against the daily cap", async () => {
    const { ledger, dir } = await tempLedger();
    try {
      const tight = configSchema.parse({
        treasury: { chainId: 999 },
        contributors: config.contributors,
        policy: { maxPerTransfer: "1000", maxPerDay: "1500" },
      });
      // Submitted, never confirmed: the money may already be gone.
      await ledger.append({
        intentId: "inflight", status: "submitted", leg: "payout", chainId: 999,
        to: config.contributors[0]!.address, amount: "1000", token: null, decimals: 18, memo: "in flight",
      });

      const decision = await new PolicyEngine(tight, ledger).evaluate({
        leg: "payout", chainId: 998, to: config.contributors[0]!.address,
        amount: "1000", token: null, decimals: 18, memo: "second",
      });
      check(decision.verdict === "deny", "the second movement is denied");
      check(
        decision.verdict === "deny" && /maxPerDay/.test(decision.reason),
        "denied by the daily cap, not merely by the chain lock",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // --- 4. Malformed config is rejected with a usable message ----------------
  await scenario("A malformed treasury config is refused at load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bursar-chaos-cfg-"));
    try {
      const path = join(dir, "bad.json");
      await writeFile(
        path,
        JSON.stringify({
          treasury: { chainId: 1 },
          contributors: [{ name: "a", address: `0x${"1".repeat(40)}`, shareBps: 7000 }],
          policy: { maxPerTransfer: "100", maxPerDay: "10" },
        }),
        "utf8",
      );

      let message = "";
      try {
        await loadConfig(path);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      check(message.length > 0, "load fails rather than running with bad rules");
      check(/10000/.test(message), "it names the share total problem");
      check(/maxPerTransfer/.test(message), "and the impossible cap, in the same report");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  if (!EXECUTE || !apiKey) {
    summary();
    if (!apiKey) console.log("\n(KEEPERHUB_API_KEY unset — live scenarios skipped)");
    else console.log("\n(Re-run with --execute for the two scenarios that move real value)");
    return;
  }

  const client = new KeeperHubClient({ apiKey, baseUrl: process.env.KEEPERHUB_BASE_URL });
  const amount = "700000000000"; // 0.0000007 ETH
  const recipient = config.contributors[0]!.address;

  // --- 5. Crash BEFORE the transfer ran -------------------------------------
  await scenario("Crash before submitting: reconcile completes the approved movement", async () => {
    const { ledger, dir } = await tempLedger();
    try {
      const executor = new Executor(client, ledger, new PolicyEngine(config, ledger), config);
      const intentId = Ledger.intentId({
        leg: "payout", chainId: config.treasury.chainId, to: recipient,
        amount, token: null, period: `chaos-a-${Date.now()}`,
      });

      // The process wrote its intent, then died before calling KeeperHub.
      await ledger.append({
        intentId, status: "intent", leg: "payout", chainId: config.treasury.chainId,
        to: recipient, amount, token: null, decimals: NATIVE_DECIMALS, memo: "died before submit",
      });

      const result = await executor.reconcile();
      check(result.resolved === 1, "the open intent is resolved");
      check(result.stillOpen === 0, "nothing is left hanging");

      const entry = (await ledger.latestByIntent()).get(intentId);
      check(entry?.status === "confirmed", "it is now confirmed");
      check((entry?.transactionHashes?.length ?? 0) > 0, "and carries a real transaction hash");
      console.log(`    ${entry?.transactionLinks?.[0] ?? entry?.transactionHashes?.[0]}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // --- 6. Crash AFTER the transfer ran --------------------------------------
  await scenario("Crash after submitting: reconcile recovers the ORIGINAL transaction", async () => {
    const { ledger, dir } = await tempLedger();
    try {
      const executor = new Executor(client, ledger, new PolicyEngine(config, ledger), config);
      const intentId = Ledger.intentId({
        leg: "payout", chainId: config.treasury.chainId, to: recipient,
        amount, token: null, period: `chaos-b-${Date.now()}`,
      });

      // The transfer really happens...
      const real = await client.transfer(
        {
          chainId: String(config.treasury.chainId),
          recipientAddress: recipient,
          amount: formatUnits(BigInt(amount), NATIVE_DECIMALS),
        },
        intentId,
      );
      const originalHash = real.transactionHashes[0];
      console.log(`    original tx: ${originalHash}`);

      // ...but the process died before it could record the outcome.
      await ledger.append({
        intentId, status: "submitted", leg: "payout", chainId: config.treasury.chainId,
        to: recipient, amount, token: null, decimals: NATIVE_DECIMALS,
        memo: "died after submit, outcome unknown",
      });

      const result = await executor.reconcile();
      check(result.resolved === 1, "the open intent is resolved");

      const entry = (await ledger.latestByIntent()).get(intentId);
      check(entry?.status === "confirmed", "it is now confirmed");
      check(
        entry?.transactionHashes?.[0] === originalHash,
        "recovered the ORIGINAL hash — no second transaction was sent",
      );
      console.log(`    recovered  : ${entry?.transactionHashes?.[0]}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // --- 7. The float top-up branch ------------------------------------------
  await scenario("A balance below the floor actually triggers a top-up", async () => {
    const { ledger, dir } = await tempLedger();
    try {
      // The committed config keeps the floor below the real balance, so the
      // top-up branch never runs. Raise the floor above it here so the branch
      // is exercised for real. The float address is the org signer, so the
      // transfer is a self-transfer: it proves the path without moving value
      // anywhere it cannot come back from.
      const floor = "600000000000000000"; // 0.6 ETH, above the wallet's balance
      const target = "600001000000000000"; // top-up = 0.000001
      const raised = configSchema.parse({
        ...config,
        float: [{ ...config.float[0], minBalance: floor, targetBalance: target }],
      });

      const executor = new Executor(client, ledger, new PolicyEngine(raised, ledger), raised);
      const floatTarget = raised.float[0]!;

      // Upsert rather than create. Creating with a fresh key every run left
      // six identical "Bursar Float Monitor" workflows on the account before
      // this was caught.
      const workflow = nativeBalanceWorkflow(floatTarget.chainId, floatTarget.address);
      const existing = await client.listWorkflows();
      const rows = (Array.isArray(existing) ? existing : []) as Array<{ id: string; name: string }>;
      const found = rows.find((r) => r.name === workflow.name);
      const workflowId = found
        ? found.id
        : String(
            (
              (await client.createWorkflow(workflow, `chaos-float-${Date.now()}`)) as {
                id?: string;
              }
            )?.id ?? "",
          );

      const run = await client.executeWorkflow(workflowId, {}, `chaos-run-${Date.now()}`);
      const final = await client.awaitExecution(run.executionId);
      const reading = readBalanceOutput(final.output);

      check(reading !== null, "the monitor workflow returned a balance");
      if (!reading) return;

      const balance = BigInt(reading.balanceWei);
      check(balance < BigInt(floor), `balance ${reading.balance} is below the raised floor`);

      const amount = (BigInt(target) - BigInt(floor)).toString();
      const outcome = await executor.move(
        {
          leg: "float",
          chainId: floatTarget.chainId,
          to: floatTarget.address,
          amount,
          token: null,
          decimals: NATIVE_DECIMALS,
          memo: "chaos: forced top-up",
        },
        `chaos-float-${Date.now()}`,
      );

      // Report the outcome BEFORE asserting on it. check() throws, so putting
      // the diagnostic after it means the one run that needs explaining is the
      // one that never prints an explanation.
      if (outcome.result === "confirmed") {
        console.log(`    ${outcome.entry.transactionLinks?.[0] ?? outcome.transactionHashes[0]}`);
      } else if (outcome.result === "blocked") {
        console.log(`    blocked: ${outcome.reason}`);
      } else if (outcome.result === "failed") {
        console.log(`    failed: ${outcome.error}`);
      } else {
        console.log(`    ${outcome.result}: ${outcome.reason}`);
      }
      check(outcome.result === "confirmed", "the top-up executed onchain");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  summary();
}

function summary(): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
