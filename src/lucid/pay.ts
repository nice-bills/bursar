/**
 * Deciding whether to pay another agent's invoice.
 *
 * The connector can fetch a quote. This decides whether to honour it, and it is
 * the part KeeperHub's issue leaves as "a low-balance payer key and a
 * `maxPriceUsd`". A price cap answers one question — is this single call too
 * expensive — and none of the others that matter when an autonomous process is
 * spending money on its own initiative:
 *
 *   - is this counterparty one we have ever agreed to pay?
 *   - how much has already gone out today, to anyone?
 *   - what is the total worth across assets, not just in this one?
 *   - is this large enough that a person should look at it first?
 *   - and if we die between signing and recording, what do we know afterwards?
 *
 * Bursar answers all of those already for its own movements. Paying an agent is
 * just another movement, so it goes through the same engine and the same ledger
 * rather than around them.
 */

import type { PaymentChallenge } from "../keeperhub/mcp.js";
import type { PolicyEngine, Movement } from "../policy/engine.js";
import { Ledger, dailyPeriod } from "../ledger/store.js";
import type { BursarConfig } from "../config.js";
import { assetPolicyFor } from "../config.js";
import { formatUnits } from "../units.js";

/** What the treasury decided about an invoice, and why. */
export interface PaymentPlan {
  outcome: "pay" | "hold" | "refuse";
  reason: string;
  /** Base units. Present whenever the challenge could be read at all. */
  amount?: string;
  asset?: string;
  payTo?: string;
  chainId?: number;
  decimals?: number;
  /** Stable id for the movement, so a retry cannot pay the same invoice twice. */
  intentId?: string;
  /** Human-readable price, once the asset's decimals are known. */
  priced?: string;
}

/**
 * `eip155:84532` → `84532`.
 *
 * CAIP-2 is what x402 challenges carry. A bare decimal is accepted too, since
 * not every issuer bothers with the prefix.
 */
export function chainIdFromNetwork(network: string | undefined): number | null {
  if (!network) return null;
  const caip = /^eip155:(\d+)$/.exec(network.trim());
  if (caip) return Number(caip[1]);
  if (/^\d+$/.test(network.trim())) return Number(network.trim());
  return null;
}

/**
 * Turn a challenge into a decision.
 *
 * Every path that cannot establish a fact refuses rather than assuming one.
 * An unreadable price, an unknown asset, an unrecognisable chain — each of
 * those is a thing we would be guessing about while signing a payment, and the
 * guess is only ever discovered afterwards.
 */
export async function planPayment(
  challenge: PaymentChallenge | null,
  context: {
    policy: PolicyEngine;
    ledger: Ledger;
    config: BursarConfig;
    /** What the payment is for, recorded on the ledger line. */
    memo: string;
    /** The entrypoint being paid, recorded so a held invoice can be found again. */
    url?: string;
    period?: string;
  },
): Promise<PaymentPlan> {
  if (!challenge) {
    return { outcome: "refuse", reason: "no payment challenge to act on" };
  }

  const amount = challenge.maxAmountRequired;
  if (!amount || !/^\d+$/.test(amount)) {
    return {
      outcome: "refuse",
      reason: "the invoice did not state a price we could read",
    };
  }

  const payTo = challenge.payTo;
  if (!payTo) {
    return { outcome: "refuse", reason: "the invoice named no payee" };
  }

  const chainId = chainIdFromNetwork(challenge.network);
  if (chainId === null) {
    return {
      outcome: "refuse",
      reason: `unrecognised settlement network ${JSON.stringify(challenge.network)}`,
      amount,
      payTo,
    };
  }

  const asset = challenge.asset;
  if (!asset) {
    return {
      outcome: "refuse",
      reason: "the invoice named no asset, so the amount has no meaning",
      amount,
      payTo,
      chainId,
    };
  }

  // The asset must be one policy already knows how to bound. Without an entry
  // there are no caps for it and no decimals to read it with, and "1000000" of
  // an unknown token is not a number anyone can reason about.
  const assetPolicy = assetPolicyFor(context.config.policy, asset);
  if (!assetPolicy) {
    return {
      outcome: "refuse",
      reason:
        `no policy.assets entry for ${asset}; refusing to pay in an asset with no limits`,
      amount,
      asset,
      payTo,
      chainId,
    };
  }

  const period = context.period ?? dailyPeriod();
  const movement: Movement = {
    leg: "purchase",
    chainId,
    to: payTo,
    amount,
    token: asset,
    decimals: assetPolicy.decimals,
    memo: context.memo,
  };

  const intentId = Ledger.intentId({
    leg: "purchase",
    chainId,
    to: payTo,
    amount,
    token: asset,
    period,
  });

  const priced = `${formatUnits(BigInt(amount), assetPolicy.decimals)} ${assetPolicy.symbol}`;
  const common = {
    amount,
    asset,
    payTo,
    chainId,
    decimals: assetPolicy.decimals,
    intentId,
    priced,
  };

  // Already settled under this key in this period. Paying again would buy the
  // same answer twice.
  if (await context.ledger.alreadyConfirmed(intentId)) {
    return {
      outcome: "refuse",
      reason: "this invoice was already paid under the same key this period",
      ...common,
    };
  }

  const decision = await context.policy.evaluate(movement);
  if (decision.verdict === "deny") {
    return { outcome: "refuse", reason: decision.reason, ...common };
  }

  // Evaluating the movement is what prices it, so the USD value only exists
  // now. It has to reach the ledger or the cross-asset ceiling sums nothing for
  // purchases, and an agent can buy its way past a limit it never touches.
  const valued = {
    ...common,
    ...(movement.valueUsdCents ? { valueUsdCents: movement.valueUsdCents } : {}),
  };

  if (decision.verdict === "needs_approval") {
    // Write the hold down. A request that needs a person is worthless if it
    // evaporates when the process ends, and `awaitingApproval()` is where the
    // operator looks — returning "held" without recording it meant the queue
    // was always empty and no held invoice could ever be approved.
    await context.ledger.append({
      intentId,
      leg: "purchase",
      chainId,
      to: payTo,
      amount,
      token: asset,
      decimals: assetPolicy.decimals,
      ...(movement.valueUsdCents ? { valueUsdCents: movement.valueUsdCents } : {}),
      memo: context.memo ?? `x402 invoice — ${priced}`,
      submission: { kind: "x402" as const, url: context.url ?? "" },
      status: "awaiting_approval",
      heldReason: decision.reason,
    });
    return { outcome: "hold", reason: decision.reason, ...valued };
  }

  return { outcome: "pay", reason: `within policy — ${priced}`, ...valued };
}
