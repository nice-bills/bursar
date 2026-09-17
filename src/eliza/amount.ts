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
 *
 * The notations below are refused rather than interpreted, because each of them
 * used to parse as a number that was wrong by orders of magnitude:
 *
 *   - "1,000"  — digit grouping; the comma was dropped and this moved 1
 *   - "1.5k"   — magnitude suffixes; the suffix was dropped and this moved 1.5
 *   - "3 wei"  — a sub-unit; the number was re-scaled and this moved 3 ether
 *   - "20 USDC" when the asset is ETH — a denomination we are not moving
 *
 * and a bare ".5" is read as one half, never as five.
 */

import { parseUnits, UnitsError } from "../units.js";

/** Words that mark the number after them as the amount being moved. */
const MARKER = /\b(?:pay|payout|out|distribute|split|send|transfer|disburse|allocate)\s*$/i;

/**
 * Denominations of the native asset, and what scale each one is written in.
 * `wei` is already base units — re-scaling it by the asset's decimals is the
 * 1e18x mistake this table exists to stop.
 */
const NATIVE_UNITS: Record<string, number | "base"> = {
  wei: "base",
  gwei: 9,
  eth: 18,
  ether: 18,
};

/**
 * Currency words we recognise well enough to notice a mismatch. A number
 * followed by one of these states the denomination it is written in; if that is
 * not the asset being moved, the sentence means something we cannot honour, and
 * silently moving the same figure in a different asset is how "20 USDC" becomes
 * twenty ether.
 */
const CURRENCY_WORDS = new Set([
  ...Object.keys(NATIVE_UNITS),
  "usdc",
  "usdt",
  "dai",
  "weth",
  "link",
  "btc",
  "wbtc",
  "matic",
  "sol",
  "usd",
  "eur",
  "gbp",
]);

/** Hex literals — addresses and tx hashes — contain digits that are not amounts. */
const HEX = /0x[0-9a-fA-F]+/g;

/** A comma between digits is grouping in one locale and a decimal point in another. */
const GROUPED_DIGITS = /\d,\d/;

/** "1.5k", "2m", "3bn" — a multiplier we will not guess at. */
const MAGNITUDE_SUFFIX = /\d\s?(?:k|m|bn)\b/i;

const NUMBER = /(?<neg>-\s*)?(?<fiat>[$€£]\s*)?(?<num>\d+(?:\.\d+)?|\.\d+)(?<sci>\s*e[+-]?\d+)?/gi;

export type AmountResult =
  | { ok: true; amount: bigint }
  | { ok: false; reason: string };

/** The word, if any, immediately following a number. */
function unitAfter(text: string): string | undefined {
  const match = /^\s*([a-z]+)\b/i.exec(text);
  return match?.[1]?.toLowerCase();
}

/**
 * Extract a single unambiguous amount, in base units.
 *
 * `symbol` is the asset the amount will be moved in. It is what lets a stated
 * denomination be checked rather than ignored.
 *
 * Returns a reason on failure so the action can tell the user what was wrong
 * rather than silently declining.
 */
export function extractAmount(text: string, decimals: number, symbol = "ETH"): AmountResult {
  if (!text.trim()) return { ok: false, reason: "no amount given" };

  // Blank out hex so an address's digits are never mistaken for an amount.
  const cleaned = text.replace(HEX, (match) => " ".repeat(match.length));

  // Notations that used to be silently truncated. Refuse the whole message:
  // "1,000" is a thousand to one reader and one to another, and we move money.
  if (GROUPED_DIGITS.test(cleaned)) {
    return {
      ok: false,
      reason:
        "a comma between digits is grouping in some locales and a decimal point in others; " +
        `write it without separators, e.g. "pay out 1000"`,
    };
  }
  if (MAGNITUDE_SUFFIX.test(cleaned)) {
    return {
      ok: false,
      reason: `a magnitude suffix like "k" or "m" is ambiguous; write the number out in full`,
    };
  }

  const wanted = symbol.toLowerCase();
  const nativeAsset = decimals === 18 && (wanted === "eth" || wanted === "ether");

  const candidates: Array<{ raw: string; strong: boolean; unit?: string }> = [];

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
    const after = cleaned.slice(index + raw.length, index + raw.length + 12);
    const unit = unitAfter(after);

    // A denomination we recognise, that is not the one being moved, is a
    // refusal rather than a number to reinterpret.
    if (unit && CURRENCY_WORDS.has(unit)) {
      const acceptable = unit === wanted || (nativeAsset && unit in NATIVE_UNITS);
      if (!acceptable) {
        return {
          ok: false,
          reason: `the amount is written in ${unit.toUpperCase()}, but this movement is in ${symbol}`,
        };
      }
    }

    const marked = MARKER.test(before);
    const denominated = unit !== undefined && CURRENCY_WORDS.has(unit);
    candidates.push({ raw, strong: marked || denominated, ...(unit ? { unit } : {}) });
  }

  if (candidates.length === 0) return { ok: false, reason: "no amount given" };

  const strong = candidates.filter((c) => c.strong);

  let chosen: { raw: string; unit?: string } | undefined;
  if (strong.length === 1) {
    chosen = strong[0];
  } else if (strong.length > 1) {
    return {
      ok: false,
      reason: `the message names more than one amount (${strong.map((c) => c.raw).join(", ")})`,
    };
  } else if (candidates.length === 1 && isBareNumber(cleaned, candidates[0]!.raw)) {
    // No marker, but the message is the number and nothing else — there is
    // nothing it could be confused with. A number sitting inside a sentence
    // ("who are the 3 contributors?") is not an instruction to move it.
    chosen = candidates[0];
  } else {
    return {
      ok: false,
      reason:
        `it is not clear which number is the amount (${candidates.map((c) => c.raw).join(", ")}). ` +
        `Say it explicitly, e.g. "pay out 0.01".`,
    };
  }

  if (chosen === undefined) return { ok: false, reason: "no amount given" };

  const scale = chosen.unit ? NATIVE_UNITS[chosen.unit] : undefined;

  let amount: bigint;
  try {
    if (scale === "base") {
      // Already base units. A fractional wei does not exist.
      if (chosen.raw.includes(".")) {
        return { ok: false, reason: "wei is the smallest unit; it cannot have a fractional part" };
      }
      amount = BigInt(chosen.raw);
    } else {
      amount = parseUnits(chosen.raw, scale ?? decimals);
    }
  } catch (error) {
    if (error instanceof UnitsError) return { ok: false, reason: error.message };
    throw error;
  }

  if (amount <= 0n) return { ok: false, reason: "amount must be greater than zero" };
  return { ok: true, amount };
}

/** True when the message carries no words beyond the number and its unit. */
function isBareNumber(cleaned: string, raw: string): boolean {
  const residue = cleaned.replace(raw, " ");
  const words = residue.match(/[a-z]+/gi) ?? [];
  return words.every((word) => CURRENCY_WORDS.has(word.toLowerCase()));
}
