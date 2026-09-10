/**
 * plugin-bursar — an onchain treasury for ElizaOS agents, executed by KeeperHub.
 *
 * Mount it in a character's plugin list and the agent gains:
 *   - a TREASURY provider, so it perceives its own solvency while reasoning;
 *   - actions to distribute revenue, reconcile, and account for it;
 *   - a policy layer that refuses movements the agent talked itself into.
 */

import type { Plugin } from "@elizaos/core";

import { treasuryActions } from "./eliza/actions.js";
import { treasuryProvider } from "./eliza/provider.js";
import { BursarService } from "./eliza/service.js";

export const bursarPlugin: Plugin = {
  name: "bursar",
  description:
    "Gives the agent an onchain treasury: revenue splits, gas float, and reconciliation, " +
    "with every movement executed and audited through KeeperHub.",

  config: {
    KEEPERHUB_API_KEY: process.env.KEEPERHUB_API_KEY ?? null,
    KEEPERHUB_BASE_URL: process.env.KEEPERHUB_BASE_URL ?? null,
    BURSAR_CONFIG_PATH: process.env.BURSAR_CONFIG_PATH ?? null,
    BURSAR_LEDGER_PATH: process.env.BURSAR_LEDGER_PATH ?? null,
  },

  services: [BursarService],
  providers: [treasuryProvider],
  actions: treasuryActions,

  async init(config: Record<string, string>): Promise<void> {
    // Fail at load time, not at the first payout. An agent that starts happily
    // and only reveals a missing key when someone asks to be paid is worse than
    // one that refuses to start.
    if (!config.KEEPERHUB_API_KEY && !process.env.KEEPERHUB_API_KEY) {
      throw new Error(
        "plugin-bursar requires KEEPERHUB_API_KEY. Add it to the character's secrets " +
          "or the environment. Get one at app.keeperhub.com under API Keys.",
      );
    }
  },
};

export default bursarPlugin;

export { BursarService } from "./eliza/service.js";
export { treasuryProvider } from "./eliza/provider.js";
export { treasuryActions } from "./eliza/actions.js";

// The treasury engine is exported too, so it can be driven from a script or a
// test without standing up an agent runtime.
export { Executor } from "./treasury/executor.js";
export { PolicyEngine, type Movement, type Decision } from "./policy/engine.js";
export { Ledger, type LedgerEntry } from "./ledger/store.js";
export { KeeperHubClient, KeeperHubError } from "./keeperhub/client.js";
export { loadConfig, splitByShares, type BursarConfig } from "./config.js";
export { formatUnits, parseUnits, NATIVE_DECIMALS } from "./units.js";
