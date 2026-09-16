# Bursar

**An onchain treasury for ElizaOS agents. Execution by KeeperHub.**

An ElizaOS agent can hold a wallet and can earn. What it cannot do is run its
own finances: split revenue among the people who built it, keep itself in gas so
it does not stall mid-task, and prove afterwards where the money went. That work
is done today by a human with a block explorer open.

`plugin-bursar` gives the agent a treasury. Mount it in a character's plugin
list and the agent gains a policy-bounded set of money movements, each one
executed and audited through KeeperHub.

Built for the KeeperHub Agent Economy Hackathon.

**Live project: [Aave v3](https://aave.com).** KeeperHub is the execution layer
between the treasury and the protocol — and the wiring runs both ways. Aave's
own contract state decides whether value moves, a KeeperHub schedule acts on
that state while the agent is down, and every leg has a receipt. Details and
raw output in [`evidence/aave-v3.md`](./evidence/aave-v3.md).

**Bursar also earns.** It publishes a
[payout preflight](https://app.keeperhub.com/workflows/y2if3cv7fi1lon9pgrwc4) to
KeeperHub's marketplace at $0.01 USDC per call, so the revenue it splits is
revenue it made.

**And it buys.** [KeeperHub issue #2329](https://github.com/KeeperHub/keeperhub/issues/2329)
asks for a connector that can discover and call a Lucid Agents entrypoint, free
or x402-priced, protecting the money with a low-balance payer key and a per-call
`maxPriceUsd`. Bursar ships that connector with the decision handed to its policy
engine instead — because a price cap cannot ask who is being paid, how much has
gone out today, what it is worth across assets, or what is known if the process
dies mid-payment. Details in [`evidence/lucid-agents.md`](./evidence/lucid-agents.md).

The agent surface is **ElizaOS**: mount the plugin in a character's plugin list
and the agent gains the treasury.

## Proof it works

### Aave v3 is read, not just written

Supplying to a lending pool proves a transaction landed. It does not prove the
position exists, that it earns, or that the money can come back. So Aave's own
state is read through KeeperHub and that state governs what happens next.

Three reads of `currentATokenBalance` minutes apart, against 5 LINK supplied:

| Read | aToken balance | Collateral |
| --- | --- | --- |
| first | 5.165120505432263390 | $154.95 |
| second | 5.165395463617371347 | $154.96 |
| third | 5.165400046253789813 | $154.96 |

The balance rises because that figure is principal plus accrued interest —
**0.1654 LINK earned**, read from the protocol rather than assumed.

Aave's live supply rate is read immediately before depositing and gates the
deposit. Supplying into a collapsed rate spends real gas to earn nothing, and
the rate is knowable beforehand. The read **fails closed**: not knowing what
Aave pays is not the same as Aave paying enough.

The money comes back out, so yield is not a one-way door:

| Step | aToken balance |
| --- | --- |
| before | 5.165400046253789813 |
| after withdrawing 0.1 | 5.065413794163045197 |
| after withdrawing the accrued yield | 5.000445359287327522 |

Principal intact, yield harvested —
[`0xd96c8ee7…`](https://sepolia.etherscan.io/tx/0xd96c8ee7187ddf833f6acb13f32e23fd92d09c6c5469a9e5c12c9b13590656fb)

### Aave triggers the movement, not us

The rate keeper runs on KeeperHub's schedule, reads Aave's supply rate, and
pulls the position out if the protocol stops paying enough. The agent can be
down and the treasury still reacts — the only condition under which reacting
matters, because a rate collapse does not wait for the agent to come back up.

Both branches, against the live rate:

| Floor | Aave's live rate | Gate | Result |
| --- | --- | --- | --- |
| 1.00% | 234.37% | `{"condition":false}` | nothing moved |
| 300.00% | 234.37% | fired | withdrew, [`0x10f52ead…`](https://sepolia.etherscan.io/tx/0x10f52eadf477d85a439a9a7b3ce75c8aa55cec42aaad6a0b113236d8a236ee20) |

### Bursar sells a service and is paid for it

The listing is public, priced, and answers with a real x402 challenge:

```
402 Payment Required
  amount  10000            (USDC, 6dp — $0.01)
  asset   0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913   (USDC on Base)
  network eip155:8453
  payTo   0x8d9abc5b07917229159886be02e5eed1dc7fbdc9   (the treasury)
```

It sells a payout preflight: an agent about to send a payment asks whether doing
so would leave it below the gas it needs to keep operating. Agents strand
themselves this way routinely — after the payment, when the money is already
gone. Reading your own balance is easy; remembering to do it before every spend
is what nobody does.

`npm run listing -- --verify` reproduces the challenge.

### It pays other agents, under policy

Run against a real Lucid Agent built from Daydreams' own SDK
([`examples/lucid-agent`](./examples/lucid-agent)), serving the two surfaces the
issue names. The same invoice, four ways:

| Situation | Bursar |
| --- | --- |
| Asset has no configured limits | refuses — "refusing to pay in an asset with no limits" |
| Price feed is 18 hours stale | refuses — "refusing to value a movement against a stale price" |
| Everything clears | pays — `within policy — 0.01 USDC` |
| Above the approval threshold | holds for a person |

Only the first is a question `maxPriceUsd` can ask.

Pointing it at a running agent also corrected three things the specification
does not mention, each of which fails in the same direction — reading a paid
entrypoint as free. A served card keys `entrypoints` by name while *also*
publishing an A2A `skills` array without pricing; the asset a price is
denominated in appears once at the top of the card, never on the entrypoint;
and the x402 challenge is not in the 402 body at all, but base64-encoded in a
`payment-required` header, where KeeperHub's own marketplace puts it in the
body.

```bash
cd examples/lucid-agent && npm install && npm start
npm run lucid
```

### The money loop, end to end

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
| Protocol reads | `aave-v3/get-user-account-data` and `aave-v3/get-user-reserve-data` — health factor, position, and the live supply rate that gates deployment |
| Protocol writes | `aave-v3/supply` and `aave-v3/withdraw`, so yield is a round trip rather than a one-way door |
| Conditional keepers | A scheduled workflow reads Aave's rate and branches, withdrawing only on the `true` handle |
| Marketplace | `list_workflow` + `update_workflow_listing` publish a priced service; `call_workflow` returns its x402 challenge |
| Agent-to-agent | A Lucid Agents connector — `/.well-known/agent-card.json` discovery, `/entrypoints/{key}/invoke`, and x402 invoices gated by the policy engine |

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
| **Yield** — surplus above the buffer into Aave v3 | Working, onchain; gated on Aave's live supply rate |
| **Withdraw** — pull the position back when it is needed | Working, onchain |
| **Earn** — a priced listing on KeeperHub's marketplace | Live, returns a real x402 challenge |
| **Buy** — pay another agent's x402 invoice | Working against a live Lucid Agent, gated by policy |
| **Float** — keep the operating wallet in gas | Working; a keeper that runs on KeeperHub without the agent |
| **Report** — statement with a hash per line | Working |

Yield runs through the executor like every other movement, so the lending pool
has to be on the allowlist and the amount has to clear the asset's own caps.
Depositing into a pool is still value leaving the treasury, and routing it
around the policy engine because it is "not really a transfer" is exactly how
that kind of hole gets made. The approval is scoped to the amount being
supplied rather than granted without limit.

## Adding it to your agent

Bursar is an ordinary ElizaOS plugin. Install it, name it in your character, and
give it a treasury to govern.

```bash
npm install github:nice-bills/bursar
cp node_modules/plugin-bursar/bursar.config.example.json bursar.config.json
```

Name it in your character, alongside whatever else you run:

```jsonc
{
  "name": "YourAgent",
  "plugins": ["@elizaos/plugin-sql", "@elizaos/plugin-bootstrap", "plugin-bursar"]
}
```

Or mount it directly, if you build the runtime yourself:

```ts
import bursarPlugin from "plugin-bursar";

const runtime = new AgentRuntime({
  character,
  plugins: [sqlPlugin, modelPlugin, bootstrapPlugin, bursarPlugin],
  settings: { KEEPERHUB_API_KEY: process.env.KEEPERHUB_API_KEY },
});
```

Two environment variables, one of them optional:

```bash
KEEPERHUB_API_KEY=kh_...            # app.keeperhub.com -> API Keys
BURSAR_CONFIG_PATH=bursar.config.json   # optional, this is the default
BURSAR_LEDGER_PATH=data/ledger.jsonl    # optional, this is the default
```

Your agent gains seven actions — `PAY_CONTRIBUTORS`, `SWEEP_EARNINGS`,
`DEPLOY_SURPLUS`, `CHECK_GAS_FLOAT`, `RECONCILE_TREASURY`, `REVIEW_PENDING`,
`TREASURY_REPORT` — and a `TREASURY` provider that puts the balance, the splits
and the limits into its context before it reasons.

**`bursar.config.json` is the security boundary, not a settings file.** It names
who may be paid and the ceilings that apply, and the agent cannot raise them: an
address that is not listed cannot receive value, and an amount over the cap is
refused no matter how the request is phrased. Treat it the way you would treat
the list of people with keys to the safe.

Bursar refuses to start without it rather than defaulting to something
permissive, so a misconfigured agent fails at boot instead of at the first
payout.

## The demo video

One continuous move through the schematic, never a cut: value enters, the gate
refuses what breaks policy, the payout proves itself, a 409 is reconciled under
its original key, Aave answers for its own position, and the listing sends an
invoice.

Every terminal panel quotes real output this repo produced.
`video/captured-run.txt` is the session they are read from, hashes included —
nothing in the film is typed for the camera.

`cd video && npm install && npm run render`.

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

Things the documentation does not say, found by running against it. Each one
cost a debugging session, so they are written down.

**A workflow is created disabled.** `enabled` defaults to false, and a disabled
workflow still executes perfectly well when run by hand while being skipped by
every schedule, event and block trigger. That combination is how a keeper comes
to look proven and be dormant: each manual run succeeds and the schedule never
fires once. Anything whose purpose is to run unattended must set it explicitly.

**Caller inputs reach nodes through the trigger.** A listed workflow's inputs
are referenced as `{{@trigger-1:Manual.field}}` — the same shape as node-to-node
references, because the trigger is just another node. `{{input.field}}` and
`{{field}}` both fail with "Unresolved template reference(s)". Settled by
publishing three listings that differed only in that reference and calling each.

**Pricing lives on the listing, not the publish call.** `priceUsdcPerCall` is a
field on `update_workflow_listing`, and it can only be set while the workflow is
unlisted — so price comes before publish, and changing it later means unlisting
first.

**A listing must name a payment chain.** Sepolia is rejected with
`INVALID_CHAIN`; a listing has to target something the platform recognises as a
payment or data chain, such as Base.

**The x402 challenge does not match the spec's examples.** KeeperHub sends
`amount` where the examples send `maxAmountRequired`, sends `resource` as an
object rather than a string, and wraps the JSON body in prose whose retry hint
contains braces of its own. A parser that slices to the last brace, or that
reads only the spec's field names, reports a paid listing as free.

**Aave read nodes nest their output under `result`.** Other nodes return fields
at the top level. And Aave returns `type(uint256).max` as the health factor when
an account has no debt, which is a different fact from a very large number —
only one of the two can be compared against a threshold.

And the shorter ones, all confirmed against the live API:

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

## Scope

What this does and does not reach, so nobody has to guess.

Settled on Ethereum Sepolia, with the marketplace listing priced in real USDC
on Base — KeeperHub does not accept a testnet chain for a listing. Nothing in
the code is chain-specific: the same config pointed at mainnet moves mainnet
money, and the policy engine is the reason that is a configuration change
rather than a leap of faith.

The pieces that are deliberately next:

- **Approval expiry.** A held movement waits indefinitely. That is the right
  default for money — nothing should lapse into being sent, or lapse into being
  refused, because a timer ran out — but a queue that only grows wants a review
  step eventually.
- **Cross-process valuation.** The price cache is per process, so two Bursars
  each read the feed. Correct, just not shared.
- **The ledger lock is advisory.** It stops a second Bursar writing the same
  ledger. It does not stop an unrelated process writing that file, because
  nothing short of the filesystem can.

`npm run agent` uses free OpenRouter models, which rate-limit without warning,
so it tries several in turn and falls back to a deterministic stub when no
`OPENROUTER_API_KEY` is set. The stub exercises every plugin surface; a real key
shows a model choosing the action.

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
