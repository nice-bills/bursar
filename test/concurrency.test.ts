import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configSchema } from "../src/config.js";
import { Ledger } from "../src/ledger/store.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { Executor } from "../src/treasury/executor.js";
import type { ExecutionResult, KeeperHubClient } from "../src/keeperhub/client.js";

const contributors = [
  { name: "a", address: `0x${"1".repeat(40)}`, shareBps: 5000 },
  { name: "b", address: `0x${"2".repeat(40)}`, shareBps: 5000 },
];

/**
 * A client where every transfer succeeds, after a delay.
 *
 * The delay is the point: it widens the window between reading the ledger and
 * writing to it, which is exactly where a check-then-act race lives.
 */
function slowClient(delayMs = 25): { client: KeeperHubClient; calls: () => number } {
  let calls = 0;
  const client = {
    async transfer(_params: unknown, key: string): Promise<ExecutionResult> {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        executionId: `exec-${key.slice(-8)}`,
        status: "completed",
        transactionHashes: [`0x${key.slice(-8)}`],
        transactionLinks: [],
        idempotentReplay: false,
        output: null,
        raw: {},
      };
    },
  } as unknown as KeeperHubClient;
  return { client, calls: () => calls };
}

async function withExecutor<T>(
  policy: { maxPerTransfer: string; maxPerDay: string },
  fn: (ctx: { executor: Executor; ledger: Ledger; calls: () => number }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bursar-conc-"));
  try {
    const config = configSchema.parse({
      treasury: { chainId: 11155111 },
      contributors,
      policy,
    });
    const ledger = new Ledger(join(dir, "ledger.jsonl"));
    const { client, calls } = slowClient();
    const executor = new Executor(client, ledger, new PolicyEngine(config, ledger), config);
    return await fn({ executor, ledger, calls });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function movement(to: string, amount: string) {
  return {
    leg: "payout" as const,
    chainId: 11155111,
    to,
    amount,
    token: null,
    decimals: 18,
    memo: "concurrency test",
  };
}

async function confirmedTotal(ledger: Ledger): Promise<bigint> {
  const entries = [...(await ledger.latestByIntent()).values()];
  return entries
    .filter((e) => e.status === "confirmed")
    .reduce((sum, e) => sum + BigInt(e.amount), 0n);
}

describe("concurrent movements cannot breach the daily cap", () => {
  test("ten simultaneous payouts against a cap that allows one", async () => {
    // Regression: before the executor serialised its critical section, all ten
    // read the ledger before any wrote, every one passed policy, and the cap
    // was breached tenfold.
    await withExecutor({ maxPerTransfer: "1000", maxPerDay: "1000" }, async ({ executor, ledger }) => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          executor.move(movement(contributors[i % 2]!.address, "1000"), `period-${i}`),
        ),
      );

      const confirmed = results.filter((r) => r.result === "confirmed");
      const blocked = results.filter((r) => r.result === "blocked");

      assert.equal(confirmed.length, 1, "exactly one movement may succeed");
      assert.equal(blocked.length, 9, "the rest must be blocked, not silently dropped");
      assert.equal(await confirmedTotal(ledger), 1000n, "the cap must hold exactly");
    });
  });

  test("a blocked movement never reaches the network", async () => {
    await withExecutor({ maxPerTransfer: "1000", maxPerDay: "1000" }, async ({ executor, calls }) => {
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          executor.move(movement(contributors[0]!.address, "1000"), `p-${i}`),
        ),
      );
      assert.equal(calls(), 1, "only the permitted movement should have been submitted");
    });
  });

  test("concurrent duplicates of the same movement transfer once", async () => {
    // Same recipient, amount, and period: one payment, however many callers.
    await withExecutor({ maxPerTransfer: "1000", maxPerDay: "100000" }, async ({ executor, ledger, calls }) => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          executor.move(movement(contributors[0]!.address, "1000"), "same-period"),
        ),
      );

      assert.equal(results.filter((r) => r.result === "confirmed").length, 1);
      assert.equal(results.filter((r) => r.result === "skipped").length, 5);
      assert.equal(calls(), 1, "the duplicate calls must not hit the network");
      assert.equal(await confirmedTotal(ledger), 1000n);
    });
  });

  test("one failing movement does not poison the ones queued behind it", async () => {
    await withExecutor({ maxPerTransfer: "1000", maxPerDay: "100000" }, async ({ executor }) => {
      const results = await Promise.all([
        // Denied: recipient is not on the allowlist.
        executor.move(movement(`0x${"9".repeat(40)}`, "1000"), "p1"),
        executor.move(movement(contributors[0]!.address, "1000"), "p2"),
        executor.move(movement(contributors[1]!.address, "1000"), "p3"),
      ]);

      assert.equal(results[0]?.result, "blocked");
      assert.equal(results[1]?.result, "confirmed", "a rejection must not block the queue");
      assert.equal(results[2]?.result, "confirmed");
    });
  });
});

describe("ledger locking keeps two processes apart", () => {
  async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "bursar-lock-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("a second holder is refused while the first is alive", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "ledger.jsonl");
      const first = new Ledger(path);
      const second = new Ledger(path);

      await first.acquire();
      // The lock records this process's pid, which is obviously alive.
      await assert.rejects(() => second.acquire(), /locked by pid/);
      await first.release();
    });
  });

  test("the lock is released and can be retaken", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "ledger.jsonl");
      const first = new Ledger(path);
      await first.acquire();
      await first.release();

      const second = new Ledger(path);
      await second.acquire();
      await second.release();
    });
  });

  test("acquiring twice from the same holder is a no-op", async () => {
    await withDir(async (dir) => {
      const ledger = new Ledger(join(dir, "ledger.jsonl"));
      await ledger.acquire();
      await ledger.acquire();
      await ledger.release();
    });
  });

  test("a lock from a dead process is taken over, not honoured", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "ledger.jsonl");
      // A pid that cannot be running. A treasury that will not reconcile after
      // a crash is worse than one that risks a rare concurrent write.
      await writeFile(
        `${path}.lock`,
        JSON.stringify({ pid: 2147483000, at: new Date().toISOString() }),
        "utf8",
      );
      const ledger = new Ledger(path);
      await ledger.acquire();
      await ledger.release();
    });
  });

  test("a stale lock is taken over even if the pid is alive", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "ledger.jsonl");
      const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await writeFile(`${path}.lock`, JSON.stringify({ pid: process.pid, at: old }), "utf8");

      const ledger = new Ledger(path);
      await ledger.acquire();
      await ledger.release();
    });
  });

  test("a corrupt lock file does not wedge the ledger", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "ledger.jsonl");
      await writeFile(`${path}.lock`, "{not json", "utf8");
      const ledger = new Ledger(path);
      await ledger.acquire();
      await ledger.release();
    });
  });
});
