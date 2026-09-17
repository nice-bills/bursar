import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { formatUnits, parseUnits, UnitsError, NATIVE_DECIMALS } from "../src/units.js";

describe("formatUnits", () => {
  test("produces the value that KeeperHub actually accepted", () => {
    // The regression this file exists for: we first sent "1000000000000" as the
    // amount, the API read it as whole ether, and it tripped the spending cap.
    assert.equal(formatUnits(1_000_000_000_000n, NATIVE_DECIMALS), "0.000001");
  });

  test("never uses exponent notation, however small the value", () => {
    const formatted = formatUnits(1n, 18);
    assert.equal(formatted, "0.000000000000000001");
    assert.ok(!formatted.includes("e"), "exponent notation would be rejected by the API");
  });

  test("strips trailing zeros but keeps significant ones", () => {
    assert.equal(formatUnits(1_500_000n, 6), "1.5");
    assert.equal(formatUnits(1_000_000n, 6), "1");
    assert.equal(formatUnits(1_000_001n, 6), "1.000001");
  });

  test("formats whole units", () => {
    assert.equal(formatUnits(10n ** 18n, 18), "1");
    assert.equal(formatUnits(0n, 18), "0");
  });

  test("handles values beyond Number.MAX_SAFE_INTEGER without precision loss", () => {
    // 12345678901234567890 wei — a float would mangle the last digits.
    assert.equal(formatUnits(12_345_678_901_234_567_890n, 18), "12.34567890123456789");
  });

  test("handles zero decimals", () => {
    assert.equal(formatUnits(42n, 0), "42");
  });

  test("preserves sign", () => {
    assert.equal(formatUnits(-1_500_000n, 6), "-1.5");
  });
});

