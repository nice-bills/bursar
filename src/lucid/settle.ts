/**
 * Settling an approved invoice.
 *
 * ## The ordering that matters
 *
 * `@x402/fetch` offers a wrapped fetch that pays any 402 it meets and retries,
 * which is the obvious way to build this and the wrong one. A fetch that pays
 * automatically has no opinion about who it is paying or how much has gone out
 * today; wiring it in would route money around the policy engine rather than
 * through it, and the engine is the entire product.
 *
 * So the paying fetch is never used for the first call. The sequence is:
 *
 *   1. call the entrypoint with an ordinary fetch, and get the 402
 *   2. hand the challenge to the policy engine
 *   3. only if it approves, record the intent
 *   4. only then construct a paying fetch and retry
 *
 * By the time anything can sign, the decision is already made and written down.
 *
 * Step 4 is not literally a retry of the paid request: `wrapFetchWithPayment`
 * issues its own unpaid call and signs whatever 402 comes back from THAT. So
 * the approved terms are not automatically the terms that get signed — a server
 * is free to quote one price to the policy engine and a different one to the
 * signer. `guardChallenge` closes that window: it sits underneath the paying
 * fetch, inspects every 402 before the SDK can act on it, and throws unless
 * every offer on the table is the one policy approved.
 *
 * ## The key
 *
 * Read from the environment and never logged, never returned, never put in the
 * ledger. This is a testnet payer by design: the amounts are cents and the
 * chains are test chains. A production deployment would hand signing to a
 * custodian — KeeperHub's own Turnkey signer, which is how every other movement
 * in this project is signed — rather than holding a raw key at all.
 */

import { createPublicClient, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";

import { Ledger, dailyPeriod } from "../ledger/store.js";
import { chainIdFromNetwork, type PaymentPlan } from "./pay.js";

/** The chains this payer knows how to sign for. */
const CHAINS = {
  8453: base,
  84532: baseSepolia,
} as const;

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementError";
  }
}

/** Whether a payer key is configured at all. */
export function payerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.BURSAR_PAYER_PRIVATE_KEY);
}

/**
 * The payer's address, so it can be checked and funded without revealing the key.
 *
 * Deriving the address is the only thing the key is used for outside signing,
 * and it is the thing a person actually needs to see.
 */
export function payerAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.BURSAR_PAYER_PRIVATE_KEY;
  if (!key) return null;
  try {
    return privateKeyToAccount(normalizeKey(key)).address;
  } catch {
    return null;
  }
}

function normalizeKey(key: string): `0x${string}` {
  const trimmed = key.trim();
  const prefixed = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed)) {
    throw new SettlementError(
      "BURSAR_PAYER_PRIVATE_KEY is not a 32-byte hex key. It is never logged; " +
        "check its length rather than printing it.",
    );
  }
  return prefixed as `0x${string}`;
}

/**
 * Build a fetch that can settle x402 invoices on one chain.
 *
 * Deliberately takes the chain it is allowed to pay on rather than registering
 * every scheme it can: a payer that will sign on any chain the counterparty
 * names is a payer that can be redirected by the counterparty.
 */
export function createPayingFetch(
  chainId: number,
  plan: PaymentPlan,
  env: NodeJS.ProcessEnv = process.env,
  signed: { attempted: boolean } = { attempted: false },
): typeof fetch {
  const key = env.BURSAR_PAYER_PRIVATE_KEY;
  if (!key) {
    throw new SettlementError(
      "No BURSAR_PAYER_PRIVATE_KEY is set, so there is nothing to sign with.",
    );
  }

  const chain = CHAINS[chainId as keyof typeof CHAINS];
  if (!chain) {
    throw new SettlementError(
      `No signer configured for chain ${chainId}. Settlement is limited to the ` +
        `chains this payer explicitly knows: ${Object.keys(CHAINS).join(", ")}.`,
    );
  }

  // The local account is the signer — it carries the address and signTypedData
  // that the exact scheme needs. A public client is composed in alongside it so
  // the scheme can do its optional on-chain reads (EIP-2612 nonces and the
  // like) without the signer ever needing to broadcast anything itself.
  const account = privateKeyToAccount(normalizeKey(key));
  const reader = createPublicClient({
    chain,
    transport: viemHttp(env.BURSAR_PAYER_RPC_URL),
  });

  const client = new x402Client().register(
    `eip155:${chainId}`,
    new ExactEvmScheme(toClientEvmSigner(account, reader)),
  );

  return wrapFetchWithPayment(guardChallenge(globalThis.fetch, plan, signed), client);
}

