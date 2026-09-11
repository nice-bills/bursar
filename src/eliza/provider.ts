/**
 * Treasury provider.
 *
 * Providers are how an ElizaOS agent perceives state: their output is composed
 * into the prompt before the model reasons. That is the whole point of doing
 * this as a provider rather than only as actions — the agent does not have to
 * call a tool to discover it is broke, it simply knows, the same way it knows
 * the time.
 *
 * Two facts matter enough to always be present:
 *   - whether the treasury is locked by an unreconciled movement, so the agent
 *     stops promising payouts it cannot make;
 *   - what it has already paid out, so it stops re-promising settled work.
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";

import { BursarService } from "./service.js";
import { formatUnits, NATIVE_DECIMALS } from "../units.js";

export const treasuryProvider: Provider = {
  name: "TREASURY",
  description:
    "The agent's own treasury: configured revenue splits, recent payouts, and whether " +
    "any movement is unreconciled and therefore blocking further spending.",

  // NOT `dynamic`. That flag does not mean "recompute each time" — providers
  // are always called fresh. It means "only include when explicitly named",
  // and composeState filters on `!p.private && !p.dynamic`. Marking this
  // dynamic silently removed treasury state from the agent's context, which is
  // the whole point of the provider.

  async get(runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> {
    const service = runtime.getService<BursarService>(BursarService.serviceType) ?? undefined;
    if (!service) {
      return {
        text: "Treasury is not available: plugin-bursar is loaded but its service did not start.",
        values: { treasuryAvailable: false },
        data: {},
      };
    }

    try {
      const config = service.treasuryConfig;
      const open = await service.openIntents();

      const splits = config.contributors
        .map((c) => `${c.name} ${(c.shareBps / 100).toFixed(1)}%`)
        .join(", ");

      const perTransfer = formatUnits(
        BigInt(config.policy.maxPerTransfer),
        NATIVE_DECIMALS,
      );
      const perDay = formatUnits(BigInt(config.policy.maxPerDay), NATIVE_DECIMALS);

      const routing = service.payoutRouting();
      const lines = [
        `Treasury chain: ${config.treasury.chainId}.`,
        `Revenue splits: ${splits}.`,
        `Spending limits: ${perTransfer} per transfer, ${perDay} per rolling 24h.`,
        `Payouts settle on chain ${routing.chainId}` +
          (routing.privateMempool
            ? " with MEV-protected submission."
            : " without private routing on this chain."),
      ];

      if (open.length > 0) {
        // Stated plainly and early: this is the single most important thing for
        // the agent to know, because every new movement will be refused.
        lines.push(
          `TREASURY LOCKED: ${open.length} movement(s) unreconciled. ` +
            `No further value can move until reconciliation runs. ` +
            `Do not promise or attempt payouts until then.`,
        );
      } else {
        lines.push("All movements reconciled; the treasury can transact.");
      }

      return {
        text: lines.join(" "),
        values: {
          treasuryAvailable: true,
          treasuryLocked: open.length > 0,
          openIntentCount: open.length,
          treasuryChainId: config.treasury.chainId,
        },
        data: {
          contributors: config.contributors,
          openIntents: open.map((e) => ({
            intentId: e.intentId,
            leg: e.leg,
            amount: e.amount,
            to: e.to,
            status: e.status,
          })),
        },
      };
    } catch (error) {
      // A provider that throws would poison every message. Degrade instead, and
      // say so in terms the agent can act on.
      return {
        text:
          `Treasury state could not be read (${error instanceof Error ? error.message : String(error)}). ` +
          `Treat the treasury as unavailable and do not promise payouts.`,
        values: { treasuryAvailable: false, treasuryLocked: true },
        data: {},
      };
    }
  },
};
