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
