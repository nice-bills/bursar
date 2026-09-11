import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { validateCharacter } from "@elizaos/core";

import { treasuryActions } from "../src/eliza/actions.js";

const PATH = "character/treasurer.character.json";

async function loadRaw(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(PATH, "utf8")) as Record<string, unknown>;
}

describe("the shipped character is a real ElizaOS character", () => {
  test("passes ElizaOS's own validator", async () => {
    // Not our opinion of the format — theirs.
    const result = validateCharacter(await loadRaw());
    const ok = (result as { success?: boolean })?.success ?? result;
    assert.ok(ok, `character rejected by validateCharacter: ${JSON.stringify(result).slice(0, 300)}`);
  });

  test("declares plugin-bursar alongside the plugins it depends on", async () => {
    const raw = await loadRaw();
    const plugins = raw.plugins as string[];
    assert.ok(plugins.includes("plugin-bursar"), "must load the treasury plugin");
    // sql provides the adapter, bootstrap the ACTIONS provider the model reads.
    assert.ok(plugins.includes("@elizaos/plugin-sql"));
    assert.ok(plugins.includes("@elizaos/plugin-bootstrap"));
  });

  test("every action it demonstrates actually exists", async () => {
    // A character that advertises an action the plugin does not register
    // teaches the model to emit a name nothing answers to.
    const raw = await loadRaw();
    const known = new Set(treasuryActions.map((a) => a.name));
    const examples = raw.messageExamples as Array<Array<{ content?: { actions?: string[] } }>>;

    const referenced = examples
      .flat()
      .flatMap((m) => m.content?.actions ?? [])
      .filter((name) => name !== "REPLY" && name !== "IGNORE");

    assert.ok(referenced.length > 0, "the character should demonstrate its actions");
    for (const name of referenced) {
      assert.ok(known.has(name), `character references unknown action ${name}`);
    }
  });

  test("carries no secrets", async () => {
    // The file is committed; a key in it would be published with the repo.
    const text = await readFile(PATH, "utf8");
    assert.ok(!/kh_[A-Za-z0-9]/.test(text), "must not contain a KeeperHub key");
    assert.ok(!/sk-[A-Za-z0-9]/.test(text), "must not contain a model provider key");
    const raw = await loadRaw();
    const secrets = (raw.settings as { secrets?: Record<string, unknown> })?.secrets ?? {};
    assert.equal(Object.keys(secrets).length, 0, "secrets must be supplied by the environment");
  });
});
