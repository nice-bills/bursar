# Aave v3 — the live protocol, read and written

Everything here was produced by running `npm run aave` against Aave v3 on
Sepolia through KeeperHub. Nothing is reconstructed. The raw console capture is
in [`aave-roundtrip.txt`](./aave-roundtrip.txt).

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

## The protocol's rate gates our spending

`yield.minApyBps` is checked against the rate read from Aave immediately before
depositing. Supplying into a collapsed rate spends real gas to earn nothing, and
the rate is knowable beforehand.

The read fails closed. Not knowing what Aave pays is not the same as Aave paying
enough.

```
deploy surplus? yes — Aave is paying 234.37%
```

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
