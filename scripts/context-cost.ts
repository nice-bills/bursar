/**
 * What Bursar costs an agent's context, versus mounting KeeperHub directly.
 *
 * KeeperHub's MCP server exposes 44 tools. An agent that mounts them all pays
 * for every definition in every prompt, before it has done anything. And one of
 * those tools, `list_action_schemas`, answers with hundreds of kilobytes — a
 * single call would swamp the context it was supposed to inform.
 *
 * Anthropic's code-execution pattern for MCP is the alternative: treat the
 * server as an API that *code* calls, keep the traffic in the program, and
 * surface only a small, task-shaped set of tools to the model. That is what
 * Bursar is. It mounts six treasury actions; everything else — schema lookup,
 * spending limits, workflow authoring, execution polling — happens in
 * `src/keeperhub/`, where a 666KB schema dump costs the model nothing.
 *
 * This script measures that rather than asserting it.
 *
 *   npm run context-cost
 */

import "dotenv/config";

import { KeeperHubMcp } from "../src/keeperhub/mcp.js";
import { treasuryActions } from "../src/eliza/actions.js";
import { treasuryProvider } from "../src/eliza/provider.js";

/**
 * Tokens are roughly four characters of English or JSON. Good enough to
 * compare two things that differ by orders of magnitude; not a billing figure.
 */
function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function row(label: string, chars: number, note = ""): void {
  const t = tokens(String(chars === 0 ? "" : "x".repeat(chars)));
  console.log(
    `  ${label.padEnd(42)} ${String(chars).padStart(9)} chars  ~${String(t).padStart(7)} tokens  ${note}`,
  );
}

async function main(): Promise<void> {
  const apiKey = process.env.KEEPERHUB_API_KEY;
  if (!apiKey) {
    console.error("KEEPERHUB_API_KEY is not set.");
    process.exit(1);
  }

  const mcp = new KeeperHubMcp(apiKey);

  console.log("\nMounting KeeperHub's MCP server directly into an agent");
  console.log("─".repeat(96));

  const raw = (await mcp.listTools()) as Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
  }>;
  const allDefs = JSON.stringify(raw);
  row(`${raw.length} tool definitions`, allDefs.length, "in every prompt, always");

  const schemas = JSON.stringify(await mcp.listActionSchemas());
  row("one list_action_schemas response", schemas.length, "per call, into context");

  console.log("\nMounting plugin-bursar instead");
  console.log("─".repeat(96));

  // What the model actually sees: names, descriptions, examples, and the
  // provider text that gets composed into state.
  const actionSurface = JSON.stringify(
    treasuryActions.map((a) => ({
      name: a.name,
      similes: a.similes,
      description: a.description,
      examples: a.examples,
    })),
  );
  row(`${treasuryActions.length} treasury actions`, actionSurface.length, "in every prompt");

  const providerSurface = JSON.stringify({
    name: treasuryProvider.name,
    description: treasuryProvider.description,
  });
  row("1 provider declaration", providerSurface.length, "plus ~300 chars of live state");

  // The same schema lookup, done in code and filtered to the one answer needed.
  const oneSchema = JSON.stringify(await mcp.findAction("web3/check-balance"));
  row("one schema, looked up in code", oneSchema.length, "what a lookup actually costs");

  console.log("\nSummary");
  console.log("─".repeat(96));
  const mountedAlways = allDefs.length;
  const bursarAlways = actionSurface.length + providerSurface.length;
  console.log(
    `  Always-resident surface:   ${tokens(allDefs)} tokens mounted vs ${tokens(
      String("x".repeat(bursarAlways)),
    )} tokens with Bursar  ` + `(${(mountedAlways / bursarAlways).toFixed(1)}x smaller)`,
  );
  console.log(
    `  One schema lookup:         ${tokens(schemas)} tokens through the model vs ` +
      `${tokens(oneSchema)} tokens  (${(schemas.length / Math.max(oneSchema.length, 1)).toFixed(0)}x smaller)`,
  );
  console.log(
    "\n  The 44 tools are still reachable — Bursar calls them. They are just not\n" +
      "  in the prompt, and neither is the traffic between them.\n",
  );
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
