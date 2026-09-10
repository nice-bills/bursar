/**
 * Reading an amount out of a human sentence.
 *
 * This is security-relevant, not a convenience. The naive version — take the
 * first number in the string — reads "pay the 3 contributors 0.01 each" as
 * three ether, a 300x overpayment, and "we made $2000, pay out 0.03" as two
 * thousand. Both parse cleanly and move the wrong money.
 *
 * So the rule here is: only act on an amount when the sentence makes it
 * unambiguous. Refusing forces the agent to ask a clarifying question, which
 * costs one message. Guessing costs the treasury.
 */

import { parseUnits, UnitsError } from "../units.js";

/** Words that mark the number after them as the amount being moved. */
const MARKER = /\b(?:pay|payout|out|distribute|split|send|transfer|disburse|allocate)\s*$/i;

/** A unit immediately after a number also identifies it as the amount. */
const UNIT = /^\s*(?:eth|ether|wei)\b/i;

/** Hex literals — addresses and tx hashes — contain digits that are not amounts. */
const HEX = /0x[0-9a-fA-F]+/g;

const NUMBER = /(?<neg>-\s*)?(?<fiat>[$€£]\s*)?(?<num>\d+(?:\.\d+)?)(?<sci>\s*e[+-]?\d+)?/gi;

export type AmountResult =
  | { ok: true; amount: bigint }
  | { ok: false; reason: string };

/**
 * Extract a single unambiguous amount, in base units.
 *
 * Returns a reason on failure so the action can tell the user what was wrong
 * rather than silently declining.
 */
export function extractAmount(text: string, decimals: number): AmountResult {
  if (!text.trim()) return { ok: false, reason: "no amount given" };

  // Blank out hex so an address's digits are never mistaken for an amount.
  const cleaned = text.replace(HEX, (match) => " ".repeat(match.length));

  const candidates: Array<{ raw: string; strong: boolean }> = [];

  for (const match of cleaned.matchAll(NUMBER)) {
    const groups = match.groups ?? {};
    const index = match.index ?? 0;

    // Scientific notation is ambiguous to a reader and to us: "1e18" would
    // otherwise be read as 1. Refuse the whole message rather than pick.
    if (groups.sci) {
      return { ok: false, reason: `"${match[0].trim()}" uses exponent notation; write it out in full` };
    }

    // A negative amount is never a valid movement, and silently taking the
    // absolute value would move money the user asked to claw back.
    if (groups.neg) {
      return { ok: false, reason: "amount is negative" };
    }

    // A fiat figure is context ("we earned $2000"), not the amount to send.
    if (groups.fiat) continue;

    const raw = groups.num;
    if (!raw) continue;

    const before = cleaned.slice(Math.max(0, index - 24), index);
    const after = cleaned.slice(index + raw.length, index + raw.length + 8);

    candidates.push({ raw, strong: MARKER.test(before) || UNIT.test(after) });
  }

  if (candidates.length === 0) return { ok: false, reason: "no amount given" };

  const strong = candidates.filter((c) => c.strong);

  let chosen: string | undefined;
  if (strong.length === 1) {
    chosen = strong[0]?.raw;
  } else if (strong.length > 1) {
    return {
      ok: false,
      reason: `the message names more than one amount (${strong.map((c) => c.raw).join(", ")})`,
    };
  } else if (candidates.length === 1) {
    // No marker, but only one number in the sentence — nothing to confuse it with.
    chosen = candidates[0]?.raw;
  } else {
    return {
      ok: false,
      reason:
        `it is not clear which number is the amount (${candidates.map((c) => c.raw).join(", ")}). ` +
        `Say it explicitly, e.g. "pay out 0.01".`,
    };
  }

  if (chosen === undefined) return { ok: false, reason: "no amount given" };

  let amount: bigint;
  try {
    amount = parseUnits(chosen, decimals);
  } catch (error) {
    if (error instanceof UnitsError) return { ok: false, reason: error.message };
    throw error;
  }

  if (amount <= 0n) return { ok: false, reason: "amount must be greater than zero" };
  return { ok: true, amount };
}
