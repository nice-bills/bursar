/**
 * A Lucid Agents connector — discovery and invocation, with payment gated.
 *
 * ## What this is
 *
 * KeeperHub's issue #2329 asks for a connector so a workflow can discover and
 * call an agent entrypoint, free or x402-priced. It proposes protecting the
 * money with "a dedicated, low-balance payer key held in the encrypted
 * integration store" and a per-call `maxPriceUsd`.
 *
 * That is a reasonable first answer and a blunt one. A price cap says nothing
 * about *who* is being paid, how much has already gone out today, what the
 * total is worth across assets, or what happens if the process dies between
 * signing and recording. Keeping the payer wallet nearly empty limits the
 * damage by limiting the capability — which also limits the agent.
 *
 * Bursar already owns the better answer, so the connector hands the decision to
 * it: the allowlist decides who may be paid at all, per-asset caps and the
 * rolling 24h window bound the flow, the cross-asset ceiling bounds the value,
 * and anything above the approval threshold stops and waits for a person. The
 * payment is written to the intent ledger before it is made, so a crash leaves
 * an open intent to reconcile rather than a silent gap.
 *
 * ## The two surfaces
 *
 *   GET  {agentUrl}/.well-known/agent-card.json   — what the agent offers
 *   POST {agentUrl}/entrypoints/{key}/invoke      — calling one
 *
 * A priced entrypoint answers the second with HTTP 402 and a payment challenge
 * rather than a result. That is not an error; it is the quote.
 */

import { readPaymentChallenge, parseEmbeddedJson, type PaymentChallenge } from "../keeperhub/mcp.js";

/** One callable capability, as the agent card advertises it. */
export interface AgentEntrypoint {
  key: string;
  description?: string;
  /** True when calling it costs money. */
  priced: boolean;
  /**
   * What it costs, when the card says so, in the asset's base units.
   * Cards advertise price in several shapes; this is whichever one was found.
   */
  priceAmount?: string;
  priceAsset?: string;
  network?: string;
  payTo?: string;
  /** JSON Schema for the entrypoint's input, when published. */
  inputSchema?: unknown;
}

/** An agent's published description of itself. */
export interface AgentCard {
  name: string;
  version?: string;
  description?: string;
  entrypoints: AgentEntrypoint[];
  /** Protocol extensions the agent declares — x402, ERC-8004 identity, and so on. */
  extensions: string[];
  /** The card exactly as served, for the audit record. */
  raw: unknown;
}

export class LucidError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "LucidError";
  }
}

/**
 * Read an x402 challenge out of the response headers.
 *
 * Confirmed against a served Lucid agent: the 402 body is `{}` and the terms
 * arrive base64-encoded in `payment-required`. The header name is checked in a
 * couple of spellings because this part of x402 is carried differently by
 * different servers, and the cost of missing it is treating an invoice as free.
 */
export function decodeChallengeHeader(headers: Headers): unknown {
  for (const name of ["payment-required", "x-payment-required", "www-authenticate"]) {
    const value = headers.get(name);
    if (!value) continue;

    // Some servers send it as JSON directly rather than base64.
    const direct = parseEmbeddedJson(value);
    if (direct !== null) return direct;

    try {
      const decoded = Buffer.from(value.trim(), "base64").toString("utf8");
      const parsed = parseEmbeddedJson(decoded);
      if (parsed !== null) return parsed;
    } catch {
      // Not base64 either; fall through to the next header name.
    }
  }
  return null;
}

