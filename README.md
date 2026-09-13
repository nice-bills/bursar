# Bursar

**An onchain treasury for ElizaOS agents. Execution by KeeperHub.**

An ElizaOS agent can hold a wallet and can earn. What it cannot do is run its
own finances: split revenue among the people who built it, keep itself in gas so
it does not stall mid-task, and prove afterwards where the money went. That work
is done today by a human with a block explorer open.

`plugin-bursar` gives the agent a treasury. Mount it in a character's plugin
list and the agent gains a policy-bounded set of money movements, each one
executed and audited through KeeperHub.

Built for the KeeperHub Agent Economy Hackathon. Integration target: **ElizaOS**.

## Proof it works

Real transactions on Ethereum Sepolia, executed by the plugin's
`PAY_CONTRIBUTORS` action distributing revenue 60/40 to the configured
contributors:

| Contributor | Share | Amount | Transaction |
| --- | --- | --- | --- |
| model-provider | 60% | 0.0000018 | [`0xc74c0114…`](https://sepolia.etherscan.io/tx/0xc74c01140f72d5080a1071abaab64b8dfb1d95a37096bad4bfe8a5ca29a30257) |
| tool-author | 40% | 0.0000012 | [`0xa8b451ef…`](https://sepolia.etherscan.io/tx/0xa8b451ef8376498859d6bceb007efa3315ae409d81d738f321a747e294686939) |

Crash recovery, proven against the live API rather than asserted
(`npm run chaos -- --execute`):

| Scenario | Outcome | Transaction |
| --- | --- | --- |
| Crash **before** submit | reconcile completes the approved movement | [`0x15f8431a…`](https://sepolia.etherscan.io/tx/0x15f8431a0f125205b46aaaa5ac2bf1b5000a463ee5c19e0cf0c95cf336ed4a8c) |
| Crash **after** submit | reconcile recovers the *original* transaction, no second transfer | [`0x179a1859…`](https://sepolia.etherscan.io/tx/0x179a18592959181196d6563a3f8f4f7e7f6d9250a2acecbe9679f34f291434c9) |
| Balance below floor | the float's top-up branch executes | [`0x9717aff4…`](https://sepolia.etherscan.io/tx/0x9717aff48b014f40b9f72b9a8629097747fe345ba6c305f280d308515e73c945) |

Every leg of the money loop, onchain:

| Leg | What ran | Transaction |
| --- | --- | --- |
| Payout | 60/40 split to contributors | [`0xc74c0114…`](https://sepolia.etherscan.io/tx/0xc74c01140f72d5080a1071abaab64b8dfb1d95a37096bad4bfe8a5ca29a30257) |
| Sweep | WETH consolidated to the treasury, capped by policy | [`0x14832bd5…`](https://sepolia.etherscan.io/tx/0x14832bd5cf9abe8faa7735280f3aa15b5aaec4c2005b760ce9a5584b4696d53e) |
| Yield | 3 LINK supplied to Aave v3 | [`0xb92cb3a3…`](https://sepolia.etherscan.io/tx/0xb92cb3a3f5b687b072159e60db3bfe97b23faa4da4a0125d07f67c3bcd7bb5c9) |
| Float | top-up below the floor | [`0x9717aff4…`](https://sepolia.etherscan.io/tx/0x9717aff48b014f40b9f72b9a8629097747fe345ba6c305f280d308515e73c945) |

And through a real ElizaOS agent, where a language model read the request in
plain English, chose `PAY_CONTRIBUTORS`, and the payout executed
(`npm run agent -- --execute`):

> "We earned some revenue this week. Please pay out 0.0000021 to the contributors."

| Contributor | Share | Transaction |
| --- | --- | --- |
| model-provider | 60% | [`0x849da664…`](https://sepolia.etherscan.io/tx/0x849da66409dd9866824ef063fd731968f863962e615d6974a21861e9248d4357) |
| tool-author | 40% | [`0x90d68676…`](https://sepolia.etherscan.io/tx/0x90d686769ac52ccccc0d56b4c41d0bd9c0dffd6af4d065699a5d0b455c212210) |

Reproduce with `npm run demo -- --execute`. Run it twice: the second run pays
nobody, because every movement is idempotent by construction.

## What the integration actually is

Not a generic wrapper. Three ElizaOS extension points, each chosen because it
is the right one:

**`BursarService`** extends their `Service`, so the runtime owns its lifecycle.
That is load-bearing rather than decorative: the ledger's open-intent invariant
holds only if there is exactly one writer per agent, and the runtime guarantees
a single shared instance across every action and provider.

**`treasuryProvider`** is the part a tool-only integration cannot do. Providers
feed the agent's *perception* — their output is composed into the prompt before
the model reasons. So a locked treasury is something the agent simply knows,
the way it knows the time, instead of something it must call a tool to
discover. An agent that is blocked stops promising payouts it cannot make.

Verified in a real runtime, not assumed. `npm run agent` boots an actual
`ElizaOS` orchestrator with a pglite database and asserts that the provider's
text lands in `composeState` output, that the runtime resolves the service, and
that `processActions` dispatches the action. That harness immediately caught a
bug the standalone tests could not: the provider was marked `dynamic: true`,
and `composeState` filters on `!p.private && !p.dynamic`, so treasury state was
silently absent from every prompt. `dynamic` does not mean "recompute each
time" — providers are always called fresh — it means "opt-in only".

The provider then paid for itself. Asked to *"pay out 5"* — far above the
0.02 ceiling — the model did not attempt it and get refused. It read the limits
out of the TREASURY provider and declined up front, quoting them back and
offering an amount that would fit. That is the difference between an agent that
learns its constraints from a failure and one that knows them while reasoning.

**Actions** — `PAY_CONTRIBUTORS`, `RECONCILE_TREASURY`, `TREASURY_REPORT` —
with `validate()` gates that are real. `PAY_CONTRIBUTORS` refuses to be offered
when the message names no amount, because guessing how much of a treasury to
distribute is not a recoverable mistake.

## Reliability

The interesting failure in a treasury is not a reverted transaction. It is a
process that dies between "money left" and "we wrote it down".

- **Intent-first ledger.** Every movement is recorded *before* it is submitted.
  A crash leaves a reconcilable record, not a gap.
- **Reconciliation by idempotent replay.** Open intents are replayed under their
  original idempotency key. Confirmed against the live API: a recognised key
  returns the *original* execution flagged `idempotentReplay: true`, without
  running a second transaction. So reconciliation asks the server what happened
  instead of guessing — and if the movement never ran, it completes one that
  policy already approved. Either way the ledger ends up agreeing with the chain.
- **Unreconciled intents block everything.** If we do not know the true balance,
  committing more money is guesswork, so the treasury locks until it is resolved.
- **Writes without an idempotency key throw.** A retried transfer is a
  double-spend; the client makes that impossible to express.
- **Exact integer money math.** Base units as `bigint` everywhere internally,
  converted to the API's decimal strings at exactly one boundary. Basis-point
  splits assign the division remainder deterministically, so no wei is lost.
- **Policy answers only from config and ledger history**, never from the model.
  Allowlist, per-asset ceilings, rolling 24h caps, and KeeperHub's own enforced
  budget. Deny by default.
- **A ceiling across every asset at once.** Per-asset caps bound each token and
  nothing bounds the treasury — six assets, each generously capped, add up to
  no ceiling. `maxPerDayUsd` bounds total value leaving in 24h. The price comes
  from a Chainlink aggregator read *through KeeperHub*, so the oracle lands in
  the same execution history as every transfer rather than being a dependency
  nobody audited. Valuations are recorded with the movement, never recomputed,
  because a limit that re-prices history at today's rate moves with the market.
  A stale feed refuses the movement: fails closed.
- **Approval holds, it does not refuse.** A movement over
  `requireApprovalAbove` is written to the ledger as `awaiting_approval` and
  waits for a person — a request that needs sign-off is worthless if it
  evaporates when the agent gives up. Held movements do not consume the daily
  caps, because unapproved requests must not starve approved ones, and
  approving lifts the threshold only: the allowlist and every other check run
  again on the way through.
- **Movements are serialised.** A daily cap is a serial invariant: ten payouts
  fired at once will each read the ledger before any writes, all pass, and
  breach the cap tenfold. ElizaOS dispatches actions concurrently, so this is
  real. `Executor` holds a mutex across check-and-record; throughput is worth
  nothing if the balance is wrong. Across *processes*, the ledger takes an
  advisory lock — with stale-holder takeover, because a treasury that cannot
  reconcile after a crash is worse than one that risks a rare concurrent write.
- **A sweep to your own wallet is refused.** It moves nothing but still burns
  gas and consumes the daily cap — a slow leak that also eats the budget a real
  payout needs.
- **Local policy is reconciled with the platform's own cap.** KeeperHub enforces
  a per-organisation daily ceiling — 0.02 ETH here — and that is the limit that
  actually binds. A locally configured 0.1 was fiction: movements passed every
  local check and then failed at the API for a reason the policy engine never
  saw. It now reads `get_spending_limits` and refuses with the real numbers.
- **Payouts go out on the chain that holds the money.** Preferring a
  private-mempool chain used to silently redirect them: a treasury funded on
  Base would pay out on Ethereum mainnet, where it holds nothing, so every
  transfer failed and the MEV protection bought nothing.
- **Amounts are read strictly from natural language.** "pay the 3 contributors
  0.01 each" must not become three ether. When more than one number could be
  the amount, Bursar refuses and asks.

## Why this is not a wrapper around the MCP server

KeeperHub's MCP server exposes 44 tools. An agent that mounts them pays for
every definition in every prompt before it has done anything, and one of those
tools — `list_action_schemas` — answers with close to half a megabyte, so a
single call swamps the context it was meant to inform.

Bursar follows the code-execution pattern instead: the server is an API that
*code* calls, the traffic stays in the program, and the model sees a small
task-shaped surface. Measured with `npm run context-cost`:

| | Mounting KeeperHub directly | With plugin-bursar |
| --- | --- | --- |
| Always in the prompt | ~13,300 tokens (44 tool definitions) | ~950 tokens (6 actions + 1 provider) |
| One schema lookup | ~120,600 tokens | ~370 tokens |

**14x smaller resident surface, 330x smaller per lookup.** The 44 tools are all
still reachable — Bursar calls them — they are just not in the prompt, and
neither is the traffic between them.

That is also the difference between a treasury and a toolbelt. An agent holding
44 execution tools can do anything with the money and has to be *asked* not to.
An agent holding `PAY_CONTRIBUTORS` can only pay contributors, by their
configured shares, within caps it cannot raise.

## KeeperHub surfaces used

| Surface | How |
| --- | --- |
| REST direct execution | `POST /execute/transfer` for every payout |
| Idempotency | Server-side replay protection, verified end to end |
| Agent-authored workflows | Bursar composes and upserts a float monitor onto KeeperHub, then executes it and reads its output ([`dg9oxiktaln5qv9hl5987`](https://app.keeperhub.com/workflows/dg9oxiktaln5qv9hl5987)) |
| Audit trail | Execution ids and transaction hashes recorded per movement |
| MCP server | `list_action_schemas` for authoritative action schemas, `get_spending_limits` to read the org's enforced daily budget |
| Private routing | Payouts prefer chains with MEV-protected submission |

The float is a self-contained keeper on KeeperHub's schedule, because **an
agent that has crashed cannot notice it has run out of gas.** It reads the
balance, compares it to the floor and tops up, entirely on the platform — no
agent process involved:
[`0xd0a0cc0c…`](https://sepolia.etherscan.io/tx/0xd0a0cc0cbc0cf134992053196612149e967ed0587df979e66c18705adb5a0914)

## The money loop

| Leg | Status |
| --- | --- |
| **Payout** — split revenue to contributors by share | Working, onchain |
| **Sweep** — consolidate earnings into the treasury | Working, onchain |
| **Yield** — surplus above the buffer into Aave v3 | Working, onchain |
| **Float** — keep the operating wallet in gas | Working; a keeper that runs on KeeperHub without the agent |
| **Report** — statement with a hash per line | Working |

Yield runs through the executor like every other movement, so the lending pool
has to be on the allowlist and the amount has to clear the asset's own caps.
Depositing into a pool is still value leaving the treasury, and routing it
around the policy engine because it is "not really a transfer" is exactly how
that kind of hole gets made. The approval is scoped to the amount being
supplied rather than granted without limit.

## Setup

```bash
npm install
cp .env.example .env                       # your kh_ key from app.keeperhub.com
cp bursar.config.example.json bursar.config.json
npm run smoke                              # read-only: auth, wallet, chains
npm test
```

To have a real model choose the actions, add a free
[OpenRouter](https://openrouter.ai) key as `OPENROUTER_API_KEY`. OpenRouter
does not serve embeddings, so a local zero-vector stub covers those; the
harness never searches by similarity, so only their width matters.

### Running it as an agent

`character/treasurer.character.json` is a complete ElizaOS character — system
prompt, bio, style, message examples wired to the treasury actions, and the
plugin list. A test validates it against ElizaOS's own `validateCharacter`
rather than against our idea of the format, and asserts that every action it
demonstrates is one the plugin actually registers.

```bash
elizaos start --character character/treasurer.character.json
```

`npm run agent` boots the same file through `ElizaOS`/`AgentRuntime` directly
and asserts what a judge would want to check by hand: that the runtime starts
the service, that the provider's text reaches `composeState`, and that a model
selects `PAY_CONTRIBUTORS` from plain English. Add `--execute` to let the
dispatched payout settle, `--no-model` to skip the model entirely.

Secrets are never in the character file — `KEEPERHUB_API_KEY` and
`OPENROUTER_API_KEY` come from the environment, and a test asserts the
committed file contains neither.

Scripts: `npm run agent` (dry) / `-- --execute`, `npm run demo` (dry) / `-- --execute`, `npm run chains`,
`npm run workflow` (dry) / `-- --create`, `npm run smoke`,
`npm run chaos` (dry) / `-- --execute`.

`npm run chaos` induces real failures — a torn ledger line, a crash before
submitting, a crash after submitting — and asserts the recovery. The live
scenarios prove reconciliation against the chain rather than asserting it.

## Notes on the KeeperHub API

Behaviour that differs from the docs, confirmed against the live API:

1. Transfer takes `recipientAddress`, not `to`.
2. `amount` is a **human-readable decimal string, not base units**. Sending
   `"1000000000000"` for a 1e-6 ETH transfer is read as a trillion ETH — and
   fails as a *spending cap* error, which reads like a permissions problem.
3. Direct transfers complete synchronously and are not workflow executions;
   `/workflows/executions/{id}/wait` returns 404 for them.
4. Workflow creation is `POST /workflows/create`. `POST /workflows` is 405.
5. Web3 node action types are slash-kebab (`web3/check-balance`,
   `web3/transfer-funds`), not the documented `web3.getNativeBalance` /
   `web3.transferNative`, which the validator rejects as unknown.
6. `/execute` accepts only `transfer` and `contract-call`. Balance-gated logic
   belongs in a workflow.
7. Workflows are updated with `PATCH`; `PUT` and `POST` both answer 405. A
   workflow that has ever run cannot be deleted until its executions are, so
   re-authoring must upsert rather than replace.
8. `PATCH` followed immediately by `execute` can run the *previous* definition.
9. **Units differ between surfaces.** `/execute/transfer` takes a decimal
   string; the `aave-v3/supply` workflow node takes base units.
10. **Execution payloads differ between surfaces too.** Direct execution returns
    `transactionHash` as a string; workflow execution returns
    `transactionHashes` as an array of objects carrying `hash`, `gasUsed`,
    `blockNumber` and `receiptStatus`. Stringifying one as the other writes
    `"[object Object]"` where a hash should be.
11. `web3/check-balance` is native-only and rejects a `token` field;
    `web3/check-token-balance` is the ERC-20 equivalent.
12. A Condition node takes a `condition` expression plus an optional
    `conditionConfig` for the visual builder. Passing a top-level `group` key
    is accepted by the validator but leaves the template reference unresolved
    at execution.

`list_action_schemas` on the MCP server is the authoritative source for all of
the above: every action type with its required fields, its output fields, and a
worked templating example. It is the first thing to reach for.

In Aave's Sepolia market, `supplyCap == 0` means *no cap*, not "nothing may be
supplied". DAI, USDC and USDT have hit their 2B caps and revert with
`Error(51)`; LINK, WBTC and WETH are uncapped.

And in ElizaOS:

13. `AgentRuntime.initialize()` queries the `agents` table *before* running
    plugin migrations, so it cannot start against a brand-new database. Migrate
    first and pass the adapter in.
14. The database adapter's agent id must match the runtime's (derived from the
    character name), or writes fail on a foreign key violation.
15. `registerService()` is called without being awaited, so services start
    asynchronously after plugin registration returns and there is no public
    "ready" signal. Poll for the service rather than racing it.
16. A provider marked `dynamic: true` is excluded from `composeState` unless
    explicitly requested — it means "opt-in", not "recompute each time".

## Known gaps

Stated plainly, since the submission form asks.

- Testnet only so far. Nothing is chain-specific about the code, but the mainnet
  path has not been exercised.
- The ledger lock is advisory and per-file. It stops a second Bursar writing the
  same ledger; it does not stop something else writing that file.
- Free OpenRouter models are rate-limited and go "temporarily overloaded"
  without warning, so `npm run agent` tries several in turn. With no
  `OPENROUTER_API_KEY` it falls back to a deterministic stub, which exercises
  every plugin surface but cannot show a model choosing the action.
- The approval queue has no expiry. A held movement waits indefinitely, which
  is the right default for money but means a forgotten request stays in the
  list rather than lapsing.
- The valuation cache is per process. Two Bursars would each read the feed.

## Layout

```
src/
  index.ts              Plugin manifest
  eliza/                Service, provider, actions, standalone runtime
  treasury/             Executor (the one path value moves through), workflows
  policy/               Deny-by-default policy engine
  ledger/               Append-only intent ledger
  keeperhub/            Typed REST client: retries, rate limits, idempotency
  units.ts              Base units <-> decimal, the one conversion boundary
```
