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
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";

import { Ledger, dailyPeriod } from "../ledger/store.js";
import type { PaymentPlan } from "./pay.js";

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
  env: NodeJS.ProcessEnv = process.env,
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

  return wrapFetchWithPayment(globalThis.fetch, client);
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
  };

  // Build the signer first. If there is no key, or no signer for this chain,
  // nothing has been attempted and nothing should be written down — a recorded
  // intent for a payment that was never tried is a phantom for reconcile to
  // chase against a chain where it cannot possibly appear.
  const payingFetch = createPayingFetch(plan.chainId, env);

  // Written before anything is signed.
  await ledger.append({ ...entry, status: "intent" });

  try {
    const response = await payingFetch(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ input: request.input }),
    });

    const text = await response.text();
    if (!response.ok) {
      await ledger.append({
        ...entry,
        status: "failed",
        error: `${response.status} ${response.statusText}: ${text.slice(0, 200)}`,
      });
      return { paid: false, output: null, error: `${response.status} ${response.statusText}` };
    }

    // The server reports settlement in a response header when it settles.
    const receipt =
      response.headers.get("x-payment-response") ??
      response.headers.get("payment-response") ??
      undefined;

    let output: unknown = null;
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      output = "output" in body ? body.output : body;
    } catch {
      output = text;
    }

    await ledger.append({
      ...entry,
      status: "confirmed",
      ...(receipt ? { transactionHashes: [receipt] } : {}),
    });

    return { paid: true, output, receipt };
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
