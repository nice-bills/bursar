# Lucid Agents — the connector KeeperHub asked for

[KeeperHub issue #2329](https://github.com/KeeperHub/keeperhub/issues/2329) is
open and unassigned. It asks for a connector so a workflow can discover and call
a Lucid Agents entrypoint, free or x402-priced, and proposes protecting the
money with "a dedicated, low-balance payer key held in the encrypted integration
store" plus a per-call `maxPriceUsd`.

This is that connector, with the payment decision handed to Bursar's policy
engine instead of a price cap. Raw run in [`lucid-run.txt`](./lucid-run.txt).

## What was run against

A real Lucid Agent, built from Daydreams' own SDK — their `createAgent`, their
`http()` and `payments()` plugins, their Hono adapter — serving the two surfaces
the issue names. Source: [`examples/lucid-agent`](../examples/lucid-agent).

```
GET  /.well-known/agent-card.json
POST /entrypoints/{key}/invoke
```

One entrypoint free, one priced at 10000 base units of USDC on Base Sepolia.

## Discovery

```
counterparty-oracle v1.0.0
  health                 free
  counterparty-check     10000 of 0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

## Why a price cap is not enough

The four outcomes below are the four decisions the engine can reach on one
invoice. Only the first is a question `maxPriceUsd` can ask.

Two of them are in [`lucid-run.txt`](./lucid-run.txt) as captured runs — the
stale-price refusal and the clear pay. The other two need a config change to
reproduce (remove the asset's `policy.assets` entry; set
`policy.requireApprovalAboveUsd` below the price), so they are described here
rather than captured.

| Situation | Bursar |
| --- | --- |
| Asset has no configured limits | refuses — "refusing to pay in an asset with no limits" |
| Price feed is 18 hours stale | refuses — "refusing to value a movement against a stale price" |
| Everything clears | pays — `within policy — 0.01 USDC` |
| Above the approval threshold | holds for a person, and writes the hold to the ledger so it can be approved later |

The payment is written to the intent ledger before it is made, so a crash
between signing and recording leaves an open intent to reconcile rather than a
silent gap. Paying is its own ledger leg (`purchase`), outbound and counted
against every cap — otherwise an agent could drain a treasury one invoice at a
time without ever touching the payout budget.

## Three things the running agent taught us

None of these are in the documentation. Each was found by pointing the connector
at a live agent and watching it be wrong.

**1. `entrypoints` is an object, not an array.** A served card keys it by name —
`{"health": {...}, "counterparty-check": {...}}` — and *also* publishes an A2A
`skills` array listing the same capabilities **without their pricing**. A parser
that prefers the array because it is an array finds every entrypoint and none of
the prices, and reads a paid entrypoint as free.

**2. The asset appears once, at the top of the card.** An entrypoint states its
price (`pricing.invoke`) and network, but not what the price is denominated in.
That lives in `payments[].extensions.x402.price.asset`. A price without its
asset is a number with no units, and the treasury refuses to pay those.

**3. The x402 challenge travels in a header.** The 402 body is `{}`; the terms
arrive base64-encoded in `payment-required`. KeeperHub's own marketplace puts
the challenge in the *body*, so a connector meeting both has to read both —
and reading only one reports a paid call as free.

All three are pinned in [`test/lucid.test.ts`](../test/lucid.test.ts) against
the captured card and header rather than invented fixtures.

## A bug this surfaced in our own policy engine

The approval threshold only applied when `movement.token === null` — the native
asset. Token spending therefore escalated to a human at no size at all: a 0.005
ETH payout would be held, while a 10,000 USDC invoice sailed through.

That is exactly backwards for an agent paying invoices, which it does in
stablecoins. `requireApprovalAboveUsd` now binds every asset, reuses the
valuation the cross-asset ceiling already computes, and fails closed when it
cannot be measured.

The bug predates this work and would have shipped.

## Settling, not just deciding

Deciding to pay and paying are different claims, so the connector does both.
`npm run lucid -- --settle` signs the x402 challenge and retries the call.

The ordering is the part worth reading. `@x402/fetch` offers a wrapped fetch
that pays any 402 it meets and retries — the obvious way to build this, and the
wrong one, because a fetch that pays automatically has no opinion about who it
is paying or how much has gone out today. Wiring it in would route money around
the policy engine rather than through it.

So the paying fetch is never used for the first call:

1. call the entrypoint with an ordinary fetch, and get the 402
2. hand the challenge to the policy engine
3. only if it approves, build the signer
4. only then record the intent, and pay

Step 4 is not literally a retry of the first request. `wrapFetchWithPayment`
issues its own unpaid call and signs whatever 402 comes back from *that*, so a
counterparty could quote one price to the policy engine and a different one to
the signer. Bursar puts a guard underneath the paying fetch: it reads every 402
before the SDK can act on it and refuses unless every offer on the table — the
amount, the payee, the asset and the chain — is the one the engine approved.
Every offer, not just the first, because the SDK picks the first offer it has a
scheme registered for, which need not be the one that was read.

Step 3 comes before step 4 deliberately. A key that is missing, or a chain this
payer has no signer for, must fail before anything is written down — a recorded
intent for a payment that was never attempted is a phantom, and reconcile would
go looking for it on a chain where it cannot possibly appear.

`settle()` refuses outright if handed a plan the engine did not approve. That
assertion is tested, because it is the one ordering that must never reverse.

The payer key is read from `BURSAR_PAYER_PRIVATE_KEY`, never logged, never
returned, and never written to the ledger — a malformed key is reported by
length, not by value, and that too is tested. It is a testnet payer by design:
cents, on test chains. Production signing belongs with a custodian, which is
what KeeperHub's Turnkey signer is and how every other movement in this project
is signed.

## Reproducing

```bash
cd examples/lucid-agent && npm install && npm start   # the counterparty
npm run lucid                                         # the connector
npm run lucid -- --max-price-age 172800               # past a stale testnet feed
npm run lucid -- --max-price-age 172800 --settle      # and actually pay it
```

The default run refuses on the stale Base Sepolia feed, which is the policy
working rather than a failure. The flag relaxes that bound for one run so the
rest of the flow can be seen; it does not change the bound that protects real
money.
