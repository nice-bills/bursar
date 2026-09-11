/**
 * KeeperHub's MCP server — the interface the platform actually intends agents
 * to use.
 *
 * The REST API moves value. This is how you find out what the platform can do
 * and what it will let you do: `list_action_schemas` returns every action type
 * with its required fields, output fields and a worked templating example, and
 * `get_spending_limits` returns the org's enforced daily cap and how much of it
 * is already spent.
 *
 * Bursar was built for a while without either. The cost was a day of guessing
 * action-type names against the workflow validator, a wrong conclusion that the
 * template resolver was broken, and a local daily cap five times higher than
 * the platform would ever honour. All three were discoverable here.
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
