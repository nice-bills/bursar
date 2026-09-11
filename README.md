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
  Allowlist, per-transfer ceiling, rolling 24h cap. Deny by default.
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
- **Payouts go out on the chain that holds the money.** Preferring a
  private-mempool chain used to silently redirect them: a treasury funded on
  Base would pay out on Ethereum mainnet, where it holds nothing, so every
  transfer failed and the MEV protection bought nothing.
- **Amounts are read strictly from natural language.** "pay the 3 contributors
  0.01 each" must not become three ether. When more than one number could be
  the amount, Bursar refuses and asks.

## KeeperHub surfaces used

| Surface | How |
| --- | --- |
| REST direct execution | `POST /execute/transfer` for every payout |
| Idempotency | Server-side replay protection, verified end to end |
| Agent-authored workflows | Bursar composes and upserts a float monitor onto KeeperHub, then executes it and reads its output ([`dg9oxiktaln5qv9hl5987`](https://app.keeperhub.com/workflows/dg9oxiktaln5qv9hl5987)) |
| Audit trail | Execution ids and transaction hashes recorded per movement |
| Private routing | Payouts prefer chains with MEV-protected submission |

The float was meant to be a self-contained keeper on KeeperHub's schedule —
**an agent that has crashed cannot notice it has run out of gas.** The balance
half runs green; the comparison does not, because a Condition node cannot read
a `web3/check-balance` node's output (see below). So Bursar executes the
monitor workflow and decides in-process. That costs the crash-resilience, but
buys something back: the top-up now passes through the policy engine, the
ledger, and idempotency, which a pure workflow would have bypassed.

## The money loop

| Leg | Status |
| --- | --- |
| **Payout** — split revenue to contributors by share | Working, onchain |
| **Sweep** — consolidate earnings into the treasury | Working, onchain |
| **Yield** — surplus above the buffer into Aave v3 | Working, onchain |
| **Float** — keep the operating wallet in gas | Working; balance read via workflow, decision in-process |
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

Then, in an ElizaOS character:

```jsonc
{
  "name": "MyAgent",
  "plugins": ["plugin-bursar"],
  "settings": {
    "secrets": { "KEEPERHUB_API_KEY": "kh_..." },
    "BURSAR_CONFIG_PATH": "bursar.config.json"
  }
}
```

Scripts: `npm run agent` (dry) / `-- --execute`, `npm run demo` (dry) / `-- --execute`, `npm run chains`,
`npm run workflow` (dry) / `-- --create`, `npm run smoke`,
`npm run chaos` (dry) / `-- --execute`.

`npm run chaos` induces real failures — a torn ledger line, a crash before
submitting, a crash after submitting — and asserts the recovery. The live
scenarios prove reconciliation against the chain rather than asserting it.

## What we found in KeeperHub along the way

Documented behaviour that differs from the live API, all confirmed by probing:

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
6. `/execute` accepts only `transfer` and `contract-call` — there is no balance
   endpoint, so balance-gated logic must live in a workflow.
7. Workflows are updated with `PATCH`; `PUT` and `POST` both answer 405. A
   workflow that has ever run cannot be deleted until its executions are, so
   re-authoring must upsert rather than replace.
8. **A Condition node cannot read a `web3/check-balance` node's output.** Every
   reference form fails identically in freshly created workflows:
   `{{@step-1:Bal.balanceWei}}`, `{{step-1.balanceWei}}`,
   `{{@step-1:Bal.balance}}` — *"Unresolved template reference(s) … resolver
   did not match."* The field is real (executing the balance node alone returns
   `{ address, balance, balanceWei, addressLink, success }`) and the `@` form is
   what KeeperHub's own Aave template uses, so core web3 node outputs appear not
   to be registered with the template resolver. This is the one finding that
   changed our architecture.
9. `PATCH` followed immediately by `execute` can run the *previous* definition.
   Worth knowing before concluding a fix did not work — it cost us an hour.
10. **Units differ between surfaces.** `/execute/transfer` takes a decimal
    string; the `aave-v3/supply` workflow node takes base units. Same platform,
    opposite conventions.
11. **Execution payloads differ between surfaces too.** Direct execution returns
    `transactionHash` as a string; workflow execution returns
    `transactionHashes` as an array of objects carrying `hash`, `gasUsed`,
    `blockNumber` and `receiptStatus`. Stringifying one as the other writes
    `"[object Object]"` into your audit trail, which is how we first stored it.
12. `web3/check-balance` is native-only — it rejects a `token` field. ERC-20
    balances need `web3/read-contract` with `balanceOf`.

And in Aave's Sepolia market, which cost a detour: `supplyCap == 0` means *no
cap*, not "nothing may be supplied". DAI, USDC and USDT have all hit their 2B
caps there and revert with `Error(51)`; LINK, WBTC and WETH are uncapped.

And in ElizaOS itself, from booting it:

10. `AgentRuntime.initialize()` queries the `agents` table *before* running
    plugin migrations, so it cannot start against a brand-new database. Migrate
    first and pass the adapter in.
11. The database adapter's agent id must match the runtime's (derived from the
    character name), or writes fail on a foreign key violation.
12. `registerService()` is called without being awaited, so services start
    asynchronously after plugin registration returns and there is no public
    "ready" signal. Poll for the service rather than racing it.

The workflow validator is genuinely good: it reports every invalid node at once
with `path`, `expected`, and `received`, which made the above discoverable.

## Known gaps

Stated plainly, since the submission form asks.

- Testnet only so far. Nothing is chain-specific about the code, but the mainnet
  path has not been exercised.
- The float decision runs in-process, so it does not survive the agent being
  down — see the resolver limitation above.
- Spending limits are denominated in the native asset only. ERC-20 movements
  are refused outright rather than measured against a cap that does not apply
  to them, which is what blocks the yield leg today.
- Free OpenRouter models are rate-limited and go "temporarily overloaded"
  without warning, so `npm run agent` tries several in turn. With no
  `OPENROUTER_API_KEY` it falls back to a deterministic stub, which exercises
  every plugin surface but cannot show a model choosing the action.
- KeeperHub enforces a server-side daily spending cap per organisation. Running
  the full chaos suite repeatedly in one day can exhaust it, and scenarios then
  fail for that reason rather than a defect.

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
