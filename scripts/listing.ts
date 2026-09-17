/**
 * Publish Bursar's service to the KeeperHub marketplace.
 *
 *   npm run listing              # compose it, write nothing
 *   npm run listing -- --probe   # ask the platform for the authoritative schemas
 *   npm run listing -- --publish # author the workflow and list it
 *   npm run listing -- --verify  # find it in the catalogue and call it as a stranger would
 *
 * `--probe` exists because the docs stop short of the two things this needs to
 * get exactly right: how a listing is priced, and how a caller's inputs reach
 * the workflow's nodes. The platform's own tool definitions answer both, so ask
 * them rather than guessing and discovering the mistake in the catalogue.
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";

import { KeeperHubClient, KeeperHubError } from "../src/keeperhub/client.js";
import { KeeperHubMcp } from "../src/keeperhub/mcp.js";
import {
  PREFLIGHT_SLUG,
  PREFLIGHT_CHAIN,
  PREFLIGHT_INPUT_SCHEMA,
  PREFLIGHT_OUTPUT_MAPPING,
  DEFAULT_GAS_RESERVE_WEI,
  payoutPreflightWorkflow,
} from "../src/marketplace/preflight.js";

const PROBE = process.argv.includes("--probe");
const PUBLISH = process.argv.includes("--publish");
const VERIFY = process.argv.includes("--verify");

/** What the service costs per call, in USDC. */
const PRICE_USDC = "0.01";

function show(label: string, value: unknown, limit = 2000): void {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  console.log(`\n--- ${label} ---`);
  console.log((text ?? "").slice(0, limit));
}

async function probe(mcp: KeeperHubMcp): Promise<void> {
  console.log("Asking the platform what it actually accepts.\n");

  for (const tool of ["list_workflow", "update_workflow_listing", "call_workflow"]) {
    const schema = await mcp.toolSchema(tool);
    show(`${tool} — advertised schema`, schema, 2600);
  }

  // The server documents itself; this is more current than the docs site.
  try {
    show("tools_documentation(list_workflow)", await mcp.toolsDocumentation("list_workflow"), 3000);
  } catch (error) {
    console.log(`\n(tools_documentation unavailable: ${(error as Error).message})`);
  }

  // A real listing, unabridged — the surest way to learn where a price lives is
  // to read one that already has a price.
  const catalogue = await mcp.searchWorkflows({ query: "pay USDC", sort: "recent" });
  show("search_workflows — a priced listing, raw", catalogue, 3000);
}

