/**
 * KeeperHub's MCP server — the interface the platform intends agents to use.
 *
 * The REST API moves value. This is how you find out what the platform can do
 * and what it will let you do: `list_action_schemas` returns every action type
 * with its required fields, output fields and a worked templating example, and
 * `get_spending_limits` returns the org's enforced daily cap and how much of it
 * is already spent.
 *
 * It is deliberately *not* mounted into the agent. The server exposes 44 tools
 * whose definitions run to ~13k tokens, and `list_action_schemas` answers with
 * close to half a megabyte — a single call would swamp the context it was
 * meant to inform. Instead this client is called from code, the traffic stays
 * in the program, and the agent sees six treasury actions. See
 * `npm run context-cost` for the measurement.
 *
 * Transport is streamable HTTP: initialize, keep the session id, then call.
 */


const DEFAULT_MCP_URL = "https://app.keeperhub.com/mcp";
const PROTOCOL_VERSION = "2024-11-05";

export interface SpendingLimits {
  /** The cap actually enforced, whether org-set or the platform default. */
  effectiveDailyCapWei: bigint;
  /** Spent so far today against that cap. */
  dailyUsedWei: bigint;
  /** What remains. Never negative. */
  remainingWei: bigint;
  /** True when the org has not set its own cap and the default applies. */
  usingDefaultCap: boolean;
}

export class KeeperHubMcpError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "KeeperHubMcpError";
  }
}

export class KeeperHubMcp {
  private sessionId?: string;
  private initialized?: Promise<void>;

  constructor(
    private readonly apiKey: string,
    private readonly url = DEFAULT_MCP_URL,
  ) {}

  /**
   * Read the org's enforced spending limits.
   *
   * This is the number that actually binds. A treasury can hold whatever
   * opinion it likes about its daily ceiling; if the platform refuses at 0.02
   * ETH, a locally configured 0.1 is fiction, and the difference shows up as a
   * transfer that fails for reasons the policy engine never saw coming.
   */
  async getSpendingLimits(): Promise<SpendingLimits> {
    const payload = await this.callTool("get_spending_limits", {});
    const data = payload as Record<string, unknown>;

    const cap = toBigInt(data.effectiveDailyCapWei ?? data.dailyCapWei);
    const used = toBigInt(data.dailyUsedWei) ?? 0n;
    if (cap === null) {
      throw new KeeperHubMcpError("Spending limits response carried no cap", payload);
    }

    return {
      effectiveDailyCapWei: cap,
      dailyUsedWei: used,
      remainingWei: cap > used ? cap - used : 0n,
      usingDefaultCap: data.usingDefaultDailyCap === true,
    };
  }

  // --- the marketplace ----------------------------------------------------

  /**
   * Publish a workflow to KeeperHub's catalogue.
   *
   * This is the step that turns Bursar from a thing that spends money into a
   * thing that earns it. A listed workflow gets a stable slug, a public input
   * schema, and its own MCP endpoint — any agent on the Hub can discover it
   * through `search_workflows` and call it, paying per call over x402.
   *
   * Idempotent: re-publishing preserves the slug and refreshes `listedAt`.
   */
  async listWorkflow(args: {
    workflowId: string;
    slug: string;
    category?: string;
    chain?: string;
    inputSchema?: Record<string, unknown>;
    outputMapping?: Record<string, unknown>;
    workflowType?: string;
  }): Promise<unknown> {
    return this.callTool("list_workflow", args as Record<string, unknown>);
  }

  /** Edit listing metadata after publication — description, tags, schemas. */
  async updateWorkflowListing(args: Record<string, unknown>): Promise<unknown> {
    return this.callTool("update_workflow_listing", args);
  }

  /** The public catalogue, as an external agent sees it. */
  async searchWorkflows(args: {
    query?: string;
    category?: string;
    chain?: string;
    sort?: "popular" | "recent";
  } = {}): Promise<unknown> {
    return this.callTool("search_workflows", args as Record<string, unknown>);
  }

  /**
   * Invoke a listing the way a paying caller would.
   *
   * A paid listing answers with an x402 challenge rather than a result, and the
   * MCP transport surfaces that as a tool *error* carrying the challenge body.
   * So this deliberately does not throw on `isError`: for our purposes the
   * challenge is the interesting outcome, not a failure. `raw()` hands back
   * whatever came, and the caller decides what it means.
   */
  async callWorkflow(slug: string, inputs: Record<string, unknown> = {}): Promise<ToolOutcome> {
    return this.raw("call_workflow", { slug, inputs });
  }

