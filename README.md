# Bursar

**The autonomous CFO for AI agents. MCP in, KeeperHub out.**

Agents can earn now. x402 and MPP let an agent charge for its work over HTTP and
settle onchain. But earning is only half an economy — the other half is what the
agent does with the money, and today that half is a human with a spreadsheet.

Bursar closes the loop. It is an MCP server that gives any agent a treasury:
it collects what the agent earns, pays out what it owes, keeps its own gas
topped up so it can keep working, and puts the surplus to work. Every leg
executes onchain through KeeperHub.

## The money loop

Four legs, each a real transaction:

| Leg | What it does |
| --- | --- |
| **Sweep** | Collect x402/MPP earnings into the treasury wallet |
| **Payout** | Split revenue to contributors by configured shares |
| **Float** | Keep operational gas topped up per chain, so the agent never stalls |
| **Yield** | Route surplus above the buffer into Aave V3 |

Plus **Report**: a P&L and audit trail assembled from KeeperHub run history, so
you can answer "where did the money go" with transaction hashes.

## Why MCP in, KeeperHub out

Bursar is not bound to one agent framework. It speaks MCP, so ElizaOS,
Daydreams, CrewAI, LangChain, and Claude Code all mount it the same way and
inherit a treasury with no adapter code. Underneath, it speaks to KeeperHub for
execution — gas estimation, private routing, retries, and the audit trail are
KeeperHub's job, and reimplementing them would be the wrong kind of ambitious.

The result: we didn't integrate with one project. We built something every
agent project can mount.

## Reliability

The interesting failures in a treasury are not "the swap reverted", they are
"the payout half-completed and now the ledger disagrees with the chain". So:

- **Idempotency keys are mandatory on every write.** The client refuses to send
  a non-GET request without one, because a retried transfer is a double-spend.
- **Retries are bounded and jittered**, honouring `Retry-After`, and only for
  429/5xx/network — never for a 4xx that will fail identically.
- **Rate limiting is client-side**, under KeeperHub's 60/min, so a multi-chain
  sweep throttles itself instead of getting throttled.
- **Execution polling survives the API's 60s wait cap** by re-issuing the
  blocking wait until a terminal state or our own deadline.
- **Response normalization is centralized**, so a schema change breaks one
  function instead of leaking `any` through the codebase.

## Setup

```bash
npm install
cp .env.example .env    # paste your kh_ key from app.keeperhub.com -> API Keys
npm run smoke           # read-only: verifies auth, wallet, chains
```

To prove execution end to end (this moves real value):

```bash
npm run smoke -- --execute
```

## Status

Early. The client and the day-1 smoke path are in; the four workflow legs and
the MCP surface are next. Response shapes from the KeeperHub API are typed
loosely on purpose until the smoke test confirms them against a live org.

Built for the KeeperHub Agent Economy Hackathon.