/** Strip a trailing slash so URL joining never doubles it. */
function base(agentUrl: string): string {
  return agentUrl.replace(/\/+$/, "");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Pull a price out of an entrypoint descriptor.
 *
 * Cards in the wild carry this several ways: a bare `price` string, an
 * `x402.offers[]` array of full payment terms, or a `pricing` object. All three
 * are read, because a connector that recognises only one shape will call a paid
 * entrypoint believing it is free — and find out from the 402, after deciding
 * it did not need to ask anyone's permission.
 */
function readPricing(entry: Record<string, unknown>): Partial<AgentEntrypoint> {
  const x402 = entry.x402 as Record<string, unknown> | undefined;
  const offers = x402?.offers;
  if (Array.isArray(offers) && offers.length > 0) {
    const offer = offers[0] as Record<string, unknown>;
    const price = offer.price as Record<string, unknown> | undefined;
    const maximum = offer.maximum as Record<string, unknown> | undefined;
    const amount = price ?? maximum;
    return {
      priced: true,
      priceAmount: str(amount?.amount),
      priceAsset: str(amount?.asset),
      network: str(offer.network),
      payTo: str(offer.payTo),
    };
  }

  const pricing = entry.pricing as Record<string, unknown> | undefined;
  if (pricing) {
    return {
      priced: true,
      // A served card prices per call shape: `{"pricing": {"invoke": "10000"}}`.
      priceAmount:
        str(pricing.invoke) ?? str(pricing.amount) ?? str(pricing.price) ?? str(pricing.default),
      priceAsset: str(pricing.asset),
      network: str(pricing.network) ?? str(entry.network),
    };
  }

  // `payment_protocol` is how a served card marks an entrypoint as paid.
  if (str(entry.payment_protocol)) {
    return { priced: true, network: str(entry.network) };
  }

  if (entry.price !== undefined && entry.price !== null) {
    return { priced: true, priceAmount: String(entry.price) };
  }

  // `paymentProtocol` without any readable terms still means priced. Treating
  // it as free is the expensive direction to be wrong in.
  if (str(entry.paymentProtocol)) return { priced: true };

  return { priced: false };
}

/**
 * Find the entrypoints wherever the card puts them.
 *
 * A served Lucid card keys `entrypoints` by name — `{"health": {...}}` — and
 * *also* publishes an A2A `skills` array listing the same capabilities without
 * their pricing. Preferring the array because it is an array finds every
 * entrypoint and none of the prices, which reads a paid entrypoint as free.
 * The keyed object wins for that reason; `skills` is the fallback for cards
 * that only speak A2A.
 */
function findEntrypoints(card: Record<string, unknown>): Array<Record<string, unknown>> {
  const direct = card.entrypoints;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return Object.entries(direct as Record<string, unknown>).map(([key, value]) => ({
      key,
      ...(value as Record<string, unknown>),
    }));
  }
  if (Array.isArray(direct)) return direct as Array<Record<string, unknown>>;

  const skills = card.skills;
  if (Array.isArray(skills)) return skills as Array<Record<string, unknown>>;

  const caps = card.capabilities as Record<string, unknown> | undefined;
  if (Array.isArray(caps?.entrypoints)) {
    return caps.entrypoints as Array<Record<string, unknown>>;
  }
  return [];
}

/**
 * The card's payment methods, which is where the asset actually lives.
 *
 * An entrypoint states its price and network; the asset that price is
 * denominated in sits once at the top of the card under `payments[]`. A price
 * without its asset is a number with no units, and the treasury refuses to pay
 * amounts it cannot denominate — so the two have to be brought together here.
 */
function findPaymentDefaults(card: Record<string, unknown>): Partial<AgentEntrypoint> {
  const methods = card.payments;
  if (!Array.isArray(methods) || methods.length === 0) return {};
  const method = methods[0] as Record<string, unknown>;
  const x402 = (method.extensions as Record<string, unknown> | undefined)?.x402 as
    | Record<string, unknown>
    | undefined;
  const price = x402?.price as Record<string, unknown> | undefined;

  return {
    priceAsset: str(price?.asset),
    network: str(x402?.network) ?? str(method.network),
    payTo: str(x402?.payTo) ?? str(method.payee),
    priceAmount: str(price?.amount),
  };
}

