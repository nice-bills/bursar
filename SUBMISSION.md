# Bursar — submission

Ready to paste. Nothing here claims more than the transaction links show.

---

## One-liner

An onchain treasury for AI agents, with KeeperHub as the execution layer and
Aave v3 wired in both directions — the protocol's own state decides when value
moves, and Bursar earns its own revenue on KeeperHub's marketplace.

---

## What it is

An agent can hold a wallet and can earn. What it cannot do is run its own
finances: split revenue among the people who built it, keep itself in gas so it
does not stall mid-task, and prove afterwards where the money went. That work is
done today by a human with a block explorer open.

`plugin-bursar` gives the agent a treasury. Every movement runs through one
executor, so all of them inherit the same policy, the same intent ledger, and
the same idempotency key — a new leg inherits it too, and cannot opt out.

---

## The integration: Aave v3, both directions

Supplying to a lending pool proves a transaction landed. It does not prove the
position exists, that it earns, or that the money can come back. So Aave's own
contract state is read through KeeperHub, and that state governs what happens
next.

**The position earns, and the protocol says so.** Three reads of
`currentATokenBalance`, minutes apart, against 5 LINK supplied:

```
5.165120505432263390 LINK
5.165395463617371347 LINK
5.165400046253789813 LINK   →  0.1654 LINK accrued
```

**Aave's live rate gates our spending.** The supply rate is read immediately
before depositing. Supplying into a collapsed rate spends real gas to earn
nothing, and the rate is knowable beforehand. The read fails closed: not knowing
what Aave pays is not the same as Aave paying enough.

**The money comes back.** Withdrawal returns principal intact with the yield
harvested —
[`0xd96c8ee7…`](https://sepolia.etherscan.io/tx/0xd96c8ee7187ddf833f6acb13f32e23fd92d09c6c5469a9e5c12c9b13590656fb)

**Aave triggers the movement, not us.** A keeper runs on KeeperHub's schedule,
reads Aave's rate, and pulls the position out if the protocol stops paying. The
agent can be down and the treasury still reacts — the only condition under which
reacting matters, because a rate collapse does not wait for the agent to come
back up.

| Floor | Aave's live rate | Gate | Result |
| --- | --- | --- | --- |
| 1.00% | 234.37% | `{"condition":false}` | nothing moved |
| 300.00% | 234.37% | fired | withdrew — [`0x10f52ead…`](https://sepolia.etherscan.io/tx/0x10f52eadf477d85a439a9a7b3ce75c8aa55cec42aaad6a0b113236d8a236ee20) |

---

## Bursar earns its own revenue

It publishes a payout preflight to KeeperHub's marketplace, priced at $0.01 USDC
per call. Calling it returns a real x402 challenge:

```
402 Payment Required
  amount   10000                                        (USDC, 6dp — $0.01)
  asset    0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913    (USDC on Base)
  network  eip155:8453
  payTo    0x8d9abc5b07917229159886be02e5eed1dc7fbdc9    (the treasury)
```

What it sells is a problem agents have today: an agent about to send a payment
asks whether doing so would leave it below the gas it needs to keep operating.
Agents strand themselves this way routinely — after the payment, when the money
is already gone. Reading your own balance is easy; remembering to do it before
every spend is what nobody does.

Listing: `bursar-payout-preflight` ·
[workflow](https://app.keeperhub.com/workflows/y2if3cv7fi1lon9pgrwc4)

---

## Why it is not a wrapper

KeeperHub's MCP server exposes 44 tools whose definitions run to ~13k tokens,
and `list_action_schemas` answers with close to half a megabyte. Mounting it
into an agent swamps the context it was meant to inform.

So the MCP server is called **from code**, the traffic stays in the program, and
the agent sees seven treasury actions instead of 44 execution tools. `npm run
context-cost` measures the difference.

The policy engine runs eight ordered checks and denies by default: allowlist,
per-asset limits, per-transfer, rolling 24h, platform cap, unreconciled
movements, a cross-asset USD ceiling priced through Chainlink, and an approval
threshold above which the agent refuses to act alone.

---

## Reliability, proven rather than asserted

`npm run chaos -- --execute` kills the process at the two moments that actually
hurt a treasury:

| Scenario | Outcome |
| --- | --- |
| Crash **before** submit | reconcile completes the approved movement |
| Crash **after** submit | reconcile recovers the *original* transaction, no second transfer |

A real `409 Conflict` occurred during recording for a transfer that had already
succeeded. Bursar's refusal to guess is what prevented a double payment; the
movement was replayed under its original idempotency key and the original
transaction came back.

172 tests. Every parser is pinned against captured wire data rather than
invented fixtures.

---

## Run it

```bash
git clone https://github.com/nice-bills/bursar && cd bursar
npm install
npm run demo -- --execute     # the whole money loop
npm run aave                  # read the live Aave position
npm run listing -- --verify   # the listing's x402 challenge
npm run chaos -- --execute    # crash recovery
```

Run the demo twice. The second run pays nobody, because every movement is
idempotent by construction.

---

## Links

- Repo: https://github.com/nice-bills/bursar
- Evidence: [`evidence/aave-v3.md`](./evidence/aave-v3.md)
- Treasury: [`0x8d9abc5b…`](https://sepolia.etherscan.io/address/0x8d9abc5b07917229159886be02e5eed1dc7fbdc9)
