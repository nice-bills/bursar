/**
 * Day-1 de-risk: prove we can authenticate, read the org wallet, and execute a
 * real transaction through KeeperHub.
 *
 * Read-only by default. It only moves value when you pass --execute, because
 * everything after step 3 spends real funds:
 *
 *   npm run smoke              # auth + wallet + chains, no value moved
 *   npm run smoke -- --execute # also sends BURSAR_SMOKE_AMOUNT to BURSAR_SMOKE_TO
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { KeeperHubClient, KeeperHubError, isSuccess } from "../src/keeperhub/client.js";

const EXECUTE = process.argv.includes("--execute");

async function main(): Promise<void> {
  const apiKey = process.env.KEEPERHUB_API_KEY;
  if (!apiKey) {
    fail(
      "KEEPERHUB_API_KEY is not set.\n" +
        "  1. Sign in at https://app.keeperhub.com\n" +
        "  2. Avatar menu -> API Keys -> create an organization key\n" +
        "  3. cp .env.example .env and paste it in",
    );
  }

  const client = new KeeperHubClient({
    apiKey,
    baseUrl: process.env.KEEPERHUB_BASE_URL,
  });

  // 1. Auth ---------------------------------------------------------------
  step("Verifying API key");
  const keys = await client.verifyKey();
  ok("Key accepted");
  detail(keys);

  // 2. Wallet -------------------------------------------------------------
  step("Reading org signer wallet");
  const wallet = await client.getWallet();
  ok("Wallet retrieved");
  detail(wallet);

  // 3. Chains -------------------------------------------------------------
  step("Listing supported chains");
  const chains = await client.listChains();
  ok("Chains retrieved");
  detail(chains);

  if (!EXECUTE) {
    console.log(
      "\nRead-only checks passed. Re-run with --execute to send a real transaction.\n" +
        "Make sure BURSAR_SMOKE_TO and BURSAR_SMOKE_AMOUNT are set, and that the\n" +
        "signer above holds funds on BURSAR_CHAIN_ID.",
    );
    return;
  }

  // 4. Move value ---------------------------------------------------------
  const to = process.env.BURSAR_SMOKE_TO;
  const chainId = process.env.BURSAR_CHAIN_ID;
  const amount = process.env.BURSAR_SMOKE_AMOUNT ?? "1000000000000"; // 1e-6 native
  if (!to) fail("BURSAR_SMOKE_TO is not set — refusing to guess a recipient.");
  if (!chainId) fail("BURSAR_CHAIN_ID is not set.");

  step(`Transferring ${amount} base units to ${to} on chain ${chainId}`);

  // Stable key: a retry of *this* run must not double-send. A new run gets a
  // new key, which is what we want for a deliberate second transfer.
  const idempotencyKey = `smoke-${randomUUID()}`;

  const execution = await client.transfer(
    { chainId, to, amount, tokenAddress: process.env.BURSAR_SMOKE_TOKEN },
    idempotencyKey,
  );

  ok(`Submitted, execution ${execution.executionId} (${execution.status})`);

  const final = execution.executionId
    ? await client.awaitExecution(execution.executionId)
    : execution;

  if (isSuccess(final.status)) {
    ok(`Execution ${final.status}`);
  } else {
    console.error(`\n  Execution finished as: ${final.status}`);
  }

  if (final.transactionHashes.length > 0) {
    console.log("\n  Transaction hashes (this is the hackathon deliverable):");
    for (const hash of final.transactionHashes) console.log(`    ${hash}`);
  } else {
    console.warn("\n  No transaction hash returned — inspect the raw payload below.");
    detail(final.raw);
  }
}

// --- Output helpers -------------------------------------------------------

function step(message: string): void {
  console.log(`\n> ${message}`);
}

function ok(message: string): void {
  console.log(`  ✓ ${message}`);
}

function detail(value: unknown): void {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  const lines = text.split("\n");
  const shown = lines.slice(0, 30);
  for (const line of shown) console.log(`    ${line}`);
  if (lines.length > shown.length) console.log(`    ... (${lines.length - shown.length} more)`);
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

main().catch((error: unknown) => {
  if (error instanceof KeeperHubError) {
    console.error(`\n✗ ${error.message}`);
    if (error.requestId) console.error(`  request id: ${error.requestId}`);
    console.error(`  body: ${JSON.stringify(error.body, null, 2)}`);
  } else {
    console.error(`\n✗ ${error instanceof Error ? error.stack : String(error)}`);
  }
  process.exit(1);
});