describe("parseUnits", () => {
  test("round-trips with formatUnits", () => {
    for (const value of [1n, 999n, 10n ** 18n, 1_000_000_000_000n, 12_345_678_901_234_567_890n]) {
      assert.equal(parseUnits(formatUnits(value, 18), 18), value, `round trip failed for ${value}`);
    }
  });

  test("parses values with no fractional part", () => {
    assert.equal(parseUnits("1", 18), 10n ** 18n);
    assert.equal(parseUnits("0", 18), 0n);
  });

  test("pads a short fraction to full precision", () => {
    assert.equal(parseUnits("1.5", 6), 1_500_000n);
    assert.equal(parseUnits("0.000001", 18), 1_000_000_000_000n);
  });

  test("accepts trailing zeros beyond the asset's precision", () => {
    // "1.5000" at 2 decimals loses nothing real, so it should not throw.
    assert.equal(parseUnits("1.5000", 2), 150n);
  });

  test("refuses to silently truncate real precision", () => {
    // Rounding someone's amount down is worse than refusing it.
    assert.throws(() => parseUnits("1.005", 2), UnitsError);
  });

  test("rejects malformed input rather than coercing", () => {
    for (const bad of ["", ".", "-", "abc", "1.2.3", "1e18", "0x10", " "]) {
      assert.throws(() => parseUnits(bad, 18), UnitsError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test("preserves sign", () => {
    assert.equal(parseUnits("-1.5", 6), -1_500_000n);
  });
});

describe("decimals validation", () => {
  test("rejects nonsensical decimals", () => {
    assert.throws(() => formatUnits(1n, -1), UnitsError);
    assert.throws(() => formatUnits(1n, 1.5), UnitsError);
    assert.throws(() => parseUnits("1", 99), UnitsError);
  });
});

describe("idempotency keys survive real-world strings", () => {
  test("a key with a non-ASCII character does not break fetch", async () => {
    // Regression: workflow names contain an em-dash, and header values must be
    // Latin-1, so `fetch` threw before the key was sanitised.
    const { KeeperHubClient } = await import("../src/keeperhub/client.js");
    // maxAttempts: 1 — the assertion is about the header value, not the retry
    // ladder. Left at the default this test spent ~7s of real backoff sleeping
    // against a dead socket, which was 90% of the whole suite's runtime.
    const client = new KeeperHubClient({
      apiKey: "kh_test",
      baseUrl: "http://127.0.0.1:1",
      maxAttempts: 1,
    });

    // The request will fail to connect; what matters is that it fails as a
    // network error rather than a ByteString conversion TypeError.
    await assert.rejects(
      () => client.createWorkflow({}, "wf-Bursar Float Monitor — chain 11155111"),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(!/ByteString/.test(message), `header conversion failed: ${message}`);
        return true;
      },
    );
  });
});

describe("execution payloads from both surfaces", () => {
  test("workflow transaction objects are read, not stringified", async () => {
    // Regression: workflow executions return objects here while direct
    // executions return strings. String(object) is "[object Object]", which is
    // what first went into the ledger — a hash identifying nothing.
    const { KeeperHubClient } = await import("../src/keeperhub/client.js");
    const client = new KeeperHubClient({ apiKey: "kh_test", baseUrl: "http://127.0.0.1:1" });

    // Exercised through the public surface: build both payload shapes and
    // assert the client's parser handles each.
    const workflowShape = {
      status: "success",
      transactionHashes: [
        { hash: "0xabababababababababababababababababababababababababababababababab", gasUsed: "228491", blockNumber: 11672920, receiptStatus: "success" },
      ],
    };
    const directShape = { status: "completed", transactionHash: "0xdededededededededededededededededededededededededededededededede" };

    for (const [payload, expected] of [
      [workflowShape, "0xabababababababababababababababababababababababababababababababab"],
      [directShape, "0xdededededededededededededededededededededededededededededededede"],
    ] as const) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      try {
        const result = await client.transfer(
          { chainId: "1", recipientAddress: `0x${"1".repeat(40)}`, amount: "1" },
          "test-key",
        );
        assert.deepEqual(result.transactionHashes, [expected]);
        assert.ok(!result.transactionHashes[0]?.includes("object"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  // The hashes below are full 32-byte values on purpose: `normalizeExecution`
  // drops anything that is not one, so a short placeholder would be filtered
  // out and the test would be asserting against the filter, not the parser.
  test("workflow receipts keep their gas and block metadata", async () => {
    const { KeeperHubClient } = await import("../src/keeperhub/client.js");
    const client = new KeeperHubClient({ apiKey: "kh_test", baseUrl: "http://127.0.0.1:1" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "success",
          transactionHashes: [
            { hash: "0xabababababababababababababababababababababababababababababababab", gasUsed: "228491", blockNumber: 11672920, verified: true },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const result = await client.transfer(
        { chainId: "1", recipientAddress: `0x${"1".repeat(40)}`, amount: "1" },
        "k",
      );
      assert.equal(result.transactions[0]?.gasUsed, "228491");
      assert.equal(result.transactions[0]?.blockNumber, 11672920);
      assert.equal(result.transactions[0]?.verified, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("which failures are worth retrying", () => {
  test("a conflict is retryable, because the idempotency key makes it safe", async () => {
    // Observed live: a 409 came back for a transfer that had already
    // succeeded. Retrying is only safe because the key is stable — without it
    // this is how a treasury pays someone twice.
    const { KeeperHubError } = await import("../src/keeperhub/client.js");
    assert.equal(new KeeperHubError("x", 409, null).retryable, true);
    assert.equal(new KeeperHubError("x", 429, null).retryable, true);
    assert.equal(new KeeperHubError("x", 503, null).retryable, true);
  });

  test("a bad request is not, because it will fail identically", async () => {
    const { KeeperHubError } = await import("../src/keeperhub/client.js");
    assert.equal(new KeeperHubError("x", 400, null).retryable, false);
    assert.equal(new KeeperHubError("x", 401, null).retryable, false);
    assert.equal(new KeeperHubError("x", 404, null).retryable, false);
  });
});
