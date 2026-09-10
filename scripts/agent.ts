/**
 * Bursar inside a real ElizaOS agent.
 *
 * Not the standalone harness: this boots an actual `AgentRuntime` with a real
 * database adapter and a real character, registers plugin-bursar the way a
 * user would, and then checks the three things that decide whether this is a
 * genuine integration or a library that happens to compile:
 *
 *   1. the runtime starts our Service and resolves it by type;
 *   2. `composeState` puts our provider's text into the agent's state, which
 *      is what the model actually reads;
 *   3. `processActions` dispatches our action and runs its handler.
 *
 * The model is a deterministic stub, because no model provider key is
 * configured and because the assertions above are about plugin wiring, not
 * about whether an LLM picks the right words. Point it at a real model plugin
 * and the same surfaces are exercised.
 *
 *   npm run agent              # boots the agent, moves nothing
 *   npm run agent -- --execute # lets the dispatched action pay for real
 */

import "dotenv/config";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  ChannelType,
  ElizaOS,
  stringToUuid,
  type Character,
  type Content,
  type IAgentRuntime,
  type Memory,
  type Service,
  type UUID,
} from "@elizaos/core";
import {
  plugin as sqlPlugin,
  createDatabaseAdapter,
  DatabaseMigrationService,
} from "@elizaos/plugin-sql";

import bursarPlugin, { BursarService } from "../src/index.js";
import { stubModelPlugin } from "../src/eliza/stub-model.js";

const EXECUTE = process.argv.includes("--execute");

let checks = 0;
let failures = 0;

function check(condition: boolean, message: string): void {
  checks++;
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failures++;
    console.error(`  ✗ ${message}`);
  }
}

/**
 * Wait for a service to come up.
 *
 * The runtime calls `registerService()` without awaiting it, so services start
 * asynchronously after plugin registration returns. There is no public
 * "services ready" signal, so poll for it rather than racing.
 */
async function waitForService<T extends Service>(
  runtime: IAgentRuntime,
  serviceType: string,
  timeoutMs = 15_000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const service = runtime.getService<T>(serviceType);
    if (service) return service;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function banner(title: string): void {
  console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);
}

const AGENT_NAME = "Bursar Demo Agent";

/**
 * The runtime derives its agent id from the character name. The database
 * adapter is constructed with an agent id too, and the two must agree — a
 * mismatch inserts the agent row under one id and then violates a foreign key
 * writing rooms under the other.
 */
const AGENT_ID = stringToUuid(AGENT_NAME);