async function main(): Promise<void> {
  const apiKey = process.env.KEEPERHUB_API_KEY;
  if (!apiKey) throw new Error("KEEPERHUB_API_KEY is not set.");

  const mcp = new KeeperHubMcp(apiKey, process.env.KEEPERHUB_MCP_URL);
  const workflow = payoutPreflightWorkflow();

  if (PROBE) {
    await probe(mcp);
    return;
  }

  if (!PUBLISH && !VERIFY) {
    show("workflow", workflow, 4000);
    show("inputSchema", PREFLIGHT_INPUT_SCHEMA);
    console.log(`\nslug: ${PREFLIGHT_SLUG}`);
    console.log("\nDry run. --probe to read the platform's schemas, --publish to list it.");
    return;
  }

  const client = new KeeperHubClient({ apiKey, baseUrl: process.env.KEEPERHUB_BASE_URL });

  if (PUBLISH) {
    // Upsert by name, the same discipline the keeper workflows use: a workflow
    // that has executed carries its execution history, and that history is the
    // audit trail. Never replace what can be updated.
    const existing = (await client.listWorkflows()) as Array<{ id: string; name: string }>;
    const rows = Array.isArray(existing) ? existing : [];
    const found = rows.find((r) => r.name === workflow.name);

    let workflowId: string;
    if (found) {
      await client.updateWorkflow(found.id, workflow, `wf-${randomUUID()}`);
      workflowId = found.id;
      console.log(`updated workflow: ${workflowId}`);
    } else {
      const created = (await client.createWorkflow(workflow, `wf-${randomUUID()}`)) as {
        id?: string;
      };
      workflowId = created?.id ?? "";
      console.log(`created workflow: ${workflowId}`);
    }
    if (!workflowId) throw new Error("The platform returned no workflow id.");
    console.log(`view: https://app.keeperhub.com/workflows/${workflowId}`);

    // Price first, then publish. The platform refuses a price change while a
    // workflow is listed — "unlist first, update price, then re-list" — so
    // setting it before the listing exists is the only order that works on a
    // first publish, and re-running this on an already-listed workflow would
    // need the unlist step.
    let priced: unknown;
    try {
      priced = await mcp.updateWorkflowListing({
        workflowId,
        priceUsdcPerCall: PRICE_USDC,
        category: "defi",
        chain: PREFLIGHT_CHAIN,
        workflowType: "read",
        inputSchema: PREFLIGHT_INPUT_SCHEMA as unknown as Record<string, unknown>,
        outputMapping: PREFLIGHT_OUTPUT_MAPPING as unknown as Record<string, unknown>,
      });
    } catch (error) {
      // The workflow definition has already been updated at this point. Say so,
      // and say what to do — the failure mode this comment predicted used to
      // leave the operator with a half-applied publish and a raw stack trace.
      console.error(
        `\n✗ The workflow was updated, but pricing it failed.\n` +
          `  ${error instanceof Error ? error.message : String(error)}\n\n` +
          `  If it is already listed, the platform refuses a price change in place.\n` +
          `  Unlist it at https://app.keeperhub.com/workflows/${workflowId}, then re-run.`,
      );
      process.exit(1);
    }
    show(`priced at $${PRICE_USDC}/call`, priced, 600);

    const listed = await mcp.listWorkflow({
      workflowId,
      slug: PREFLIGHT_SLUG,
      category: "defi",
      chain: PREFLIGHT_CHAIN,
      workflowType: "read",
      inputSchema: PREFLIGHT_INPUT_SCHEMA as unknown as Record<string, unknown>,
      outputMapping: PREFLIGHT_OUTPUT_MAPPING as unknown as Record<string, unknown>,
    });
    show("list_workflow result", listed, 600);
  }

  if (VERIFY) {
    // Everything below is the view from outside: what another agent sees when
    // it goes looking, and what it is asked to pay.
    const catalogue = await mcp.searchWorkflows({ query: "payout preflight", sort: "recent" });
    const text = JSON.stringify(catalogue);
    console.log(
      text.includes(PREFLIGHT_SLUG)
        ? `\n✓ ${PREFLIGHT_SLUG} is in the catalogue.`
        : `\n✗ ${PREFLIGHT_SLUG} did not come back from search_workflows.`,
    );
    show("catalogue entry", catalogue, 2000);

    const outcome = await mcp.callWorkflow(PREFLIGHT_SLUG, {
      payer: "0x069C76420DD98cAfa97cc1D349BC1cC708284032",
      amountWei: "1000000000000000",
      gasReserveWei: DEFAULT_GAS_RESERVE_WEI,
    });

    if (outcome.challenge) {
      const c = outcome.challenge;
      console.log("\n✓ The listing demanded payment before doing the work.");
      console.log(`  price   : ${c.maxAmountRequired ?? "(see body)"} base units`);
      console.log(`  network : ${c.network ?? "(see body)"}`);
      console.log(`  asset   : ${c.asset ?? "(see body)"}`);
      console.log(`  payTo   : ${c.payTo ?? "(see body)"}`);
    } else {
      console.log("\n· No payment challenge — the listing is free as published.");
    }
    show("call_workflow response", outcome.text, 2000);
  }
}

main().catch((error: unknown) => {
  if (error instanceof KeeperHubError) {
    console.error(`\n✗ ${error.message}\n  ${JSON.stringify(error.body, null, 2)}`);
  } else {
    console.error(`\n✗ ${error instanceof Error ? error.stack : String(error)}`);
  }
  process.exit(1);
});
