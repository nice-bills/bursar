/**
 * Typed HTTP client for the KeeperHub REST API.
 *
 * Response shapes are deliberately loose (`unknown` / index signatures) until
 * the smoke test has confirmed them against a live org. Everything that reaches
 * the rest of the codebase goes through a `normalize*` function so a schema
 * surprise fails in one place instead of ten.
 */

import { createHash } from "node:crypto";

const DEFAULT_BASE_URL = "https://app.keeperhub.com/api";

/** Documented limit is 60 requests/minute per API key. Stay under it. */
const RATE_LIMIT_PER_MINUTE = 55;

export class KeeperHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "KeeperHubError";
  }

  /**
   * Worth another attempt: rate limits, server faults, and conflicts.
   *
   * 409 is the interesting one. KeeperHub returns it while an earlier transfer
   * from the same wallet is still being broadcast — a second payout in a batch
   * hits it routinely. Retrying would normally be the dangerous choice, but
   * every write here carries a stable idempotency key, so the retry either
   * finds the original execution or is the first to land. Observed live: a 409
   * came back for a transfer that had in fact succeeded, and only the
   * idempotency key kept the recovery from paying twice.
   */
  get retryable(): boolean {
    return this.status === 429 || this.status === 409 || this.status >= 500;
  }
}

/**
 * A transaction as a workflow execution reports it.
 *
 * Direct execution returns a bare hash string; workflow execution returns this
 * richer record, with the receipt already verified. It is strictly better for
 * an audit trail, so it is kept rather than flattened away.
 */
export interface TransactionRecord {
  hash: string;
  chainId?: number;
  gasUsed?: string;
  blockNumber?: number;
  receiptStatus?: string;
  verified?: boolean;
  nodeName?: string;
}

export interface ExecutionResult {
  executionId: string;
  status: string;
  transactionHashes: string[];
  /** Explorer URLs, when the API supplies them. These go in the demo/report. */
  transactionLinks: string[];
  /** Full receipt records, when the execution reports them. */
  transactions: TransactionRecord[];
  /**
   * True when the API recognised our idempotency key and returned the original
   * execution instead of running a second one. Confirmed working against the
   * live API — this is what makes replay-based reconciliation safe.
   */
  idempotentReplay: boolean;
  output: unknown;
  /** The unparsed payload, so callers can dig into fields we don't model yet. */
  raw: Record<string, unknown>;
}

export interface TransferParams {
  chainId: string;
  /** The API's field name is `recipientAddress` — not `to`. */
  recipientAddress: string;
  /**
   * Human-readable decimal string, NOT base units. "0.000001" means 1e-6 of
   * the asset. Confirmed empirically: passing wei here is read as whole ether
   * and trips the org spending cap. Convert with `formatUnits` at this
   * boundary; everything upstream of the client reasons in base units.
   */
  amount: string;
  /** Omit for the chain's native asset. */
  tokenAddress?: string;
}

export interface ContractCallParams {
  chainId: string;
  contractAddress: string;
  /** Must be stringified JSON — the API rejects raw arrays. */
  abi: string;
  functionName: string;
  /** Positional, matching ABI input order, stringified JSON. */
  functionArgs: string;
  value?: string;
  gasLimitMultiplier?: string;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Total attempts per request, including the first. */
  maxAttempts?: number;
  timeoutMs?: number;
}

/**
 * Simple sliding-window limiter. The API caps us at 60/min; a treasury sweep
 * that fans out across chains can burst past that without one.
 */
class RateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly perMinute: number) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
      if (this.timestamps.length < this.perMinute) {
        this.timestamps.push(now);
        return;
      }
      const oldest = this.timestamps[0] ?? now;
      await sleep(60_000 - (now - oldest) + 50);
    }
  }
}

export class KeeperHubClient {
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly limiter = new RateLimiter(RATE_LIMIT_PER_MINUTE);

