/**
 * What a movement is worth, in money rather than in units of itself.
 *
 * Per-asset caps stop any one token running away, but they say nothing about
 * the total. A treasury holding six assets, each capped generously, has no
 * ceiling at all on what leaves in a day.
 *
 * Valuing a movement needs a price, and a treasury that reaches out to some
 * arbitrary price API to decide whether it may spend has quietly taken on a
 * dependency nobody audited. So the price is read the same way the money moves:
 * a Chainlink aggregator, called through KeeperHub, landing in the same
 * execution history as every transfer. The oracle becomes part of the record
 * rather than a footnote to it.
 *
 * Everything here is integer arithmetic on bigints. A valuation that rounds is
 * a valuation that can be walked past a limit one satoshi at a time.
 */

import type { KeeperHubClient } from "../keeperhub/client.js";

/** Chainlink's AggregatorV3 surface, reduced to the two calls we need. */
const AGGREGATOR_ABI = JSON.stringify([
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
]);

export class ValuationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValuationError";
  }
}

export interface Quote {
  /** Price of one whole unit of the asset, in USD, scaled by `decimals`. */
  price: bigint;
  decimals: number;
  /** When the feed last published, as a unix timestamp. */
  updatedAt: number;
  feed: string;
}

interface CacheEntry {
  quote: Quote;
  readAt: number;
}

export class Valuation {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly client: KeeperHubClient,
    /**
     * How long a quote may be reused within this process. Short, because the
     * point of the cap is to bind during a burst of movements, and a burst is
     * exactly when a stale price is most convenient to nobody.
     */
    private readonly cacheMs = 60_000,
    /**
     * How old the feed's own publication may be. Chainlink feeds have a
     * heartbeat; past it, the price is not wrong so much as unknown.
     */
    private readonly maxAgeSeconds = 3_600,
  ) {}

  /**
   * Read a price feed.
   *
   * Throws rather than returning a fallback. A valuation that silently degrades
   * to "probably fine" is worse than no valuation, because the cap it feeds
   * will keep reporting that everything is within limits.
   */
  async quote(chainId: number, feed: string): Promise<Quote> {
    const key = `${chainId}:${feed.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.readAt < this.cacheMs) return cached.quote;

    const [round, decimalsResult] = await Promise.all([
      this.read(chainId, feed, "latestRoundData"),
      this.read(chainId, feed, "decimals"),
    ]);

    const data = round as { answer?: unknown; updatedAt?: unknown } | null;
    const answer = toBigInt(data?.answer);
    const updatedAt = Number(toBigInt(data?.updatedAt) ?? 0n);
    const decimals = Number(toBigInt(decimalsResult) ?? -1n);

    if (answer === null || answer <= 0n) {
      throw new ValuationError(`Feed ${feed} returned no usable price`);
    }
    if (decimals < 0 || decimals > 36) {
      throw new ValuationError(`Feed ${feed} reported implausible decimals: ${decimals}`);
    }

    // An unreadable timestamp is not a fresh one. `updatedAt > 0` meant a feed
    // reporting it as hex, as an ISO string, or not at all silently disabled
    // the only check standing between the treasury and an unknown price —
    // while everything else on this path fails closed.
    if (updatedAt <= 0) {
      throw new ValuationError(
        `Feed ${feed} reported no usable publish time, so its age cannot be checked. ` +
          `Refusing to value a movement against a price of unknown vintage.`,
      );
    }

    const age = Math.floor(Date.now() / 1000) - updatedAt;
    if (age > this.maxAgeSeconds) {
      throw new ValuationError(
        `Feed ${feed} last published ${age}s ago, over the ${this.maxAgeSeconds}s limit. ` +
          `Refusing to value a movement against a stale price.`,
      );
    }

    const quote: Quote = { price: answer, decimals, updatedAt, feed };
    this.cache.set(key, { quote, readAt: Date.now() });
    return quote;
  }

  /**
   * Value an amount in whole US cents, rounding down.
   *
   * Rounding down is deliberate: it can only ever understate what a movement is
   * worth by less than a cent, and the cap is a ceiling, so the error never
   * lets more money out than intended.
   */
  async valueInCents(
    amountBaseUnits: bigint,
    assetDecimals: number,
    chainId: number,
    feed: string,
  ): Promise<bigint> {
    const quote = await this.quote(chainId, feed);
    return (
      (amountBaseUnits * quote.price * 100n) /
      (10n ** BigInt(assetDecimals) * 10n ** BigInt(quote.decimals))
    );
  }

  private async read(chainId: number, contractAddress: string, functionName: string) {
    const result = await this.client.contractCall(
      {
        chainId: String(chainId),
        contractAddress,
        abi: AGGREGATOR_ABI,
        functionName,
        functionArgs: "[]",
      },
      // A read changes nothing, but the client requires a key on every write
      // verb, and the endpoint is a POST. Keyed by what is being read AND by
      // the window it is being read in: a constant key makes every later read
      // an idempotent replay of the very first one, so the price freezes at
      // whatever it was the first time this process ever asked — and once that
      // frozen round ages past maxPriceAgeSeconds, every valuation fails closed
      // forever. The bucket keeps a retry inside one window answered from the
      // same round, which is all the key was ever for.
      `read-${chainId}-${contractAddress}-${functionName}-${Math.floor(Date.now() / this.cacheMs)}`,
    );

    const raw = result.raw as { result?: unknown } | undefined;
    return raw?.result ?? result.output ?? null;
  }
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

/** Format cents for a human, e.g. 123456n -> "$1,234.56". */
export function formatUsd(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${whole}.${frac}`;
}