  /** The server's own documentation for a tool — authoritative over the docs site. */
  async toolsDocumentation(tool?: string): Promise<unknown> {
    return this.callTool("tools_documentation", tool ? { tool } : {});
  }

  /** One tool's advertised input schema, so no field name is ever guessed. */
  async toolSchema(name: string): Promise<Record<string, unknown> | null> {
    const tools = (await this.listTools()) as Array<{
      name?: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>;
    const found = tools.find((t) => t.name === name);
    return found ? { description: found.description, inputSchema: found.inputSchema } : null;
  }

  /**
   * Call a tool and report the outcome without interpreting it.
   *
   * `callTool` throws on an error result, which is right when an error means
   * something went wrong. It is wrong for payment challenges, where the error
   * *is* the answer.
   */
  async raw(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    await this.ensureSession();
    const response = (await this.rpc("tools/call", { name, arguments: args })) as {
      result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
      error?: { message?: string };
    };

    const text =
      response.result?.content?.find((c) => typeof c.text === "string")?.text ??
      response.error?.message ??
      "";

    const parsed = parseEmbeddedJson(text);

    return {
      isError: Boolean(response.result?.isError || response.error),
      text,
      json: parsed,
      challenge: readPaymentChallenge(parsed, text),
    };
  }

  /** The server's tool definitions — what mounting it would put in a prompt. */
  async listTools(): Promise<unknown[]> {
    await this.ensureSession();
    const response = (await this.rpc("tools/list", {})) as {
      result?: { tools?: unknown[] };
    };
    return response.result?.tools ?? [];
  }

  /**
   * Every action type the platform supports, with its fields.
   *
   * Large — hundreds of kilobytes — so callers should ask for what they need
   * rather than holding it all. `findAction` is the usual entry point.
   */
  async listActionSchemas(): Promise<unknown> {
    return this.callTool("list_action_schemas", {});
  }

  /** Look up one action type's schema, so field names are never guessed. */
  async findAction(actionType: string): Promise<ActionSchema | null> {
    const all = await this.listActionSchemas();
    const found = search(all, actionType);
    return found ? (found as ActionSchema) : null;
  }

  // --- transport ----------------------------------------------------------

  private async ensureSession(): Promise<void> {
    this.initialized ??= (async () => {
      await this.rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "bursar", version: "0.1.0" },
      });
      // The server expects the notification before it will serve tools; without
      // it tools/list comes back empty rather than erroring, which is a
      // confusing way to spend an afternoon.
      await this.rpc("notifications/initialized", {}, true);
    })();
    await this.initialized;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureSession();
    const response = (await this.rpc("tools/call", { name, arguments: args })) as {
      result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
      error?: { message?: string };
    };

    if (response.error) {
      throw new KeeperHubMcpError(`MCP ${name} failed: ${response.error.message}`, response.error);
    }
    if (response.result?.isError) {
      throw new KeeperHubMcpError(`MCP ${name} reported an error`, response.result);
    }

    // Tool results arrive as text content that is itself JSON.
    const text = response.result?.content?.find((c) => typeof c.text === "string")?.text;
    if (text === undefined) return response.result ?? null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    notify = false,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    const body = notify
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params };

    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;

    const text = await response.text();
    if (!response.ok) {
      throw new KeeperHubMcpError(
        `MCP ${method} failed: ${response.status} ${response.statusText}`,
        text.slice(0, 300),
      );
    }
    if (notify) return null;

    try {
      return JSON.parse(text);
    } catch {
      throw new KeeperHubMcpError(`MCP ${method} returned a non-JSON body`, text.slice(0, 300));
    }
  }
}

/** What a tool call actually returned, errors and payment challenges included. */
export interface ToolOutcome {
  isError: boolean;
  /** The raw response text — the challenge body arrives here for paid listings. */
  text: string;
  /** `text` parsed as JSON, when it is JSON. */
  json: unknown;
  /** Payment terms, when the response was an x402 challenge. */
  challenge: PaymentChallenge | null;
}

