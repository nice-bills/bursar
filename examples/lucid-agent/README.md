# counterparty-oracle

A real Lucid Agent, built from Daydreams' own SDK, so Bursar's connector has
something genuine to discover and pay.

```bash
npm install
npm start          # http://localhost:4021
```

Two entrypoints: `health` is free, `counterparty-check` is priced at $0.01 USDC
on Base Sepolia and answers with an x402 challenge until paid.

Three optional environment variables, all with working defaults:

```bash
LUCID_PAY_TO=0x...        # who the invoice is payable to; defaults to the treasury
LUCID_PORT=4021           # the port it listens on
LUCID_FACILITATOR_URL=https://x402.org/facilitator
```

Then, from the repo root:

```bash
npm run lucid
```

See [`evidence/lucid-agents.md`](../../evidence/lucid-agents.md) for what that
run shows and the three undocumented card details it uncovered.
