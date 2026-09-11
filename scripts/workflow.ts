/**
 * Author the gas-float keeper on KeeperHub.
 *
 *   npm run workflow            # print the composed workflow, create nothing
 *   npm run workflow -- --create  # create it on the platform
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";

import { loadConfig } from "../src/config.js";
import { KeeperHubClient, KeeperHubError } from "../src/keeperhub/client.js";
import { gasFloatWorkflow } from "../src/treasury/workflows.js";

const CREATE = process.argv.includes("--create");
const RUN = process.argv.includes("--run");

async function main(): Promise<void> {
  const apiKey = process.env.KEEPERHUB_API_KEY;
  if (!apiKey) throw new Error("KEEPERHUB_API_KEY is not set.");

  const config = await loadConfig(process.env.BURSAR_CONFIG_PATH ?? "bursar.config.json");
  if (config.float.length === 0) {
    console.log("No float targets configured — nothing to author.");
    return;
  }

  const client = new KeeperHubClient({ apiKey, baseUrl: process.env.KEEPERHUB_BASE_URL });

  // Author by upsert. Re-running must not accumulate duplicates, and a
  // workflow that has executed cannot be deleted without destroying its
  // execution history — which is exactly the audit trail we rely on.
  const existing = await client.listWorkflows();
  const rows = (Array.isArray(existing) ? existing : []) as Array<{ id: string; name: string }>;
  const byName = new Map(rows.map((r) => [r.name, r.id]));

  for (const float of config.float) {
    const workflow = gasFloatWorkflow(float);
    console.log(`\n=== ${workflow.name} ===`);
    console.log(workflow.description);
    console.log(JSON.stringify(workflow, null, 2));

    if (!CREATE && !RUN) continue;

    const existingId = byName.get(workflow.name);
    let id: string;
    if (existingId) {
      await client.updateWorkflow(existingId, workflow, `wf-${randomUUID()}`);
      id = existingId;
      console.log(`\nupdated: ${id}`);
    } else {
      const created = await client.createWorkflow(workflow, `wf-${randomUUID()}`);
      id = (created as { id?: string })?.id ?? "";
      console.log(`\ncreated: ${id}`);
    }
    console.log(`view: https://app.keeperhub.com/workflows/${id}`);

    if (!RUN || !id) continue;

    console.log("\nexecuting...");
    const run = await client.executeWorkflow(id, {}, `run-${randomUUID()}`);
    const final = await client.awaitExecution(run.executionId);

    console.log(`  status: ${final.status}`);
    const out = final.output as Record<string, unknown> | null;
    if (out) console.log(`  output: ${JSON.stringify(out)}`);
    const error = (final.raw as { error?: string })?.error;
    if (error) console.log(`  error : ${error}`);
    for (const link of final.transactionLinks) console.log(`  tx    : ${link}`);
    if (final.transactionHashes.length === 0 && final.status === "success") {
      console.log("  (no transfer — the balance is above the floor, so the gate held)");
    }
  }

  if (!CREATE && !RUN) console.log("\nDry run. Re-run with --create to author, or --run to author and execute.");
}

main().catch((error: unknown) => {
  if (error instanceof KeeperHubError) {
    console.error(`\n✗ ${error.message}\n  ${JSON.stringify(error.body, null, 2)}`);
  } else {
    console.error(`\n✗ ${error instanceof Error ? error.stack : String(error)}`);
  }
  process.exit(1);
});
