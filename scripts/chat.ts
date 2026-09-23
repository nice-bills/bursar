/**
 * Talk to the Treasurer.
 *
 * The same real ElizaOS agent `npm run agent` boots — the shipped character,
 * plugin-bursar, a real model choosing actions — but interactive, and against
 * the real ledger, so what it pays is recorded with everything it paid before.
 *
 *   npm run chat               # Claude, through the local Claude Code CLI
 *   npm run chat -- --openrouter  # a free OpenRouter model instead
 *
 * Every payout it makes is real, on the configured chain. There is no dry mode:
 * the policy engine is what stands between a sentence and a transfer, which is
 * the point of talking to it.
 */

import "dotenv/config";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

import { ChannelType, ElizaOS, stringToUuid, type Character, type Content, type IAgentRuntime, type Memory, type UUID } from "@elizaos/core";
import { plugin as sqlPlugin, createDatabaseAdapter, DatabaseMigrationService } from "@elizaos/plugin-sql";

import bursarPlugin, { BursarService } from "../src/index.js";
import { embeddingStubPlugin } from "../src/eliza/stub-model.js";
import { claudeModelPlugin, claudeModel } from "./claude-model.js";

const USE_OPENROUTER = process.argv.includes("--openrouter");

const MODELS = !USE_OPENROUTER
  ? [`claude ${claudeModel}`]
  : process.env.BURSAR_MODEL
  ? [process.env.BURSAR_MODEL]
  : [
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "nvidia/nemotron-3.5-lightning:free",
      "nex-agi/nex-n2.5-pro:free",
      "inclusionai/ling-3.0-flash-fin:free",
    ];

const CHARACTER_PATH = process.env.BURSAR_CHARACTER ?? "character/treasurer.character.json";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