  constructor(private readonly options: ClientOptions) {
    if (!options.apiKey) {
      throw new Error("KEEPERHUB_API_KEY is required");
    }
    if (!options.apiKey.startsWith("kh_")) {
      // Not fatal — but it is almost always a paste error, and the resulting
      // 401 is much harder to read than this line.
      console.warn("[bursar] API key does not start with 'kh_' — check it was copied whole.");
    }
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.maxAttempts = options.maxAttempts ?? 4;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  // --- Read endpoints -----------------------------------------------------

  /** Cheapest possible auth check. Run this before anything that moves value. */
  verifyKey(): Promise<unknown> {
    return this.request("GET", "/keys");
  }

  /** The org's Turnkey signer. This is the address that must hold funds. */
  getWallet(): Promise<unknown> {
    return this.request("GET", "/user/wallet");
  }

  /** Authoritative chain list — never hardcode chain IDs from docs. */
  listChains(): Promise<unknown> {
    return this.request("GET", "/chains");
  }

  // --- Direct execution ---------------------------------------------------

  async transfer(params: TransferParams, idempotencyKey: string): Promise<ExecutionResult> {
    const body = await this.request("POST", "/execute/transfer", {
      body: params,
      idempotencyKey,
    });
    return normalizeExecution(body);
  }

  async contractCall(
    params: ContractCallParams,
    idempotencyKey: string,
  ): Promise<ExecutionResult> {
    const body = await this.request("POST", "/execute/contract-call", {
      body: params,
      idempotencyKey,
    });
    return normalizeExecution(body);
  }

  // --- Workflows ----------------------------------------------------------

  /**
   * Create a workflow.
   *
   * The route is /workflows/create, not POST /workflows — the collection URL
   * advertises only GET, HEAD, OPTIONS and answers 405 to a POST.
   */
  createWorkflow(workflow: unknown, idempotencyKey: string): Promise<unknown> {
    return this.request("POST", "/workflows/create", { body: workflow, idempotencyKey });
  }

  listWorkflows(): Promise<unknown> {
    return this.request("GET", "/workflows");
  }

  /**
   * Update a workflow in place. PATCH is the only mutating verb the resource
   * accepts; PUT and POST both answer 405.
   *
   * Re-authoring updates rather than deleting and recreating on purpose: a
   * workflow that has ever run cannot be deleted without first destroying its
   * executions, and that history is the audit trail.
   */
  updateWorkflow(
    workflowId: string,
    workflow: unknown,
    idempotencyKey: string,
  ): Promise<unknown> {
    return this.request("PATCH", `/workflows/${workflowId}`, {
      body: workflow,
      idempotencyKey,
    });
  }

  deleteWorkflow(workflowId: string, idempotencyKey: string): Promise<unknown> {
    return this.request("DELETE", `/workflows/${workflowId}`, { idempotencyKey });
  }

  async executeWorkflow(
    workflowId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<ExecutionResult> {
    const body = await this.request("POST", `/workflows/${workflowId}/execute`, {
      body: input,
      idempotencyKey,
    });
    return normalizeExecution(body);
  }

  /**
   * Server-side blocking wait, capped at 60s by the API. Long workflows need
   * to be polled in a loop — see `awaitExecution`.
   */
  async waitForExecution(executionId: string): Promise<ExecutionResult> {
    const body = await this.request("GET", `/workflows/executions/${executionId}/wait`, {
      timeoutMs: 70_000,
    });
    return normalizeExecution(body);
  }

  async getExecutionStatus(executionId: string): Promise<ExecutionResult> {
    const body = await this.request("GET", `/workflows/executions/${executionId}/status`);
    return normalizeExecution(body);
  }

  /**
   * Wait for a terminal state, surviving the API's 60s wait cap by re-issuing
   * the blocking wait until the deadline passes.
   */
  async awaitExecution(executionId: string, deadlineMs = 300_000): Promise<ExecutionResult> {
    const deadline = Date.now() + deadlineMs;
    let last: ExecutionResult | undefined;
    while (Date.now() < deadline) {
      last = await this.waitForExecution(executionId);
      if (isTerminal(last.status)) return last;
      // `/wait` blocks server-side, but it is not obliged to. When it returns
      // promptly this loop otherwise spins as fast as the rate limiter allows,
      // burning the whole per-minute budget every other call shares.
      await sleep(1_000);
    }
    throw new Error(
      `Execution ${executionId} did not reach a terminal state within ${deadlineMs}ms ` +
        `(last status: ${last?.status ?? "unknown"})`,
    );
  }

  // --- Transport ----------------------------------------------------------

  private async request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: { body?: unknown; idempotencyKey?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const isWrite = method !== "GET";

    // A retried write without an idempotency key can double-spend. Refuse.
    if (isWrite && !opts.idempotencyKey) {
      throw new Error(`Write to ${path} requires an idempotency key`);
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.limiter.acquire();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);

      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.options.apiKey}`,
          Accept: "application/json",
        };
        if (opts.body !== undefined) headers["Content-Type"] = "application/json";
        if (opts.idempotencyKey) {
          headers["Idempotency-Key"] = safeHeaderValue(opts.idempotencyKey);
        }

        const response = await fetch(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
        });

        const requestId = response.headers.get("x-request-id") ?? undefined;
        const text = await response.text();
        const parsed = text ? safeJsonParse(text) : null;

        // `safeJsonParse` hands back the raw text when it cannot parse, and a
        // string flows through `normalizeExecution` as an object with every
        // field undefined — producing a perfectly well-formed result with an
        // empty execution id and status "unknown". A CDN error page or a
        // captive-portal interstitial answering 200 would be reported to the
        // caller as a submitted movement. An unreadable body is a failure.
        if (response.ok && text && typeof parsed === "string") {
          const error = new KeeperHubError(
            `KeeperHub ${method} ${path} returned ${response.status} with a body that is not ` +
              `JSON, so whether it executed is unknown`,
            response.status,
            text.slice(0, 500),
            requestId,
          );
          if (attempt === this.maxAttempts) throw error;
          await sleep(backoffMs(attempt, response.headers.get("retry-after")));
          continue;
        }

        if (!response.ok) {
          const error = new KeeperHubError(
            `KeeperHub ${method} ${path} failed: ${response.status} ${response.statusText}`,
            response.status,
            parsed ?? text,
            requestId,
          );
          if (!error.retryable || attempt === this.maxAttempts) throw error;
          await sleep(backoffMs(attempt, response.headers.get("retry-after")));
          lastError = error;
          continue;
        }

        return parsed;
      } catch (error) {
        // Abort and network faults are retryable; a thrown KeeperHubError has
        // already decided for itself above.
        if (error instanceof KeeperHubError) throw error;
        lastError = error;
        if (attempt === this.maxAttempts) break;
        await sleep(backoffMs(attempt, null));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`KeeperHub ${method} ${path} failed after ${this.maxAttempts} attempts`);
  }
}

// --- Helpers --------------------------------------------------------------

const TERMINAL_STATUSES = new Set([
  "success",
  "succeeded",
  "completed",
  "failed",
  "error",
  "cancelled",
  "canceled",
]);

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status.toLowerCase());
}

export function isSuccess(status: string): boolean {
  const s = status.toLowerCase();
  return s === "success" || s === "succeeded" || s === "completed";
}

/**
 * The API has not settled on one casing/nesting for execution payloads, so pull
 * the fields we need from wherever they appear and keep the original around.
 */
function normalizeExecution(body: unknown): ExecutionResult {
  const raw = (body ?? {}) as Record<string, unknown>;
  const inner = (raw.execution ?? raw.data ?? raw) as Record<string, unknown>;

  const hashes = inner.transactionHashes ?? inner.transaction_hashes ?? inner.txHashes;
  const single = inner.transactionHash ?? inner.transaction_hash ?? inner.txHash;
  const links = inner.transactionLinks ?? inner.transaction_links;
  const singleLink = inner.transactionLink ?? inner.transaction_link;

  // Workflow executions report objects here, direct executions report strings.
  // Stringifying an object yields "[object Object]", which is how this was
  // first written into the ledger — a hash that identifies nothing.
  const transactions: TransactionRecord[] = Array.isArray(hashes)
    ? hashes.flatMap((entry) => {
        if (typeof entry === "string") return [{ hash: entry }];
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          // `txHash` is accepted at the top level, so it has to be accepted
          // here too — an array of objects spelling it that way used to yield
          // zero hashes for an execution that really did move funds.
          const hash = record.hash ?? record.transactionHash ?? record.txHash;
          if (typeof hash === "string") {
            return [
              {
                hash,
                chainId: typeof record.chainId === "number" ? record.chainId : undefined,
                gasUsed: typeof record.gasUsed === "string" ? record.gasUsed : undefined,
                blockNumber:
                  typeof record.blockNumber === "number" ? record.blockNumber : undefined,
                receiptStatus:
                  typeof record.receiptStatus === "string" ? record.receiptStatus : undefined,
                verified: typeof record.verified === "boolean" ? record.verified : undefined,
                nodeName: typeof record.nodeName === "string" ? record.nodeName : undefined,
              },
            ];
          }
        }
        return [];
      })
    : [];

  // Fall back to the single-hash spelling whenever the array yielded nothing,
  // not merely when the array was absent: a response carrying both an empty
  // (or unrecognised) `transactionHashes` and a populated `transactionHash`
  // used to report no hash at all.
  if (transactions.length === 0 && typeof single === "string") {
    transactions.push({ hash: single });
  }

  return {
    executionId: String(
      inner.executionId ?? inner.execution_id ?? inner.id ?? raw.executionId ?? "",
    ),
    status: String(inner.status ?? raw.status ?? "unknown"),
    transactionHashes: transactions.map((t) => t.hash),
    transactions,
    // The same object-vs-string split as the hashes above. This path was not
    // hardened at the time and `String({url})` produced "[object Object]",
    // which is then printed as the explorer link in every audit surface.
    transactionLinks: Array.isArray(links)
      ? links.flatMap((entry) => {
          if (typeof entry === "string") return [entry];
          if (entry && typeof entry === "object") {
            const url = (entry as Record<string, unknown>).url;
            if (typeof url === "string") return [url];
          }
          return [];
        })
      : typeof singleLink === "string"
        ? [singleLink]
        : [],
    idempotentReplay: Boolean(inner.idempotentReplay ?? raw.idempotentReplay ?? false),
    output: inner.output ?? raw.output ?? null,
    raw,
  };
}

/**
 * HTTP header values must be Latin-1, but idempotency keys are derived from
 * real data — workflow names, memos, contributor names — which may contain any
 * character. An em-dash in a workflow name is enough to make `fetch` throw.
 *
 * Non-ASCII keys are replaced by a hash of themselves. That keeps the property
 * that actually matters: the same logical request produces the same key, so
 * server-side replay protection still works.
 */
function safeHeaderValue(key: string): string {
  if (/^[\x20-\x7E]+$/.test(key) && key.length <= 200) return key;
  return `bursar-${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Exponential backoff with jitter, honouring Retry-After when the API sends it. */
function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60_000);
  }
  const base = Math.min(1000 * 2 ** (attempt - 1), 15_000);
  return base + Math.random() * 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
