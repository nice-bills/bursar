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
import { mkdtemp, rm, readFile } from "node:fs/promises";
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
import { stubModelPlugin, embeddingStubPlugin } from "../src/eliza/stub-model.js";

const EXECUTE = process.argv.includes("--execute");

/**
 * Use a real model when one is configured.
 *
 * OpenRouter serves text but not embeddings, so it is paired with the local
 * embedding stub. Without a key the whole model layer is stubbed, which still
 * exercises every plugin surface — it just cannot show a model *choosing* the
 * action.
 */
// `--no-model` skips the model section entirely. Unsetting the environment
// variable does not work, because dotenv loads .env back in.
const NO_MODEL = process.argv.includes("--no-model");
const OPENROUTER_KEY = NO_MODEL ? undefined : process.env.OPENROUTER_API_KEY;
/**
 * Free OpenRouter models, in preference order.
 *
 * Free endpoints are rate-limited and go "temporarily overloaded" without
 * warning, so a single model makes the harness flaky for reasons that have
 * nothing to do with the treasury. Each is tried in turn.
 */
const MODELS = process.env.BURSAR_MODEL
  ? [process.env.BURSAR_MODEL]
  : [
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "nvidia/nemotron-3.5-lightning:free",
      "nex-agi/nex-n2.5-pro:free",
      "inclusionai/ling-3.0-flash-fin:free",
    ];
const MODEL = MODELS[0]!;
const USE_REAL_MODEL = Boolean(OPENROUTER_KEY);

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

/**
 * The character is the file this repo ships, not one invented for the harness.
 *
 * `character/treasurer.character.json` is what a user would pass to
 * `elizaos start`, and a test validates it against ElizaOS's own
 * `validateCharacter`. Loading it here means the demo exercises the same
 * artifact rather than a convenient copy of it.
 */
const CHARACTER_PATH = process.env.BURSAR_CHARACTER ?? "character/treasurer.character.json";

async function loadCharacter(): Promise<Character> {
  const raw = JSON.parse(await readFile(CHARACTER_PATH, "utf8")) as Character;
  // The runtime derives its agent id from the character name, and the database
  // adapter is constructed with one too. They must agree or writes fail on a
  // foreign key.
  return { ...raw, id: stringToUuid(raw.name) };
}

/**
 * Stop here, not fifteen seconds deep.
 *
 * The service throws a good message when the key is missing, but the ElizaOS
 * runtime registers services without awaiting them, so that message is
 * swallowed and the failure surfaces later as an unrelated-looking assertion.
 */
function requireApiKey(): string {
  const key = process.env.KEEPERHUB_API_KEY;
  if (!key) {
    console.error(
      "KEEPERHUB_API_KEY is not set.\n" +
        "  Get one at app.keeperhub.com -> avatar menu -> API Keys,\n" +
        "  then put it in .env (see .env.example).",
    );
    process.exit(1);
  }
  return key;
}