/**
 * The terms a paid listing demands before it will do the work.
 *
 * Shaped after the x402 challenge body: an `accepts` array of payment options,
 * each naming a network, an asset, a price in that asset's base units, and the
 * address the money goes to. Fields are optional because we read a live wire
 * format rather than a frozen one — what matters is recognising a challenge for
 * what it is, not decoding every field of it.
 */
export interface PaymentChallenge {
  /**
   * The price, in the asset's base units, as a decimal string. USDC has 6
   * decimals, so $0.01 arrives as "10000".
   *
   * KeeperHub's live challenge calls this `amount`; the x402 spec's own
   * examples call it `maxAmountRequired`. Both are read into this one field —
   * the alternative is a parser that silently finds no price and reports a paid
   * listing as free.
   */
  maxAmountRequired?: string;
  /** Where the payment settles — Base, for KeeperHub's x402. */
  network?: string;
  /** The token contract being charged in. */
  asset?: string;
  /** The earner. For our own listing, this is the address Bursar gets paid at. */
  payTo?: string;
  /** What is being bought. */
  resource?: string;
  description?: string;
  /** Everything, unabridged, for the audit record. */
  raw: unknown;
}

/**
 * Parse a response body that may be wrapped in prose.
 *
 * The transport does not hand back a bare JSON body for errors — a payment
 * challenge arrives as `API call failed: 402 Payment Required - {...}`. Parsing
 * the whole string fails, and treating that failure as "no JSON" is how a fully
 * decodable challenge ends up reported as an unreadable one.
 *
 * So: try the string whole, then try from the first brace to the last.
 */
export function parseEmbeddedJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  // Scan for the first balanced object rather than slicing to the last brace.
  // The 402 body is followed by a human-readable retry hint that contains
  // braces of its own — `{ method: 'POST', ... }` — so the last brace in the
  // string belongs to prose, not to the JSON.
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Recognise an x402 challenge in whatever shape it arrives.
 *
 * The transport wraps it as a tool error, so there is no status code to check —
 * the body has to identify itself. Both the envelope (`{accepts: [...]}`) and a
 * bare payment requirement are accepted, and a plain "402" in unparseable text
 * still counts, because a challenge we cannot decode is still a challenge and
 * silently reading it as "free" would be the dangerous mistake.
 */
export function readPaymentChallenge(json: unknown, text = ""): PaymentChallenge | null {
  const envelope = json as Record<string, unknown> | null;
  const accepts = envelope?.accepts;
  const terms = (
    Array.isArray(accepts) && accepts.length > 0 ? accepts[0] : envelope
  ) as Record<string, unknown> | null;

  const has = (key: string): string | undefined =>
    typeof terms?.[key] === "string" ? (terms[key] as string) : undefined;

  const priced =
    terms != null &&
    (terms.maxAmountRequired !== undefined ||
      terms.amount !== undefined ||
      terms.payTo !== undefined ||
      terms.scheme !== undefined);

  if (priced) {
    const amount =
      has("maxAmountRequired") ??
      has("amount") ??
      (typeof terms?.maxAmountRequired === "number"
        ? String(terms.maxAmountRequired)
        : typeof terms?.amount === "number"
          ? String(terms.amount)
          : undefined);

    return {
      maxAmountRequired: amount,
      network: has("network"),
      asset: has("asset"),
      payTo: has("payTo"),
      // The live challenge carries `resource` as an object with a url, while
      // the spec's examples carry a bare string. Take the url either way.
      resource:
        has("resource") ??
        (typeof (envelope?.resource as Record<string, unknown> | undefined)?.url === "string"
          ? ((envelope!.resource as Record<string, unknown>).url as string)
          : undefined),
      description: has("description"),
      raw: json,
    };
  }

  // Undecodable, but unmistakably a payment demand.
  if (/\b402\b|x402|payment required/i.test(text)) {
    return { raw: json ?? text };
  }
  return null;
}

export interface ActionSchema {
  actionType: string;
  label?: string;
  description?: string;
  requiredFields?: Record<string, string>;
  optionalFields?: Record<string, string>;
  outputFields?: Record<string, string>;
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

/** Depth-first hunt for the object describing one action type. */
function search(node: unknown, actionType: string): unknown {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = search(item, actionType);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record.actionType === actionType) return record;
    for (const value of Object.values(record)) {
      const found = search(value, actionType);
      if (found) return found;
    }
  }
  return null;
}
