# Aave v3 — the live protocol, read and written

Every figure here was produced by running `npm run aave` against Aave v3 on
Sepolia through KeeperHub — none of them are invented or recomputed by hand.
[`aave-roundtrip.txt`](./aave-roundtrip.txt) collects console output from more
than one such run, under headers written for this document; it captures the
withdrawal round trip in full, not the three earlier balance reads tabulated
below.

- Treasury: [`0x8d9abc5b07917229159886be02e5eed1dc7fbdc9`](https://sepolia.etherscan.io/address/0x8d9abc5b07917229159886be02e5eed1dc7fbdc9)
- Aave v3 Pool: `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951`
- Asset: LINK `0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5`

## Why this is an integration and not a transfer

Supplying to a lending pool proves a transaction landed. It does not prove the
position exists, that it earns, or that the money can come back — and a treasury
that can only put money somewhere has not integrated with a protocol, it has
sent it away.

So Aave's own contract state is read through KeeperHub
(`aave-v3/get-user-account-data`, `aave-v3/get-user-reserve-data`) and that state
governs what happens next.

## The position is real, and it earns

Three reads of `currentATokenBalance`, minutes apart in one session:

| Read | aToken balance (LINK) | Collateral |
| --- | --- | --- |
| first | 5.165120505432263390 | $154.95 |
| second | 5.165395463617371347 | $154.96 |
| third | 5.165400046253789813 | $154.96 |

The balance rises between reads because `currentATokenBalance` is principal plus
accrued interest. Against the 5 LINK the ledger records as supplied, that is
**0.1654 LINK of real accrued interest**.

Aave's live supply rate was read at the same time and moved on its own between
reads — 234.30% → 234.37% (testnet rates are arbitrary; the conversion from ray
is the same one that governs mainnet).

These are **APRs**, not APYs. Aave's `liquidityRate` is the annualised linear
rate; compounding it would give a materially larger number at rates like these.
The figure is reported as the protocol reports it.

## The protocol's rate gates our spending

`yield.minAprBps` is checked against the rate read from Aave immediately before
depositing. Supplying into a collapsed rate spends real gas to earn nothing, and
the rate is knowable beforehand.

The read fails closed, in both of the ways it can fail: an unreadable reserve
refuses, and so does a readable position whose rate cannot be parsed. Not
knowing what Aave pays is not the same as Aave paying enough — and a floor of
`0`, which is the default, can never refuse on rate at all, so the gate is only
as real as the number configured.

```
deploy surplus? yes — Aave is paying 234.37%
```

(The line above comes from `npm run aave`, which reads the same
`yield.minAprBps` the plugin does.)

## The money comes back

`aave-v3/withdraw` closes the loop, so yield-earning funds return when the
treasury needs them instead of being one-way.

| Step | aToken balance (LINK) |
| --- | --- |
| before | 5.165400046253789813 |
| after withdrawing 0.1 | 5.065413794163045197 |
| after withdrawing the accrued yield | 5.000445359287327522 |

Principal intact, yield harvested.

Withdrawal receipt:
[`0xd96c8ee7187ddf833f6acb13f32e23fd92d09c6c5469a9e5c12c9b13590656fb`](https://sepolia.etherscan.io/tx/0xd96c8ee7187ddf833f6acb13f32e23fd92d09c6c5469a9e5c12c9b13590656fb)
— `success: true`, `reverted: false`.

Workflow on KeeperHub:
[`43f0vyjzczzi32xwa9860`](https://app.keeperhub.com/workflows/43f0vyjzczzi32xwa9860)

## Aave triggers the movement, not us

Everything above runs because Bursar decided to look. The rate keeper runs
because KeeperHub's scheduler fired, reads Aave's supply rate, and pulls the
position out if the protocol has stopped paying enough to justify leaving
capital there. The agent can be down and the treasury still reacts — which is
the only condition under which reacting matters, because a rate collapse does
not wait for the agent to come back up.

Both branches were exercised against the live rate:

| Floor | Aave's live rate | Gate | Result |
| --- | --- | --- | --- |
| 1.00% | 234.37% | `{"condition":false}` | nothing moved |
| 300.00% | 234.37% | fired | withdrew 0.01 LINK |

The withdrawal the keeper made on its own:
[`0x10f52eadf477d85a439a9a7b3ce75c8aa55cec42aaad6a0b113236d8a236ee20`](https://sepolia.etherscan.io/tx/0x10f52eadf477d85a439a9a7b3ce75c8aa55cec42aaad6a0b113236d8a236ee20)

The position moved 5.000445 → 4.990494 LINK, confirming it settled.

The floor was returned to 1.00% afterwards. The keeper is on an hourly
schedule, so leaving it above the live rate would have withdrawn 0.01 LINK
every hour.

Only the `true` branch reaches the withdraw node. A keeper wired without that
handle withdraws on every run regardless of the rate, which is worse than
having no keeper — it drains the position precisely when the rate is fine.
That edge is pinned in the tests.

## Two details that broke the parsers first

Recorded because they are the kind of thing a wrapper gets wrong and only
execution reveals:

1. The Aave read nodes nest their fields under `result`, alongside `success`
   and `addressLink`. Other nodes return fields at the top level.
2. Aave returns `type(uint256).max` as the health factor when an account has no
   debt. That is a different fact from "a very large number", and only one of
   the two can be compared against a threshold — so it is parsed to `null` and
   rendered as "no debt".

Both are pinned in [`test/aave.test.ts`](../test/aave.test.ts) against the
captured wire data.