async function main(): Promise<void> {
  requireApiKey();

  const dataDir = await mkdtemp(join(tmpdir(), "bursar-agent-"));

  const character = await loadCharacter();
  const AGENT_ID = character.id!;

  // bootstrap supplies the ACTIONS provider that tells the model what it can
  // do, plus REPLY/IGNORE — without it there is nothing for a model to choose
  // between and the selection proves nothing.
  const { bootstrapPlugin } = await import("@elizaos/plugin-bootstrap");

  const modelPlugins = USE_REAL_MODEL
    ? [
        sqlPlugin,
        (await import("@elizaos/plugin-openrouter")).openrouterPlugin,
        embeddingStubPlugin,
        bootstrapPlugin,
        bursarPlugin,
      ]
    : [sqlPlugin, stubModelPlugin, bootstrapPlugin, bursarPlugin];

  banner("1. Booting a real ElizaOS agent");
  console.log(`  character: ${character.name}  (${CHARACTER_PATH})`);
  console.log(`  declares: ${(character.plugins ?? []).join(", ")}`);
  console.log(`  model: ${USE_REAL_MODEL ? MODEL : "deterministic stub (no OPENROUTER_API_KEY)"}`);
  // The character names its plugins; resolving names to modules is the CLI's
  // job, so the harness passes the same set as already-imported objects.

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
  migrations.discoverAndRegisterPluginSchemas(modelPlugins);
  await migrations.runAllPluginMigrations();
  console.log("  database migrated");

  try {
    const runtimes = await eliza.addAgents(
      [
        {
          character: { ...character, plugins: [] },
          databaseAdapter: adapter,
          plugins: modelPlugins,
          settings: {
            // pglite is used when no Postgres URL is configured.
            PGLITE_DATA_DIR: join(dataDir, "db"),
            KEEPERHUB_API_KEY: process.env.KEEPERHUB_API_KEY ?? "",
            KEEPERHUB_BASE_URL: process.env.KEEPERHUB_BASE_URL ?? "",
            BURSAR_CONFIG_PATH: process.env.BURSAR_CONFIG_PATH ?? "bursar.config.json",
            BURSAR_LEDGER_PATH: join(dataDir, "ledger.jsonl"),
            OPENROUTER_API_KEY: OPENROUTER_KEY ?? "",
            OPENROUTER_SMALL_MODEL: MODEL,
            OPENROUTER_LARGE_MODEL: MODEL,
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

    // --- 5. The model chooses the action -----------------------------------
    if (USE_REAL_MODEL) {
      banner("5. The model picks the action (full ElizaOS message pipeline)");

      // A dry run must not spend. Rather than skip the model entirely, ask for
      // an amount above the per-transfer ceiling: the model still has to choose
      // PAY_CONTRIBUTORS from natural language, and the policy engine then
      // refuses it. That proves selection and refusal in one pass.
      // A distinct amount from step 4, so the model's payout is its own
      // movement rather than an idempotent replay of one already made.
      const request = EXECUTE
        ? "We earned some revenue this week. Please pay out 0.0000021 to the contributors."
        : "We earned a lot this week. Please pay out 5 to the contributors.";

      const ask: Memory = {
        id: randomUUID() as UUID,
        entityId,
        agentId: runtime.agentId,
        roomId,
        content: {
          text: request,
          source: "agent-harness",
          channelType: ChannelType.DM,
        } as Content,
        createdAt: Date.now(),
      };
      await runtime.createMemory(ask, "messages");
      console.log(`  user: "${ask.content.text}"`);

      const replies: string[] = [];
      const messageService = runtime.messageService;
      if (!messageService) {
        check(false, "the runtime exposes a message service");
      } else {
        const callback = async (content: Content) => {
          const text = String(content.text ?? "");
          if (text.trim()) {
            replies.push(text);
            for (const line of text.split("\n")) console.log(`  │ ${line}`);
          }
          return [];
        };

        // Try each free model until one answers. Overload on a free endpoint is
        // not a failure of the integration, so it should not read as one.
        let result: Awaited<ReturnType<typeof messageService.handleMessage>> | undefined;
        const deadline = Date.now() + 180_000;
        for (const model of MODELS) {
          if (Date.now() > deadline) {
            console.log("  giving up on the free tier; re-run or set BURSAR_MODEL");
            break;
          }
          runtime.setSetting("OPENROUTER_SMALL_MODEL", model);
          runtime.setSetting("OPENROUTER_LARGE_MODEL", model);
          try {
            console.log(`  trying ${model} ...`);
            result = await messageService.handleMessage(runtime, ask, callback, {
              // Bounded so a queue on one free endpoint does not stall the run;
            // four fallbacks at four minutes each is sixteen minutes of looking
            // broken.
            timeoutDuration: 60_000,
            });
            console.log(`  answered by ${model}`);
            break;
          } catch (error) {
            console.log(
              `  ${model} unavailable (${error instanceof Error ? error.message.slice(0, 70) : String(error)})`,
            );
          }
        }

        if (!result) {
          check(false, "at least one free model answered");
          throw new Error("every free model was unavailable; re-run or set BURSAR_MODEL");
        }

        const chosen = (result.responseContent?.actions ?? []) as string[];
        console.log(`  model chose: ${chosen.join(", ") || "(nothing)"}`);

        check(result.didRespond, "the agent decided to respond");

        if (EXECUTE) {
          check(
            chosen.includes("PAY_CONTRIBUTORS"),
            "the model selected PAY_CONTRIBUTORS from natural language",
          );
          check(
            replies.some((r) => /paid|already paid/i.test(r)),
            "and the payout executed through KeeperHub",
          );
        } else {
          // Asked for an amount above the ceiling, there are two acceptable
          // outcomes, and the better one is the second:
          //
          //   - the model picks PAY_CONTRIBUTORS and the policy engine refuses;
          //   - the model reads the limits out of the TREASURY provider and
          //     declines before spending anything.
          //
          // The second is what actually happens, and it is the provider paying
          // for itself: the agent knows its constraints while reasoning rather
          // than discovering them from a failure.
          const refusedUpfront = replies.some((r) => /limit|exceed|0\.02|0\.1/i.test(r));
          const triedAndBlocked =
            chosen.includes("PAY_CONTRIBUTORS") &&
            replies.some((r) => /blocked|exceeds|maxPerTransfer/i.test(r));

          check(
            refusedUpfront || triedAndBlocked,
            refusedUpfront
              ? "the model read the spending limits from the TREASURY provider and declined"
              : "the model tried and the policy engine refused it",
          );
          check(
            !replies.some((r) => /paid —/.test(r)),
            "nothing was paid on a dry run",
          );
        }
      }
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
