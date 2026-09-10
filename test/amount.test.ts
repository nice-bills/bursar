import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { extractAmount } from "../src/eliza/amount.js";
import { NATIVE_DECIMALS, parseUnits } from "../src/units.js";

function parse(text: string) {
  return extractAmount(text, NATIVE_DECIMALS);
}

/** BigInt is not JSON-serialisable, so build failure messages by hand. */
function describeResult(result: ReturnType<typeof parse>): string {
  return result.ok ? `ok(${result.amount})` : `refused(${result.reason})`;
}

function assertAmount(text: string, expected: string): void {
  const result = parse(text);
  assert.equal(result.ok, true, `expected "${text}" to parse, got ${describeResult(result)}`);
  if (result.ok) {
    assert.equal(result.amount, parseUnits(expected, NATIVE_DECIMALS), `wrong amount for "${text}"`);
  }
}

function assertRefused(text: string, reasonPattern: RegExp): void {
  const result = parse(text);
  assert.equal(result.ok, false, `expected "${text}" to be refused`);
  if (!result.ok) assert.match(result.reason, reasonPattern, `wrong reason for "${text}"`);
}

describe("extractAmount — the amounts that must parse", () => {
  test("a plain instruction", () => assertAmount("pay out 0.01", "0.01"));
  test("with a unit", () => assertAmount("distribute 0.01 ETH", "0.01"));
  test("a bare number, nothing to confuse it with", () => assertAmount("0.25", "0.25"));
  test("an address in the sentence is not an amount", () =>
    assertAmount(`pay 0.01 to 0x${"1".repeat(40)}`, "0.01"));
  test("a fiat figure is context, not the amount", () =>
    assertAmount("we made $2000 this week, pay out 0.03", "0.03"));
  test("a transaction hash is not an amount", () =>
    assertAmount(`after 0x${"a".repeat(64)} settled, send 0.5`, "0.5"));
  test("whole units", () => assertAmount("transfer 2", "2"));
});

describe("extractAmount — the overpayments this exists to prevent", () => {
  // Each of these parsed as the WRONG number before the parser was hardened,
  // and each would have moved real money.
  test("a count of contributors is not the amount", () =>
    assertRefused("pay the 3 contributors 0.01 each", /not clear which number/));

  test("a year is not the amount", () =>
    assertRefused("split the 2026 revenue: 0.5", /not clear which number/));

  test("two marked amounts are ambiguous, not first-wins", () =>
    assertRefused("send 0.5 and pay out 0.01", /more than one amount/));
});

describe("extractAmount — malformed input is refused, never coerced", () => {
  test("negative amounts", () => assertRefused("pay out -0.5", /negative/));
  test("exponent notation", () => assertRefused("pay out 1e18", /exponent notation/));
  test("zero", () => assertRefused("pay out 0", /greater than zero/));
  test("no number at all", () => assertRefused("pay everyone what we owe", /no amount given/));
  test("empty message", () => assertRefused("", /no amount given/));
  test("more precision than the asset has", () =>
    assertRefused("send 0.0000000000000000001", /precision/));
});

describe("extractAmount — result shape", () => {
  test("refusals always explain themselves", () => {
    for (const text of ["pay everyone", "pay out -1", "pay the 3 contributors 0.01"]) {
      const result = parse(text);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.reason.length > 5, `reason too terse for "${text}"`);
      }
    }
  });

  test("never returns a non-positive amount on success", () => {
    for (const text of ["pay out 0.01", "0.25", "transfer 2"]) {
      const result = parse(text);
      if (result.ok) assert.ok(result.amount > 0n);
    }
  });
});