/** Parse a served agent card. Exported so it can be tested against real ones. */
export function readAgentCard(payload: unknown): AgentCard {
  const card = (payload ?? {}) as Record<string, unknown>;

  const defaults = findPaymentDefaults(card);

  const entrypoints = findEntrypoints(card).map((entry): AgentEntrypoint => {
    const key = str(entry.key) ?? str(entry.id) ?? str(entry.name) ?? "";
    const pricing = readPricing(entry);
    return {
      key,
      description: str(entry.description),
      inputSchema:
        entry.input_schema ?? entry.inputSchema ?? entry.x_input_schema ?? entry.input ?? undefined,
      priced: false,
      ...pricing,
      // Card-level payment details fill in what the entrypoint left out — the
      // asset especially, which is never stated per entrypoint. Only for paid
      // ones: a free entrypoint must not inherit a price.
      ...(pricing.priced
        ? {
            priceAmount: pricing.priceAmount ?? defaults.priceAmount,
            priceAsset: pricing.priceAsset ?? defaults.priceAsset,
            network: pricing.network ?? defaults.network,
            payTo: pricing.payTo ?? defaults.payTo,
          }
        : {}),
    };
  });

  const caps = card.capabilities as Record<string, unknown> | undefined;
  const rawExtensions = caps?.extensions;
  const extensions = Array.isArray(rawExtensions)
    ? rawExtensions
        .map((e) =>
          typeof e === "string" ? e : str((e as Record<string, unknown>)?.uri),
        )
        .filter((e): e is string => typeof e === "string")
    : [];

  return {
    name: str(card.name) ?? "(unnamed)",
    version: str(card.version),
    description: str(card.description),
    entrypoints: entrypoints.filter((e) => e.key !== ""),
    extensions,
    raw: payload,
  };
}

/** What came back from invoking an entrypoint. */
export interface InvokeOutcome {
  /** The entrypoint's result, when it ran. */
  output: unknown;
  /** The quote, when it wants paying first. */
  challenge: PaymentChallenge | null;
  status: number;
  /** The body as served, for the record. */
  raw: unknown;
}

export class LucidAgent {
  constructor(
    private readonly agentUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** `GET /.well-known/agent-card.json` — what this agent offers. */
  async discover(): Promise<AgentCard> {
    const url = `${base(this.agentUrl)}/.well-known/agent-card.json`;
    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new LucidError(
        `Agent card unavailable: ${response.status} ${response.statusText}`,
        response.status,
        text.slice(0, 300),
      );
    }
    const parsed = parseEmbeddedJson(text);
    if (parsed === null) {
      throw new LucidError("Agent card was not JSON", response.status, text.slice(0, 300));
    }
    return readAgentCard(parsed);
  }

  /**
   * `POST /entrypoints/{key}/invoke`.
   *
   * A 402 is returned rather than thrown. It is the agent quoting a price, not
   * the call going wrong, and the caller needs the terms in order to decide.
   * `paymentHeader` carries a settled x402 signature on the retry.
   */
  async invoke(
    key: string,
    input: Record<string, unknown>,
    paymentHeader?: string,
  ): Promise<InvokeOutcome> {
    const url = `${base(this.agentUrl)}/entrypoints/${encodeURIComponent(key)}/invoke`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (paymentHeader) headers["X-PAYMENT"] = paymentHeader;

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ input }),
    });

    const text = await response.text();
    const parsed = parseEmbeddedJson(text);

    if (response.status === 402) {
      // The terms are not necessarily in the body. A Lucid agent answers with
      // an empty `{}` and carries the whole challenge in a base64
      // `payment-required` header; KeeperHub's marketplace puts it in the body.
      // Reading only one of those places means a paid call reads as free.
      const fromHeader = decodeChallengeHeader(response.headers);
      // Header first, but without the text fallback: `readPaymentChallenge`
      // treats any body mentioning "x402" as an undecodable challenge, and that
      // truthy-but-empty result would short-circuit the body parse that has the
      // actual terms. Each source is tried for a *decodable* challenge first,
      // and only then is the fallback allowed to fire, once.
      const challenge =
        readPaymentChallenge(fromHeader, "") ?? readPaymentChallenge(parsed, text);
      return {
        output: null,
        challenge,
        status: 402,
        raw: fromHeader ?? parsed ?? text,
      };
    }

    if (!response.ok) {
      throw new LucidError(
        `Entrypoint ${key} failed: ${response.status} ${response.statusText}`,
        response.status,
        parsed ?? text.slice(0, 300),
      );
    }

    // Results arrive wrapped as { output } on this transport; unwrap when so.
    const body = (parsed ?? {}) as Record<string, unknown>;
    const output = "output" in body ? body.output : parsed;
    return { output, challenge: null, status: response.status, raw: parsed ?? text };
  }
}
