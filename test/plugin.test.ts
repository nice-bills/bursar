import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import bursarPlugin from "../src/index.js";
import { BursarService } from "../src/eliza/service.js";
import { treasuryProvider } from "../src/eliza/provider.js";
import { payContributorsAction, reconcileTreasuryAction } from "../src/eliza/actions.js";
import { createStandaloneRuntime, userMessage, emptyState } from "../src/eliza/standalone.js";
import {
  gasFloatWorkflow,
  nativeBalanceWorkflow,
  erc20BalanceWorkflow,
  readBalanceOutput,
} from "../src/treasury/workflows.js";

const CONFIG = {
  treasury: { chainId: 11155111, address: `0x${"8".repeat(40)}` },
  contributors: [
    { name: "model", address: `0x${"1".repeat(40)}`, shareBps: 6000 },
    { name: "host", address: `0x${"2".repeat(40)}`, shareBps: 4000 },
  ],
  float: [
    {
      chainId: 11155111,
      address: `0x${"4".repeat(40)}`,
      minBalance: "10000000000000000",
      targetBalance: "50000000000000000",
    },
  ],
  policy: { maxPerTransfer: "20000000000000000", maxPerDay: "100000000000000000" },
};

/** A runtime with a real config on disk, but a key that never gets used. */
async function withRuntime<T>(
  fn: (ctx: Awaited<ReturnType<typeof createStandaloneRuntime>>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bursar-plugin-"));
  const configPath = join(dir, "bursar.config.json");
  await writeFile(configPath, JSON.stringify(CONFIG), "utf8");

  const ctx = createStandaloneRuntime({
    settings: {
      KEEPERHUB_API_KEY: "kh_test_key_not_used_for_network",
      BURSAR_CONFIG_PATH: configPath,
      BURSAR_LEDGER_PATH: join(dir, "ledger.jsonl"),
    },
  });

  try {
    return await fn(ctx);
  } finally {
    await ctx.stopAll();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("plugin manifest", () => {
  test("declares the ElizaOS extension points it implements", () => {
    assert.equal(bursarPlugin.name, "bursar");
    assert.ok(bursarPlugin.description.length > 0);
    assert.deepEqual(bursarPlugin.services, [BursarService]);
    assert.deepEqual(bursarPlugin.providers, [treasuryProvider]);
    assert.equal(bursarPlugin.actions?.length, 7);
  });

  test("every action has a description, validate, and handler", () => {
    for (const action of bursarPlugin.actions ?? []) {
      assert.ok(action.name, "action needs a name");
      assert.ok(action.description.length > 20, `${action.name} needs a real description`);
      assert.equal(typeof action.validate, "function", `${action.name} needs validate`);
      assert.equal(typeof action.handler, "function", `${action.name} needs a handler`);
    }
  });

  test("action names are unique and upper snake case, as ElizaOS expects", () => {
    const names = (bursarPlugin.actions ?? []).map((a) => a.name);
    assert.equal(new Set(names).size, names.length, "duplicate action names");
    for (const name of names) assert.match(name, /^[A-Z][A-Z_]+$/);
  });

  test("refuses to initialise without an API key, rather than failing at first payout", async () => {
    const previous = process.env.KEEPERHUB_API_KEY;
    delete process.env.KEEPERHUB_API_KEY;
    try {
      await assert.rejects(
        () => bursarPlugin.init?.({}, {} as never) ?? Promise.resolve(),
        /KEEPERHUB_API_KEY/,
      );
    } finally {
      if (previous !== undefined) process.env.KEEPERHUB_API_KEY = previous;
    }
  });
});

describe("service lifecycle", () => {
  test("starts from runtime settings and exposes the treasury config", async () => {
    await withRuntime(async ({ startService }) => {
      const service = await startService(BursarService);
      assert.equal(service.treasuryConfig.contributors.length, 2);
      assert.equal(service.treasuryConfig.treasury.chainId, 11155111);
    });
  });

  test("is retrievable by its serviceType, which is how actions find it", async () => {
    await withRuntime(async ({ runtime, startService }) => {
      await startService(BursarService);
      const found = runtime.getService<BursarService>(BursarService.serviceType);
      assert.ok(found, "service must be resolvable by type");
    });
  });
});

describe("treasury provider", () => {
  test("reports an unlocked treasury with the configured splits", async () => {
    await withRuntime(async ({ runtime, startService }) => {
      await startService(BursarService);
      const result = await treasuryProvider.get(runtime, userMessage("hi"), emptyState());
      assert.equal(result.values?.treasuryLocked, false);
      assert.match(result.text ?? "", /model 60\.0%/);
      assert.match(result.text ?? "", /host 40\.0%/);
    });
  });

  test("is included in default state composition", () => {
    // Regression, found by booting a real AgentRuntime: composeState filters on
    // `!p.private && !p.dynamic`. Marking this provider dynamic silently
    // removed treasury state from the agent's context — the agent stopped
    // knowing it was solvent, which is the entire reason the provider exists.
    assert.notEqual(treasuryProvider.dynamic, true, "a dynamic provider is opt-in only");
    assert.notEqual(treasuryProvider.private, true, "a private provider is opt-in only");
  });

  test("degrades instead of throwing when the service is absent", async () => {
    const ctx = createStandaloneRuntime({ settings: {} });
    const result = await treasuryProvider.get(ctx.runtime, userMessage("hi"), emptyState());
    // A provider that throws would poison every message the agent handles.
    assert.equal(result.values?.treasuryAvailable, false);
    assert.ok((result.text ?? "").length > 0);
  });
});

describe("action gating", () => {
  test("PAY_CONTRIBUTORS is not offered when no amount is stated", async () => {
    await withRuntime(async ({ runtime, startService }) => {
      await startService(BursarService);
      assert.equal(
        await payContributorsAction.validate(runtime, userMessage("pay everyone what we owe")),
        false,
      );
      assert.equal(
        await payContributorsAction.validate(runtime, userMessage("pay out 0.01")),
        true,
      );
    });
  });

  test("no action is offered when the treasury service is not running", async () => {
    const ctx = createStandaloneRuntime({ settings: {} });
    for (const action of [payContributorsAction, reconcileTreasuryAction]) {
      assert.equal(
        await action.validate(ctx.runtime, userMessage("pay out 0.01")),
        false,
        `${action.name} must not be offered without a service`,
      );
    }
  });

  test("RECONCILE_TREASURY reports cleanly when there is nothing open", async () => {
    await withRuntime(async ({ runtime, startService }) => {
      await startService(BursarService);
      const result = await reconcileTreasuryAction.handler(
        runtime,
        userMessage("did it go through?"),
        emptyState(),
      );
      assert.equal((result as { success: boolean }).success, true);
      assert.match((result as { text: string }).text, /[Nn]othing to reconcile/);
    });
  });
});

describe("the gas keeper runs without the agent", () => {
  const float = CONFIG.float[0]!;

  test("reads, compares and tops up entirely on the platform", () => {
    // The whole point: a crashed agent cannot notice it has run out of gas, so
    // the decision has to live on KeeperHub's schedule, not in our process.
    const wf = gasFloatWorkflow(float);
    const types = wf.nodes.map((n) => n.data.config.actionType);
    assert.ok(types.includes("web3/check-balance"), "must read the balance");
    assert.ok(types.includes("Condition"), "must decide on the platform");
    assert.ok(types.includes("web3/transfer-funds"), "must be able to act");
  });

  test("fires on a schedule rather than waiting to be asked", () => {
    const trigger = gasFloatWorkflow(float).nodes.find((n) => n.type === "trigger");
    assert.equal(trigger?.data.config.triggerType, "Schedule");
    assert.ok(trigger?.data.config.scheduleCron, "a schedule needs a cron");
  });

  test("uses the documented Condition shape, not a top-level group", () => {
    // A `group` key passes validation and then leaves the reference unresolved
    // at execution, which looks like a broken template resolver.
    const gate = gasFloatWorkflow(float).nodes.find(
      (n) => n.data.config.actionType === "Condition",
    );
    assert.ok(gate, "the keeper needs its gate");
    assert.equal(typeof gate?.data.config.condition, "string");
    assert.equal(gate?.data.config.group, undefined, "`group` is not in the schema");
  });

  test("compares on balanceWei so the gate is integer arithmetic", () => {
    const gate = gasFloatWorkflow(float).nodes.find(
      (n) => n.data.config.actionType === "Condition",
    );
    const condition = String(gate?.data.config.condition);
    assert.match(condition, /balanceWei/, "comparing decimal strings compares lexically");
    assert.match(condition, new RegExp(float.minBalance), "must compare against the floor");
  });

  test("tops up only on the true branch", () => {
    // Without the handle the transfer runs whatever the balance is.
    const wf = gasFloatWorkflow(float);
    const gate = wf.nodes.find((n) => n.data.config.actionType === "Condition")!;
    const topUp = wf.nodes.find((n) => n.data.config.actionType === "web3/transfer-funds")!;
    const edge = wf.edges.find((e) => e.source === gate.id && e.target === topUp.id);
    assert.ok(edge, "the gate must feed the top-up");
    assert.equal(edge?.sourceHandle, "true");
  });

  test("tops up a fixed amount, so a run cannot chase its own effect", () => {
    const topUp = gasFloatWorkflow(float).nodes.find(
      (n) => n.data.config.actionType === "web3/transfer-funds",
    );
    // target - min = 0.05 - 0.01, decided at authoring time.
    assert.equal(topUp?.data.config.amount, "0.04");
    assert.equal(topUp?.data.config.recipientAddress, float.address);
  });

  test("names itself stably, so re-authoring updates instead of duplicating", () => {
    assert.equal(gasFloatWorkflow(float).name, gasFloatWorkflow(float).name);
    assert.match(gasFloatWorkflow(float).name, /^Bursar /);
  });
});

describe("readBalanceOutput", () => {
  test("parses a real check-balance payload", () => {
    const reading = readBalanceOutput({
      address: "0xabc",
      balance: "0.4999926",
      balanceWei: "499992600000000000",
      addressLink: "https://sepolia.etherscan.io/address/0xabc",
      success: true,
    });
    assert.equal(reading?.balanceWei, "499992600000000000");
    assert.equal(reading?.balance, "0.4999926");
  });

  test("returns null rather than a half-built reading when the shape is wrong", () => {
    // A malformed reading must not be mistaken for a zero balance, which would
    // trigger a top-up that is not needed.
    assert.equal(readBalanceOutput(null), null);
    assert.equal(readBalanceOutput({ balance: "1.0" }), null);
    assert.equal(readBalanceOutput({ balanceWei: 123 }), null);
  });
});

describe("workflow naming keeps distinct concerns apart", () => {
  const float = CONFIG.float[0]!;

  test("the on-demand balance read does not collide with the gas keeper", () => {
    // Workflows are upserted by name. Sharing one would mean a sweep's balance
    // read silently rewriting the float keeper's schedule.
    const keeper = gasFloatWorkflow(float);
    const onDemand = nativeBalanceWorkflow(float.chainId, float.address);
    assert.notEqual(keeper.name, onDemand.name);
  });

  test("the keeper keeps its schedule; the on-demand read is manual", () => {
    const keeper = gasFloatWorkflow(float);
    const onDemand = nativeBalanceWorkflow(float.chainId, float.address);
    assert.equal(keeper.nodes[0]?.data.config.triggerType, "Schedule");
    assert.equal(onDemand.nodes[0]?.data.config.triggerType, "Manual");
  });

  test("balance workflows are scoped to the holder they read", () => {
    const a = nativeBalanceWorkflow(11155111, `0x${"1".repeat(40)}`);
    const b = nativeBalanceWorkflow(11155111, `0x${"2".repeat(40)}`);
    assert.notEqual(a.name, b.name, "two holders must not share one workflow");

    const t1 = erc20BalanceWorkflow(11155111, `0x${"a".repeat(40)}`, `0x${"1".repeat(40)}`, "USDC");
    const t2 = erc20BalanceWorkflow(11155111, `0x${"a".repeat(40)}`, `0x${"2".repeat(40)}`, "USDC");
    assert.notEqual(t1.name, t2.name);
  });
});

describe("sweep refuses a destination that is its own wallet", () => {
  test("reports the no-op instead of burning gas and daily cap on a self-transfer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bursar-selfsweep-"));
    const configPath = join(dir, "bursar.config.json");
    const wallet = `0x${"8".repeat(40)}`;
    await writeFile(
      configPath,
      JSON.stringify({
        ...CONFIG,
        treasury: { chainId: 11155111, address: wallet },
        sweep: {
          chainId: 11155111,
          destination: wallet,
          assets: [{ token: null, symbol: "ETH", decimals: 18, minAmount: "1" }],
        },
      }),
      "utf8",
    );

    const ctx = createStandaloneRuntime({
      settings: {
        KEEPERHUB_API_KEY: "kh_test_key_not_used_for_network",
        BURSAR_CONFIG_PATH: configPath,
        BURSAR_LEDGER_PATH: join(dir, "ledger.jsonl"),
      },
    });

    try {
      const service = await ctx.startService(BursarService);
      const reports = await service.sweep();
      assert.equal(reports.length, 1);
      assert.equal(reports[0]?.swept, null);
      assert.match(reports[0]?.note ?? "", /own wallet|nothing to consolidate/i);
    } finally {
      await ctx.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the public surface matches what the docs promise", () => {
  test("everything the README and module docs tell integrators to import exists", async () => {
    // standalone.ts claimed it was "exported from the package on purpose" while
    // it was not reachable from the entry point. A doc that lies is worse than
    // one that is missing, so the surface is asserted rather than described.
    const api = await import("../src/index.js");
    const promised = [
      "bursarPlugin",
      "BursarService",
      "treasuryProvider",
      "treasuryActions",
      "createStandaloneRuntime",
      "userMessage",
      "emptyState",
      "stubModelPlugin",
      "embeddingStubPlugin",
      "Executor",
      "PolicyEngine",
      "Ledger",
      "KeeperHubClient",
      "loadConfig",
      "splitByShares",
      "formatUnits",
      "parseUnits",
      "extractAmount",
    ];
    for (const name of promised) {
      assert.ok(name in api, `${name} is documented but not exported`);
    }
  });

  test("the default export is the plugin itself", async () => {
    const api = await import("../src/index.js");
    assert.equal(api.default, api.bursarPlugin);
  });

  test("every action exported individually is also in treasuryActions", async () => {
    const api = await import("../src/index.js");
    const individual = [
      api.payContributorsAction,
      api.pendingApprovalsAction,
      api.sweepEarningsAction,
      api.deployYieldAction,
      api.checkFloatAction,
      api.reconcileTreasuryAction,
      api.treasuryReportAction,
    ];
    for (const action of individual) {
      assert.ok(
        api.treasuryActions.includes(action),
        `${action.name} is exported but not registered on the plugin`,
      );
    }
    assert.equal(individual.length, api.treasuryActions.length);
  });
});

describe("the package a consumer installs", () => {
  test("declares an entry point, and builds one on install", async () => {
    // dist/ is not committed, so a git install has to build on the way in.
    // Without `prepare`, `npm install github:...` yields a package whose main
    // points at nothing — the documented way to adopt this would not work.
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;

    assert.equal(pkg.private, undefined, "a private package cannot be installed by name");
    assert.equal(pkg.main, "dist/index.js");
    assert.equal(pkg.types, "dist/index.d.ts");
    assert.equal((pkg.scripts as Record<string, string>).prepare, "npm run build");
  });

  test("ships the config example and character a new user needs", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { files: string[] };
    for (const needed of ["dist", "bursar.config.example.json", "character"]) {
      assert.ok(pkg.files.includes(needed), `${needed} must be published`);
    }
  });

  test("the README documents the install the package actually supports", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    assert.match(readme, /npm install github:nice-bills\/bursar/);
    assert.match(readme, /plugin-bursar/);
  });
});