/** Fields of a single x402 offer, however the issuer spelled them. */
function offerTerms(offer: Record<string, unknown>): {
  amount?: string;
  payTo?: string;
  asset?: string;
  chainId: number | null;
} {
  const str = (key: string): string | undefined =>
    typeof offer[key] === "string"
      ? (offer[key] as string)
      : typeof offer[key] === "number"
        ? String(offer[key])
        : undefined;
  return {
    ...(str("maxAmountRequired") ?? str("amount")
      ? { amount: (str("maxAmountRequired") ?? str("amount"))! }
      : {}),
    ...(str("payTo") ? { payTo: str("payTo")! } : {}),
    ...(str("asset") ? { asset: str("asset")! } : {}),
    chainId: chainIdFromNetwork(str("network")),
  };
}

const same = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * Refuse a 402 that is not the invoice policy approved.
 *
 * Every offer is checked, not just the first: the SDK picks the first offer it
 * has a scheme registered for, which need not be the one `planPayment` read. An
 * offer list where any entry differs from the approved terms is a list where
 * what gets signed is not what was decided, so the whole response is refused.
 */
export function assertChallengeMatchesPlan(body: unknown, plan: PaymentPlan): void {
  const envelope = body as { accepts?: unknown } | null;
  const offers = Array.isArray(envelope?.accepts)
    ? (envelope.accepts as Record<string, unknown>[])
    : envelope
      ? [envelope as Record<string, unknown>]
      : [];

  if (offers.length === 0) {
    throw new SettlementError(
      "the entrypoint asked for payment again but the challenge could not be read, " +
        "so there is nothing to check the approved terms against",
    );
  }

  for (const offer of offers) {
    const terms = offerTerms(offer);
    const mismatch =
      (terms.amount !== undefined && terms.amount !== plan.amount) ||
      (terms.payTo !== undefined && !same(terms.payTo, plan.payTo)) ||
      (terms.asset !== undefined && !same(terms.asset, plan.asset)) ||
      (terms.chainId !== null && terms.chainId !== plan.chainId);

    if (mismatch) {
      throw new SettlementError(
        `the invoice changed between approval and payment. Approved ` +
          `${plan.amount} of ${plan.asset} to ${plan.payTo} on chain ${plan.chainId}; ` +
          `now asked for ${terms.amount ?? "?"} of ${terms.asset ?? "?"} to ` +
          `${terms.payTo ?? "?"} on chain ${terms.chainId ?? "?"}. Nothing was signed.`,
      );
    }
  }
}

/**
 * A fetch that lets the paying wrapper see a 402 only once it matches the plan.
 *
 * The body is read from a clone, so the response the SDK receives is untouched.
 */
function guardChallenge(
  inner: typeof globalThis.fetch,
  plan: PaymentPlan,
  signed: { attempted: boolean },
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    if (response.status !== 402) return response;

    let parsed: unknown = null;
    try {
      const text = await response.clone().text();
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    assertChallengeMatchesPlan(parsed, plan);
    // Past this point the wrapper will sign and send an authorisation, so the
    // counterparty is able to take the money whatever it answers afterwards.
    signed.attempted = true;
    return response;
  };
}

/**
 * What the counterparty says it settled.
 *
 * The `x-payment-response` header is a base64 `SettleResponse`, not a
 * transaction hash. Storing it raw put a base64 blob where every other leg puts
 * a hash — printed as an explorer link, and useless for reconciling.
 */
function readReceipt(header: string | undefined): {
  settled: boolean;
  transactionHash?: string;
  raw?: string;
} {
  if (!header) return { settled: false };
  try {
    const decoded = decodePaymentResponseHeader(header) as {
      success?: boolean;
      transaction?: string;
    };
    const hash =
      typeof decoded.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(decoded.transaction)
        ? decoded.transaction
        : undefined;
    return {
      settled: decoded.success === true,
      ...(hash ? { transactionHash: hash } : {}),
      raw: header,
    };
  } catch {
    return { settled: false, raw: header };
  }
}

