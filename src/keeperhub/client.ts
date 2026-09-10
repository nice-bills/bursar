/**
 * Typed HTTP client for the KeeperHub REST API.
 *
 * Response shapes are deliberately loose (`unknown` / index signatures) until
 * the smoke test has confirmed them against a live org. Everything that reaches
 * the rest of the codebase goes through a `normalize*` function so a schema
 * surprise fails in one place instead of ten.
 */

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

  /** 429 and 5xx are worth another attempt; 4xx generally is not. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface ExecutionResult {
  executionId: string;
  status: string;
  transactionHashes: string[];
  /** Explorer URLs, when the API supplies them. These go in the demo/report. */
  transactionLinks: string[];
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

  createWorkflow(workflow: unknown, idempotencyKey: string): Promise<unknown> {
    return this.request("POST", "/workflows", { body: workflow, idempotencyKey });
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
        if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

        const response = await fetch(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
        });

        const requestId = response.headers.get("x-request-id") ?? undefined;
        const text = await response.text();
        const parsed = text ? safeJsonParse(text) : null;

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

  return {
    executionId: String(
      inner.executionId ?? inner.execution_id ?? inner.id ?? raw.executionId ?? "",
    ),
    status: String(inner.status ?? raw.status ?? "unknown"),
    transactionHashes: Array.isArray(hashes)
      ? hashes.map(String)
      : typeof single === "string"
        ? [single]
        : [],
    transactionLinks: Array.isArray(links)
      ? links.map(String)
      : typeof singleLink === "string"
        ? [singleLink]
        : [],
    idempotentReplay: Boolean(inner.idempotentReplay ?? raw.idempotentReplay ?? false),
    output: inner.output ?? raw.output ?? null,
    raw,
  };
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
