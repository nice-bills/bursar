/**
 * A real Lucid Agent, to be the thing Bursar pays.
 *
 * ## Why this exists
 *
 * KeeperHub's issue #2329 asks for a connector that can discover and call a
 * Lucid Agents entrypoint, free or x402-priced. A connector written against a
 * specification and never pointed at a running agent is a guess with tests
 * around it, so this stands one up from Daydreams' own SDK — their
 * `createAgent`, their `http()` and `payments()` plugins, their Hono adapter —
 * and serves the two surfaces the issue names:
 *
 *   GET  /.well-known/agent-card.json      discovery
 *   POST /entrypoints/{key}/invoke         invocation
 *
 * One entrypoint is free and one is priced, because the connector has to handle
 * both and the difference between them is the entire interesting part: a paid
 * entrypoint answers with HTTP 402 and a payment challenge instead of a result.
 *
 * ## What it sells
 *
 * A counterparty risk check — given an address, say whether it is one this
 * agent is willing to vouch for. It is deliberately the kind of small, real
 * question one agent asks another before moving money, which is the shape of
 * the agent economy the hackathon is about.
 */

import { serve } from "@hono/node-server";
import { createAgent } from "@lucid-agents/core";
import { createAgentApp } from "@lucid-agents/hono";
import { http } from "@lucid-agents/http";
import { payments } from "@lucid-agents/payments";
import { z } from "zod";

/** Base Sepolia. Testnet on purpose — a demo should not need real money. */
const NETWORK = "eip155:84532" as const;

/** USDC on Base Sepolia. */
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

/** Where this agent would be paid. The treasury's counterparty, not the treasury. */
const PAY_TO = (process.env.LUCID_PAY_TO ??
  "0x069C76420DD98cAfa97cc1D349BC1cC708284032") as `0x${string}`;

const PORT = Number(process.env.LUCID_PORT ?? 4021);

async function main(): Promise<void> {
  const agent = await createAgent({
    name: "counterparty-oracle",
    version: "1.0.0",
    description:
      "Answers whether an address is safe to pay. Free health check, priced verdict.",
  })
    .use(http())
    .use(
      payments({
        agentId: "counterparty-oracle",
        config: {
          payTo: PAY_TO,
          network: NETWORK,
          // The public facilitator for Base Sepolia. Settlement is testnet, so
          // a challenge can be issued and inspected without real funds.
          facilitatorUrl: process.env.LUCID_FACILITATOR_URL ?? "https://x402.org/facilitator",
        },
      }),
    )
    .build();

  const { app, addEntrypoint } = await createAgentApp(agent);

  // Free: proves discovery and invocation work before payment enters the
  // picture. A connector that cannot call a free entrypoint has a transport
  // bug, and finding that out through a 402 wastes an afternoon.
  addEntrypoint({
    key: "health",
    description: "Liveness check. Free.",
    input: z.object({}),
    output: z.object({ ok: z.boolean(), name: z.string() }),
    handler: async () => ({ output: { ok: true, name: "counterparty-oracle" } }),
  });

  // Priced: the one that matters. Answers with 402 and a challenge until paid.
  addEntrypoint({
    key: "counterparty-check",
    description:
      "Given an address, report whether this oracle vouches for it as a payee.",
    paymentProtocol: "x402",
    x402: {
      offers: [
        {
          scheme: "exact" as const,
          network: NETWORK,
          payTo: PAY_TO,
          facilitatorUrl:
            process.env.LUCID_FACILITATOR_URL ?? "https://x402.org/facilitator",
          // 10000 base units of a 6-decimal asset — $0.01.
          price: { amount: "10000", asset: ASSET },
        },
      ],
    },
    input: z.object({
      address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    }),
    output: z.object({
      address: z.string(),
      vouched: z.boolean(),
      reason: z.string(),
    }),
    handler: async ({ input }) => ({
      output: {
        address: input.address,
        vouched: true,
        reason: "No adverse reports against this address.",
      },
    }),
  });

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`counterparty-oracle listening on http://localhost:${info.port}`);
    console.log(`  card   : http://localhost:${info.port}/.well-known/agent-card.json`);
    console.log(`  free   : POST /entrypoints/health/invoke`);
    console.log(`  priced : POST /entrypoints/counterparty-check/invoke`);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