/** What happened when an approved invoice was actually paid. */
export interface SettlementResult {
  paid: boolean;
  /** The entrypoint's result, once the payment cleared. */
  output: unknown;
  /** The settlement receipt the server returned, when it returned one. */
  receipt?: string;
  error?: string;
}

/**
 * Pay an approved invoice and record it.
 *
 * Intent first, then the payment, then the outcome — the same discipline every
 * other movement in this treasury follows, and for the same reason: the failure
 * that actually costs money is not a rejected payment, it is a process that
 * dies between paying and writing it down.
 */
export async function settle(
  plan: PaymentPlan,
  request: { url: string; input: Record<string, unknown> },
  ledger: Ledger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SettlementResult> {
  if (plan.outcome !== "pay") {
    throw new SettlementError(
      `settle() called on a plan the policy engine did not approve (${plan.outcome}). ` +
        `This is the one ordering that must never be reversed.`,
    );
  }
  if (!plan.intentId || !plan.chainId || !plan.amount || !plan.payTo || !plan.asset) {
    throw new SettlementError("approved plan is missing the details needed to pay it");
  }

  const entry = {
    intentId: plan.intentId,
    leg: "purchase" as const,
    chainId: plan.chainId,
    to: plan.payTo,
    amount: plan.amount,
    token: plan.asset,
    decimals: plan.decimals ?? 6,
    memo: `x402 invoice — ${request.url}`,
    // Paid from the payer key, not through KeeperHub. reconcile() must report
    // this rather than "replay" it into a second real payment.
    submission: { kind: "x402" as const, url: request.url },
  };

  // Build the signer first. If there is no key, or no signer for this chain,
  // nothing has been attempted and nothing should be written down — a recorded
  // intent for a payment that was never tried is a phantom for reconcile to
  // chase against a chain where it cannot possibly appear.
  const signed = { attempted: false };
  const payingFetch = createPayingFetch(plan.chainId, plan, env, signed);

  // Written before anything is signed.
  await ledger.append({ ...entry, status: "intent" });

  try {
    const response = await payingFetch(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ input: request.input }),
    });

    const text = await response.text();

    // The server reports settlement in a response header when it settles.
    const receipt = readReceipt(
      response.headers.get("x-payment-response") ??
        response.headers.get("payment-response") ??
        undefined,
    );

    if (!response.ok) {
      // An error AFTER an authorisation was signed is not proof the money
      // stayed put — the counterparty holds a signed authorisation and chooses
      // its own response code. Leaving it open counts it against the caps and
      // forces a person to look, which is the safe reading of "we do not know".
      const ambiguous = signed.attempted;
      await ledger.append({
        ...entry,
        status: ambiguous ? "submitted" : "failed",
        error:
          `${response.status} ${response.statusText}: ${text.slice(0, 200)}` +
          (ambiguous ? " (a payment was signed before this failed)" : ""),
      });
      return { paid: false, output: null, error: `${response.status} ${response.statusText}` };
    }

    let output: unknown = null;
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      output = "output" in body ? body.output : body;
    } catch {
      output = text;
    }

    // A 200 is the entrypoint answering, not the facilitator settling. When the
    // receipt says the settlement failed, the invoice is not paid.
    if (signed.attempted && receipt.raw && !receipt.settled) {
      await ledger.append({
        ...entry,
        status: "submitted",
        error: "the entrypoint answered but its settlement receipt does not report success",
      });
      return {
        paid: false,
        output,
        ...(receipt.raw ? { receipt: receipt.raw } : {}),
        error: "settlement not confirmed by the receipt",
      };
    }

    await ledger.append({
      ...entry,
      status: "confirmed",
      ...(receipt.transactionHash ? { transactionHashes: [receipt.transactionHash] } : {}),
    });

    return { paid: true, output, ...(receipt.raw ? { receipt: receipt.raw } : {}) };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    // The intent stays open rather than being closed as failed when we cannot
    // tell whether the payment landed — that is what reconciliation is for.
    await ledger.append({ ...entry, status: "submitted", error: why });
    return { paid: false, output: null, error: why };
  }
}

/** The period an invoice is idempotent within, exposed for callers that record. */
export { dailyPeriod };