async function main(): Promise<void> {
  for (const key of ["KEEPERHUB_API_KEY", ...(USE_OPENROUTER ? ["OPENROUTER_API_KEY"] : [])]) {
    if (!process.env[key]) {
      console.error(`${key} is not set — see .env.example.`);
      process.exit(1);
    }
  }

  const raw = JSON.parse(await readFile(CHARACTER_PATH, "utf8")) as Character;
  const character: Character = { ...raw, id: stringToUuid(raw.name) };
  const dataDir = await mkdtemp(join(tmpdir(), "bursar-chat-"));

  // Bootstrap without its reflection evaluator: that is a second model call
  // after every message, spent on memory this session throws away.
  const { bootstrapPlugin } = await import("@elizaos/plugin-bootstrap");
  const modelPlugin = USE_OPENROUTER ? (await import("@elizaos/plugin-openrouter")).openrouterPlugin : claudeModelPlugin;
  const plugins = [sqlPlugin, modelPlugin, embeddingStubPlugin, { ...bootstrapPlugin, evaluators: [] }, bursarPlugin];

  process.stdout.write(dim("booting the agent…"));
  const adapter = createDatabaseAdapter({ dataDir: join(dataDir, "db") }, character.id!);
  await adapter.init();
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(adapter.getDatabase());
  migrations.discoverAndRegisterPluginSchemas(plugins);
  await migrations.runAllPluginMigrations();

  const eliza = new ElizaOS();
  const [runtime] = (await eliza.addAgents(
    [
      {
        character: { ...character, plugins: [] },
        databaseAdapter: adapter,
        plugins,
        settings: {
          PGLITE_DATA_DIR: join(dataDir, "db"),
          KEEPERHUB_API_KEY: process.env.KEEPERHUB_API_KEY ?? "",
          KEEPERHUB_BASE_URL: process.env.KEEPERHUB_BASE_URL ?? "",
          BURSAR_CONFIG_PATH: process.env.BURSAR_CONFIG_PATH ?? "bursar.config.json",
          BURSAR_LEDGER_PATH: process.env.BURSAR_LEDGER_PATH ?? "data/ledger.jsonl",
          OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
          OPENROUTER_SMALL_MODEL: MODELS[0]!,
          OPENROUTER_LARGE_MODEL: MODELS[0]!,
        },
      },
    ],
    { returnRuntimes: true, autoStart: true, skipMigrations: true },
  )) as IAgentRuntime[];
  if (!runtime) throw new Error("ElizaOS returned no runtime");

  const shutdown = async () => {
    await eliza.stopAgents().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  };

  const deadline = Date.now() + 15_000;
  let service = runtime.getService<BursarService>(BursarService.serviceType);
  while (!service && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    service = runtime.getService<BursarService>(BursarService.serviceType);
  }
  if (!service) {
    console.error("\nBursarService did not start.");
    await shutdown();
    process.exit(1);
  }

  const roomId = randomUUID() as UUID;
  const entityId = randomUUID() as UUID;
  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId: randomUUID() as UUID,
    worldName: "Bursar Chat",
    name: "operator",
    userName: "operator",
    source: "chat",
    type: ChannelType.DM,
    channelId: roomId,
    messageServerId: randomUUID() as UUID,
  });

  process.stdout.write("\r\x1b[K");
  console.log(`${bold(cyan(runtime.character.name))} ${dim(`· ElizaOS agent · plugin-bursar · executes through KeeperHub`)}`);
  console.log(dim(`model: ${USE_OPENROUTER ? `OpenRouter (${MODELS[0]})` : `Claude ${claudeModel}, via Claude Code, no tools`}`));
  console.log(dim(`actions: ${runtime.actions.filter((a) => bursarPlugin.actions?.includes(a)).map((a) => a.name).join(", ")}`));
  console.log(dim(`contributors: ${service.treasuryConfig.contributors.map((c) => `${c.name} ${c.shareBps / 100}%`).join(", ")}`));
  console.log(dim(`type "exit" to leave\n`));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => rl.close());
  let modelIndex = 0;

  for (;;) {
    let text: string;
    try {
      text = (await rl.question(bold("you › "))).trim();
    } catch {
      break; // stdin closed
    }
    if (!text) continue;
    if (/^(exit|quit)$/i.test(text)) break;

    const message: Memory = {
      id: randomUUID() as UUID,
      entityId,
      agentId: runtime.agentId,
      roomId,
      content: { text, source: "chat", channelType: ChannelType.DM } as Content,
      createdAt: Date.now(),
    };
    await runtime.createMemory(message, "messages");

    const said = new Set<string>();
    const callback = async (content: Content) => {
      const out = String(content.text ?? "").trim();
      if (out && !said.has(out)) {
        said.add(out);
        const [first, ...rest] = out.split("\n");
        console.log(`${bold(cyan(runtime.character.name + " ›"))} ${first}`);
        for (const line of rest) console.log(`  ${line}`);
      }
      return [];
    };

    process.stdout.write(dim("  thinking…"));
    let answered = false;
    // Free endpoints go "temporarily overloaded" without warning; move on to
    // the next model rather than stall the conversation on one.
    for (let tries = 0; tries < MODELS.length && !answered; tries++) {
      const model = MODELS[modelIndex]!;
      runtime.setSetting("OPENROUTER_SMALL_MODEL", model);
      runtime.setSetting("OPENROUTER_LARGE_MODEL", model);
      try {
        const result = await runtime.messageService!.handleMessage(runtime, message, callback, { timeoutDuration: 60_000 });
        process.stdout.write("\r\x1b[K");
        const actions = ((result.responseContent?.actions ?? []) as string[]).filter((a) => a !== "REPLY");
        if (said.size === 0 && result.responseContent?.text) await callback(result.responseContent);
        if (actions.length) console.log(dim(`  ↳ chose ${actions.join(", ")}`));
        answered = true;
      } catch (error) {
        process.stdout.write("\r\x1b[K");
        console.log(dim(`  ${model} unavailable (${error instanceof Error ? error.message.slice(0, 60) : String(error)}), trying the next`));
        modelIndex = (modelIndex + 1) % MODELS.length;
      }
    }
    if (!answered) console.log(dim("  no model answered — ask again"));
    console.log();
  }

  rl.close();
  await shutdown();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
