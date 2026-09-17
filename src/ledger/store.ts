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

import { mkdir, open, readFile, writeFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

/**
 * `purchase` is the agent buying something — paying another agent's x402
 * invoice for a service it wanted. It is outbound like a payout and counted
 * against every cap for the same reason, but kept distinct because "we paid a
 * contributor" and "we bought a counterparty check" are different questions to
 * ask the ledger later.
 *
 * `earning` is the only leg that points inward.
 *
 * Everything else here is the treasury spending; an earning is the treasury
 * being paid — an x402 call settling against a listed workflow. It shares the
 * entry shape because it is the same kind of fact (an amount, an asset, a
 * counterparty, a transaction) and because the split that follows has to be
 * auditable against the income that justified it.
 */
export type Leg = "sweep" | "payout" | "float" | "yield" | "earning" | "purchase";

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

/**
 * How a movement was sent, recorded so it can be replayed exactly.
 *
 * A closure cannot survive a restart, and reconciling a movement by guessing
 * the route is how an Aave supply becomes a raw transfer into the pool. The
 * route is part of the movement's identity, so it lives in the ledger.
 */
export type SubmissionRoute =
  | { kind: "transfer" }
  /**
   * Paid directly from the payer key over x402, never through KeeperHub.
   *
   * KeeperHub has never seen this intent id, so replaying it there would not be
   * an idempotent no-op — it would be a second, real payment. Reconciliation
   * reports these rather than replaying them.
   */
  | { kind: "x402"; url: string }
  | {
      kind: "workflow";
      workflowId: string;
      /**
       * An ERC-20 allowance the workflow needs before it can pull the tokens.
       *
       * Recorded rather than granted up front: authority to spend should not
       * exist before the policy engine has decided the spend may happen, and a
       * movement held for a person must not leave a standing allowance sitting
       * behind it while it waits.
       */
      allowance?: { chainId: number; token: string; spender: string; amount: string };
    };

export interface LedgerEntry {
  /** How this movement reaches the chain. Absent on rows written before routes were recorded. */
  submission?: SubmissionRoute;
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
 * approved. `approved` is the same: it records a person's decision, not a
 * transfer. Counting it would make every approval collide with its own amount
 * on the way back through the caps, and the movement it authorises is recorded
 * separately when it actually goes out.
 */
const NOT_SPENT = new Set<EntryStatus>([
  "failed",
  "abandoned",
  "awaiting_approval",
  "approved",
  "declined",
]);

/**
 * Legs that bring value in rather than send it out.
 *
 * Every aggregate below exists to answer "how much have we spent", and they all
 * work by summing entry amounts. An inbound leg summed alongside outbound ones
 * would read as spending that never happened, quietly eating the daily cap and
 * making the treasury refuse payouts it should have made. Income is counted, but
 * it is counted separately.
 */
const INBOUND = new Set<Leg>(["earning"]);

/** A crashed holder should not wedge the treasury forever. */
const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Serialises check-then-act sequences against one ledger.
 *
 * It lives here rather than in the Executor because the ledger is the shared
 * thing. Every path that reads the caps and then writes a movement has to take
 * the same lock, and the x402 purchase path does not go through the Executor —
 * so a mutex owned by the Executor left that path racing every other one.
 */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Keep the chain alive even when a caller rejects, or one failure would
    // poison every movement that follows it.
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class Ledger {
  private lockPath: string;
  private holdsLock = false;
  /**
   * Proves this instance owns the lock file it is about to delete.
   *
   * A pid is not enough: after a stale takeover two processes can briefly both
   * believe they hold the lock, and `release()` unlinking unconditionally would
   * delete whichever lock happens to be there — including a live one belonging
   * to someone else.
   */
  private lockToken?: string;

  private readonly mutex = new Mutex();

  constructor(private readonly path = "data/ledger.jsonl") {
    this.lockPath = `${this.path}.lock`;
  }

  /**
   * Run a read-then-write sequence with no other such sequence interleaved.
   *
   * Not reentrant: code already inside `serialize` must call the underlying
   * methods directly rather than nesting another call.
   */
  serialize<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(fn);
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
      const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      try {
        await writeFile(
          this.lockPath,
          JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }),
          { flag: "wx" },
        );
        // Read it back. If a concurrent stale-takeover unlinked ours between
        // the create and now, the file on disk is someone else's and this
        // instance does not hold the lock it thinks it does.
        const written = await this.readLock();
        if (written?.token !== token) continue;
        this.lockToken = token;
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
    const token = this.lockToken;
    this.holdsLock = false;
    this.lockToken = undefined;
    // Only remove the lock if it is still ours.
    const holder = await this.readLock();
    if (holder && holder.token !== token) return;
    await unlink(this.lockPath).catch(() => undefined);
  }

  private async readLock(): Promise<{ pid: number; at: string; token?: string } | null> {
    try {
      const parsed = JSON.parse(await readFile(this.lockPath, "utf8")) as {
        pid?: number;
        at?: string;
        token?: string;
      };
      if (typeof parsed.pid !== "number" || typeof parsed.at !== "string") return null;
      return {
        pid: parsed.pid,
        at: parsed.at,
        ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
      };
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

  /**
   * `at` is stamped here, not taken from the caller, so a movement cannot
   * backdate itself out of the rolling window that bounds the daily caps.
   *
   * `now` exists only so tests can construct an aged ledger: the 24h window —
   * the mechanism by which a daily cap resets — was otherwise unreachable
   * through the public API and therefore untested.
   */
  async append(
    entry: Omit<LedgerEntry, "at">,
    now: Date = new Date(),
  ): Promise<LedgerEntry> {
    const full: LedgerEntry = { ...entry, at: now.toISOString() };
    await mkdir(dirname(this.path), { recursive: true });
    // Append AND flush. `appendFile` returns once the bytes are in the page
    // cache, which survives `kill -9` but not a power loss or a host failure —
    // and the window this record exists to cover is precisely the one where the
    // machine stops between writing the intent and submitting the movement.
    const handle = await open(this.path, "a");
    try {
      await handle.writeFile(`${JSON.stringify(full)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
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
      if (INBOUND.has(entry.leg)) continue;
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
      if (INBOUND.has(entry.leg)) continue;
      if (new Date(entry.at) < since) continue;
      if (!entry.valueUsdCents) continue;
      total += BigInt(entry.valueUsdCents);
    }
    return total;
  }

  /**
   * Revenue received in the trailing window.
   *
   * The counterpart to `movedSince`, and the basis for a split: you cannot
   * honestly distribute earnings without a number for what was earned. Only
   * confirmed income counts — an expected payment is not money, and paying
   * contributors out of revenue that has not settled is how a treasury
   * discovers it was never solvent.
   */
  async earnedSince(since: Date, token: string | null = null): Promise<bigint> {
    const latest = await this.latestByIntent();
    let total = 0n;
    for (const entry of latest.values()) {
      if (!INBOUND.has(entry.leg)) continue;
      if (entry.status !== "confirmed") continue;
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
