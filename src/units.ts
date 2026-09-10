/**
 * Conversion between base units and the decimal strings the KeeperHub API wants.
 *
 * Bursar reasons in base units (bigint) everywhere internally: shares, caps,
 * and ledger totals are exact integer math, and a float would silently lose
 * wei. But `POST /execute/transfer` takes a human-readable decimal string, so
 * the conversion happens exactly here, at the boundary, and nowhere else.
 *
 * Confirmed empirically: sending "1000000000000" for a 1e-6 ETH transfer was
 * interpreted as a trillion ETH and rejected by the spending cap.
 */

/** Native assets on every EVM chain KeeperHub supports use 18 decimals. */
export const NATIVE_DECIMALS = 18;

export class UnitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitsError";
  }
}

/**
 * Base units -> decimal string, exactly.
 *
 * No rounding, no exponent notation, no trailing-zero noise:
 * formatUnits(1000000000000n, 18) === "0.000001"
 */
export function formatUnits(value: bigint, decimals: number): string {
  assertDecimals(decimals);
  if (decimals === 0) return value.toString();

  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");

  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");

  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Decimal string -> base units, exactly.
 *
 * Throws rather than rounding when the input carries more precision than the
 * asset can represent. Silently truncating a user's amount is how you end up
 * transferring the wrong number.
 */
export function parseUnits(value: string, decimals: number): bigint {
  assertDecimals(decimals);

  const trimmed = value.trim();
  if (!/^-?\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === "." || trimmed === "-") {
    throw new UnitsError(`"${value}" is not a decimal number`);
  }

  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart = "", fractionPart = ""] = unsigned.split(".");

  if (fractionPart.length > decimals) {
    // Allow trailing zeros beyond precision — "1.5000" at 2 decimals is fine —
    // but refuse anything that would actually be lost.
    const excess = fractionPart.slice(decimals);
    if (/[^0]/.test(excess)) {
      throw new UnitsError(
        `"${value}" has more precision than ${decimals} decimals can represent`,
      );
    }
  }

  const padded = fractionPart.padEnd(decimals, "0").slice(0, decimals);
  const result = BigInt(`${wholePart || "0"}${padded}`);
  return negative ? -result : result;
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new UnitsError(`decimals must be an integer in [0, 36], got ${decimals}`);
  }
}
