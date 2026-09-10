import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import bursarPlugin from "../src/index.js";
import { BursarService } from "../src/eliza/service.js";
import { treasuryProvider } from "../src/eliza/provider.js";
import { payContributorsAction, reconcileTreasuryAction } from "../src/eliza/actions.js";
import { createStandaloneRuntime, userMessage, emptyState } from "../src/eliza/standalone.js";
import { floatMonitorWorkflow, readBalanceOutput } from "../src/treasury/workflows.js";

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
    assert.equal(bursarPlugin.actions?.length, 6);
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

describe("float monitor workflow", () => {
  const float = CONFIG.float[0]!;

  test("uses the action type the platform validator actually accepts", () => {
    const wf = floatMonitorWorkflow(float);
    const types = wf.nodes.map((n) => n.data.config.actionType).filter(Boolean);
    assert.ok(types.includes("web3/check-balance"));
    // The documented name is rejected as an unknown action type.
    assert.ok(!types.includes("web3.getNativeBalance"));
  });

  test("reads the wallet the agent actually spends gas from", () => {
    const wf = floatMonitorWorkflow(float);
    const node = wf.nodes.find((n) => n.data.config.actionType === "web3/check-balance");
    assert.equal(node?.data.config.address, float.address);
    assert.equal(node?.data.config.network, String(float.chainId));
  });

  test("carries no transfer node, so the workflow itself can never move value", () => {
    // The comparison cannot run on-platform (a Condition node cannot read a
    // web3/check-balance output), so the decision lives in checkFloat().
    // A transfer node here would fire unconditionally.
    const wf = floatMonitorWorkflow(float);
    const types = wf.nodes.map((n) => n.data.config.actionType);
    assert.ok(!types.includes("web3/transfer-funds"), "monitor must be read-only");
  });

  test("is a connected graph", () => {
    const wf = floatMonitorWorkflow(float);
    const targets = new Set(wf.edges.map((e) => e.target));
    for (const node of wf.nodes) {
      if (node.type === "trigger") continue;
      assert.ok(targets.has(node.id), `node ${node.id} is orphaned`);
    }
  });

  test("names itself stably, so re-authoring updates instead of duplicating", () => {
    assert.equal(floatMonitorWorkflow(float).name, floatMonitorWorkflow(float).name);
    assert.match(floatMonitorWorkflow(float).name, /^Bursar /);
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
