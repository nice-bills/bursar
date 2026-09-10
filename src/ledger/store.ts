/**
 * Append-only treasury ledger.
 *
 * The failure that actually hurts a treasury is not a reverted transaction — it
 * is a process that dies between "money left" and "we wrote it down". So every
 * movement is recorded as an *intent* before it is submitted, and closed out
 * afterwards. A crash then leaves an open intent we can reconcile against the
 * chain, instead of a silent gap.
 *
 * Storage is JSONL: append-only, survives partial writes at line granularity,
 * greppable, and diffable. A database would be nicer for queries and worse for
 * everything else at this size.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

export type Leg = "sweep" | "payout" | "float" | "yield";

export type EntryStatus = "intent" | "submitted" | "confirmed" | "failed" | "abandoned";

export interface LedgerEntry {
  /** Deterministic id — also used as the KeeperHub idempotency key. */
  intentId: string;
  status: EntryStatus;
  leg: Leg;
  chainId: number;
  /** Recipient. For yield deposits this is the pool address. */
  to: string;
  /** Base units, decimal string. */
  amount: string;
  /** ERC-20 address, or null for the chain's native asset. */
  token: string | null;
  /** Free-text: contributor name, "gas top-up", etc. */
  memo: string;
  executionId?: string;
  transactionHashes?: string[];
  error?: string;
  at: string;
}

export class Ledger {
  constructor(private readonly path = "data/ledger.jsonl") {}

  /**
   * Derive a stable intent id from the movement's identity.
   *
   * Same leg + recipient + amount + token + period collapses to the same id, so
   * a retried sweep in the same window reuses the idempotency key and cannot
   * double-send. `nonce` is the escape hatch for a deliberate second payment.
   */
  static intentId(input: {
    leg: Leg;
    chainId: number;
    to: string;
    amount: string;
    token: string | null;
    period: string;
    nonce?: string;
  }): string {
    const material = [
      input.leg,
      input.chainId,
      input.to.toLowerCase(),
      input.amount,
      input.token?.toLowerCase() ?? "native",
      input.period,
      input.nonce ?? "",
    ].join("|");
    return `bursar-${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
  }

  async append(entry: Omit<LedgerEntry, "at">): Promise<LedgerEntry> {
    const full: LedgerEntry = { ...entry, at: new Date().toISOString() };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }

  async all(): Promise<LedgerEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return [];
    }

    const entries: LedgerEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as LedgerEntry);
      } catch {
        // A torn final line from a hard kill. Skip it rather than refusing to
        // read the entire ledger.
        console.warn("[bursar] skipping unparseable ledger line");
      }
    }
    return entries;
  }

  /**
   * Latest state per intent. Later entries supersede earlier ones, so an intent
   * that was written then confirmed reads as confirmed.
   */
  async latestByIntent(): Promise<Map<string, LedgerEntry>> {
    const latest = new Map<string, LedgerEntry>();
    for (const entry of await this.all()) latest.set(entry.intentId, entry);
    return latest;
  }

  /**
   * Intents that were written but never reached a terminal state. These are the
   * ones that need reconciling against the chain before we move more money.
   */
  async openIntents(): Promise<LedgerEntry[]> {
    const latest = await this.latestByIntent();
    return [...latest.values()].filter(
      (e) => e.status === "intent" || e.status === "submitted",
    );
  }

  /**
   * Total moved in the trailing window, for the daily cap.
   *
   * Counts anything that left or may have left — submitted and intent included,
   * not just confirmed. Assuming an in-flight transfer didn't happen is exactly
   * how a daily limit gets breached.
   */
  async movedSince(since: Date, token: string | null = null): Promise<bigint> {
    const latest = await this.latestByIntent();
    let total = 0n;
    for (const entry of latest.values()) {
      if (entry.status === "failed" || entry.status === "abandoned") continue;
      if (new Date(entry.at) < since) continue;
      const sameToken =
        token === null
          ? entry.token === null
          : entry.token?.toLowerCase() === token.toLowerCase();
      if (!sameToken) continue;
      total += BigInt(entry.amount);
    }
    return total;
  }

  /** True if this exact movement already reached a terminal success. */
  async alreadyConfirmed(intentId: string): Promise<boolean> {
    const latest = await this.latestByIntent();
    return latest.get(intentId)?.status === "confirmed";
  }
}

/** Period key for intent derivation — collapses retries within the same hour. */
export function hourlyPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

/** Coarser period for legs that should run at most once a day. */
export function dailyPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}
