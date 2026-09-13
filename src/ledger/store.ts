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

import { appendFile, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

export type Leg = "sweep" | "payout" | "float" | "yield";

export type EntryStatus =
  | "intent"
  | "submitted"
  | "confirmed"
  | "failed"
  | "abandoned"
  /** Held for a human. Nothing has been sent and nothing will be without a decision. */
  | "awaiting_approval"
  | "approved"
  | "declined";

export interface LedgerEntry {
  /** Deterministic id — also used as the KeeperHub idempotency key. */
  intentId: string;
  status: EntryStatus;
  leg: Leg;
  chainId: number;
  /** Recipient. For yield deposits this is the pool address. */
  to: string;
  /** Base units, as an integer string. */
  amount: string;
  /** ERC-20 address, or null for the chain's native asset. */
  token: string | null;
  /** Decimals of the asset, so the ledger is readable without config context. */
  decimals: number;
  /** Explorer URLs for the confirmed transactions. */
  transactionLinks?: string[];
  /**
   * What the movement was worth in whole US cents when it was approved, so the
   * cross-asset ceiling can be summed without re-pricing history at today's
   * rates. A limit that moves with the market is not a limit.
   */
  valueUsdCents?: string;
  /** Free-text: contributor name, "gas top-up", etc. */
  memo: string;
  /** Why a movement was held, so whoever decides can see what they are deciding. */
  heldReason?: string;
  /** Who released or declined it, recorded because an approval is an act. */
  decidedBy?: string;
  executionId?: string;
  transactionHashes?: string[];
  error?: string;
  at: string;
}

/**
 * Statuses where no value left the treasury.
 *
 * A held or declined movement has not moved, so counting it against the daily
 * caps would let a pile of unapproved requests starve the ones that are
 * approved.
 */
const NOT_SPENT = new Set<EntryStatus>(["failed", "abandoned", "awaiting_approval", "declined"]);

/** A crashed holder should not wedge the treasury forever. */
const LOCK_STALE_MS = 10 * 60 * 1000;

export class Ledger {
  private lockPath: string;
  private holdsLock = false;

  constructor(private readonly path = "data/ledger.jsonl") {
    this.lockPath = `${this.path}.lock`;
  }

  /**
   * Claim exclusive write access to this ledger file.
   *
   * The executor's mutex serialises movements within one process. It says
   * nothing about two processes — an agent and a script, or two agents pointed
   * at the same file — and those would each read the ledger before either
   * wrote, exactly the race the mutex exists to prevent.
   *
   * Advisory, not enforced by the OS: a stale lock from a killed process is
   * taken over rather than honoured, because a treasury that cannot reconcile
   * after a crash is worse than one that risks a rare concurrent write.
   */
  async acquire(): Promise<void> {
    if (this.holdsLock) return;
    await mkdir(dirname(this.path), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(
          this.lockPath,
          JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
          { flag: "wx" },
        );
        this.holdsLock = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

        const holder = await this.readLock();
        if (holder && this.holderIsAlive(holder)) {
          throw new Error(
            `Ledger ${this.path} is locked by pid ${holder.pid} (since ${holder.at}). ` +
              `Another Bursar process is writing it. Stop it, or point this one at a ` +
              `different BURSAR_LEDGER_PATH.`,
          );
        }
        // Stale or unreadable: take it over and retry the exclusive create.
        await unlink(this.lockPath).catch(() => undefined);
      }
    }
    throw new Error(`Could not acquire the ledger lock at ${this.lockPath}`);
  }

  async release(): Promise<void> {
    if (!this.holdsLock) return;
    this.holdsLock = false;
    await unlink(this.lockPath).catch(() => undefined);
  }

  private async readLock(): Promise<{ pid: number; at: string } | null> {
    try {
      const parsed = JSON.parse(await readFile(this.lockPath, "utf8")) as {
        pid?: number;
        at?: string;
      };
      if (typeof parsed.pid !== "number" || typeof parsed.at !== "string") return null;
      return { pid: parsed.pid, at: parsed.at };
    } catch {
      return null;
    }
  }

  private holderIsAlive(holder: { pid: number; at: string }): boolean {
    if (Date.now() - new Date(holder.at).getTime() > LOCK_STALE_MS) return false;
    // Deliberately no exemption for our own pid: two Ledger instances in one
    // process pointed at the same file is a bug worth surfacing, not a case to
    // wave through. Re-acquiring on the same instance is already a no-op, and
    // a genuine stale lock after a same-pid restart clears on the timeout.
    try {
      // Signal 0 tests for existence without touching the process.
      process.kill(holder.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

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
   * Movements held for a human, oldest first.
   *
   * These are not failures. Nothing has been sent, and nothing will be until
   * someone decides, so they sit apart from the reconciliation path.
   */
  async awaitingApproval(): Promise<LedgerEntry[]> {
    const latest = await this.latestByIntent();
    return [...latest.values()]
      .filter((e) => e.status === "awaiting_approval")
      .sort((a, b) => a.at.localeCompare(b.at));
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
      if (NOT_SPENT.has(entry.status)) continue;
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

  /**
   * Total value moved in the trailing window, in US cents, across every asset.
   *
   * Uses the valuation recorded at approval time. Re-pricing history would mean
   * a movement that was inside the ceiling yesterday could push today's total
   * over it purely because the market moved.
   */
  async valueMovedSince(since: Date): Promise<bigint> {
    const latest = await this.latestByIntent();
    let total = 0n;
    for (const entry of latest.values()) {
      if (NOT_SPENT.has(entry.status)) continue;
      if (new Date(entry.at) < since) continue;
      if (!entry.valueUsdCents) continue;
      total += BigInt(entry.valueUsdCents);
    }
    return total;
  }

  /** True if a person has released this movement. */
  async isApproved(intentId: string): Promise<boolean> {
    return (await this.latestByIntent()).get(intentId)?.status === "approved";
  }

  /** True if this exact movement already reached a terminal success. */
  async alreadyConfirmed(intentId: string): Promise<boolean> {
    const latest = await this.latestByIntent();
    return latest.get(intentId)?.status === "confirmed";
  }
}

/** Coarser period for legs that should run at most once a day. */
export function dailyPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}