const character: Character = {
  id: AGENT_ID,
  name: AGENT_NAME,
  bio: [
    "An autonomous agent that earns for its work and pays the people who built it.",
    "Runs its own treasury through KeeperHub.",
  ],
  plugins: [],
  settings: {},
};

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "bursar-agent-"));

  banner("1. Booting a real ElizaOS agent");

  // ElizaOS is the orchestrator the CLI uses: it runs database migrations and
  // brings the runtime up. Constructing AgentRuntime directly skips migrations
  // and fails on the first query.
  const eliza = new ElizaOS();
  let runtime: IAgentRuntime | undefined;

  // Migrate before the runtime starts.
  //
  // AgentRuntime.initialize() queries the `agents` table and only afterwards
  // runs plugin migrations, so against a brand-new database it asks for a
  // table that does not exist yet. Building the adapter and migrating first
  // sidesteps the ordering entirely, and is what a real deployment does anyway
  // — the database outlives any one agent process.
  const adapter = createDatabaseAdapter({ dataDir: join(dataDir, "db") }, AGENT_ID);
  await adapter.init();

  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(adapter.getDatabase());
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin, stubModelPlugin, bursarPlugin]);
  await migrations.runAllPluginMigrations();
  console.log("  database migrated");

  try {
    const runtimes = await eliza.addAgents(
      [
        {
          character,
          databaseAdapter: adapter,
          plugins: [sqlPlugin, stubModelPlugin, bursarPlugin],
          settings: {
            // pglite is used when no Postgres URL is configured.
            PGLITE_DATA_DIR: join(dataDir, "db"),
            KEEPERHUB_API_KEY: process.env.KEEPERHUB_API_KEY ?? "",
            KEEPERHUB_BASE_URL: process.env.KEEPERHUB_BASE_URL ?? "",
            BURSAR_CONFIG_PATH: process.env.BURSAR_CONFIG_PATH ?? "bursar.config.json",
            BURSAR_LEDGER_PATH: join(dataDir, "ledger.jsonl"),
          },
        },
      ],
      // autoStart registers plugins and brings the runtime up. Migrations are
      // already done, so skip the pass that would otherwise run too late.
      { returnRuntimes: true, autoStart: true, skipMigrations: true },
    );

    runtime = runtimes[0];
    if (!runtime) throw new Error("ElizaOS returned no runtime");
    console.log(`  agent: ${runtime.character.name} (${runtime.agentId})`);
    console.log(`  plugins: ${runtime.plugins.map((p) => p.name).join(", ")}`);

    // --- 2. The runtime owns our service ---------------------------------
    banner("2. The runtime started plugin-bursar's Service");

    const service = await waitForService<BursarService>(runtime, BursarService.serviceType);
    const registered = [...(runtime.services?.keys() ?? [])];
    console.log(`  services on runtime: ${registered.join(", ") || "(none)"}`);

    check(service !== undefined, "BursarService resolves by serviceType");
    check(
      runtime.actions.some((a) => a.name === "PAY_CONTRIBUTORS"),
      "PAY_CONTRIBUTORS is registered on the runtime",
    );
    check(
      runtime.providers.some((p) => p.name === "TREASURY"),
      "the TREASURY provider is registered on the runtime",
    );
    if (service) {
      console.log(
        `  contributors: ${service.treasuryConfig.contributors
          .map((c) => `${c.name} ${(c.shareBps / 100).toFixed(0)}%`)
          .join(", ")}`,
      );
    }

    // --- 3. Our provider reaches the agent's state -------------------------
    banner("3. composeState puts treasury state where the model reads it");

    const roomId = randomUUID() as UUID;
    const entityId = randomUUID() as UUID;

    const worldId = randomUUID() as UUID;
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId,
      worldName: "Bursar Harness",
      name: "operator",
      userName: "operator",
      source: "agent-harness",
      type: ChannelType.DM,
      channelId: roomId,
      messageServerId: randomUUID() as UUID,
    });

    const message: Memory = {
      id: randomUUID() as UUID,
      entityId,
      agentId: runtime.agentId,
      roomId,
      content: { text: "pay out 0.000002", source: "agent-harness" },
      createdAt: Date.now(),
    };
    await runtime.createMemory(message, "messages");

    const state = await runtime.composeState(message);
    const composed = `${state.text ?? ""}\n${JSON.stringify(state.values ?? {})}`;

    check(/Revenue splits/.test(composed), "the provider's text is composed into state");
    check(
      state.values?.treasuryLocked === false,
      "the agent can see the treasury is unlocked before it reasons",
    );

    const treasuryLine = (state.text ?? "")
      .split("\n")
      .find((line) => /Revenue splits/.test(line));
    if (treasuryLine) console.log(`  in prompt: ${treasuryLine.trim().slice(0, 160)}`);

    // --- 4. The runtime dispatches our action ------------------------------
    banner(
      EXECUTE
        ? "4. processActions runs PAY_CONTRIBUTORS — this moves real value"
        : "4. processActions dispatches PAY_CONTRIBUTORS (dry: no key, no spend)",
    );

    // This is the shape a model's reply takes: text plus the chosen actions.
    const response: Memory = {
      id: randomUUID() as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId,
      content: {
        text: "Paying the contributors their shares.",
        actions: ["PAY_CONTRIBUTORS"],
        source: "agent-harness",
      } as Content,
      createdAt: Date.now(),
    };
    await runtime.createMemory(response, "messages");

    let dispatched = false;
    const replies: string[] = [];

    if (!EXECUTE) {
      // Prove dispatch without spending: validate() is what the runtime uses
      // to decide whether an action is even eligible.
      const action = runtime.actions.find((a) => a.name === "PAY_CONTRIBUTORS");
      const eligible = await action?.validate(runtime, message, state);
      check(eligible === true, "the runtime finds PAY_CONTRIBUTORS eligible for this message");
      check(
        (await runtime.actions
          .find((a) => a.name === "PAY_CONTRIBUTORS")
          ?.validate(runtime, { ...message, content: { text: "hello" } }, state)) === false,
        "and ineligible for a message naming no amount",
      );
    } else {
      await runtime.processActions(message, [response], state, async (content) => {
        dispatched = true;
        const text = String(content.text ?? "");
        replies.push(text);
        for (const line of text.split("\n")) console.log(`  │ ${line}`);
        return [];
      });
      check(dispatched, "the action handler ran and produced a reply");
      check(
        replies.some((r) => /paid|already paid|blocked/i.test(r)),
        "the reply reports the payout outcome",
      );
    }

    banner(`${checks - failures}/${checks} checks passed`);
    if (failures > 0) process.exitCode = 1;
    if (!EXECUTE) {
      console.log("  Re-run with --execute to let the dispatched action pay for real.");
    }
  } finally {
    await eliza.stopAgents().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  // Drizzle wraps the real database error; without unwrapping, a foreign key
  // violation reads as an opaque "Failed query".
  let cause: unknown = (error as { cause?: unknown })?.cause;
  let depth = 0;
  while (cause && depth++ < 5) {
    console.error(`  caused by: ${cause instanceof Error ? cause.message : String(cause)}`);
    cause = (cause as { cause?: unknown })?.cause;
  }
  process.exit(1);
});
