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

async function main(): Promise<void> {
  const apiKey = process.env.KEEPERHUB_API_KEY;
  if (!apiKey) throw new Error("KEEPERHUB_API_KEY is not set.");

  const config = await loadConfig(process.env.BURSAR_CONFIG_PATH ?? "bursar.config.json");
  if (config.float.length === 0) {
    console.log("No float targets configured — nothing to author.");
    return;
  }

  const client = new KeeperHubClient({ apiKey, baseUrl: process.env.KEEPERHUB_BASE_URL });

  for (const float of config.float) {
    const workflow = gasFloatWorkflow(float);
    console.log(`\n=== ${workflow.name} ===`);
    console.log(workflow.description);
    console.log(JSON.stringify(workflow, null, 2));

    if (!CREATE) continue;

    const created = await client.createWorkflow(workflow, `wf-${randomUUID()}`);
    const id = (created as { id?: string })?.id ?? "(no id returned)";
    console.log(`\ncreated: ${id}`);
    console.log(`view: https://app.keeperhub.com/workflows/${id}`);
  }

  if (!CREATE) console.log("\nDry run. Re-run with --create to author these on KeeperHub.");
}

main().catch((error: unknown) => {
  if (error instanceof KeeperHubError) {
    console.error(`\n✗ ${error.message}\n  ${JSON.stringify(error.body, null, 2)}`);
  } else {
    console.error(`\n✗ ${error instanceof Error ? error.stack : String(error)}`);
  }
  process.exit(1);
});
