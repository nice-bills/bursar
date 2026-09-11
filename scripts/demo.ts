/**
 * The demo: an ElizaOS agent paying its contributors, onchain, through KeeperHub.
 *
 * This drives the exact plugin surfaces a live agent uses — the service the
 * runtime starts, the provider that shapes what the agent perceives, and the
 * actions the model selects — and prints a transaction link for every payout.
 *
 *   npm run demo              # dry: shows perception and policy, moves nothing
 *   npm run demo -- --execute # real payouts on the configured chain
 */

import "dotenv/config";

import bursarPlugin, { BursarService } from "../src/index.js";
import { payContributorsAction, sweepEarningsAction, deployYieldAction, checkFloatAction, reconcileTreasuryAction, treasuryReportAction } from "../src/eliza/actions.js";
import { treasuryProvider } from "../src/eliza/provider.js";
import { createStandaloneRuntime, userMessage, emptyState } from "../src/eliza/standalone.js";
import { formatUnits, NATIVE_DECIMALS } from "../src/units.js";

const EXECUTE = process.argv.includes("--execute");
const REVENUE = process.env.BURSAR_DEMO_REVENUE ?? "3000000000000"; // 0.000003 ETH

async function main(): Promise<void> {
  const { runtime, startService, stopAll } = createStandaloneRuntime({
    settings: {
      KEEPERHUB_API_KEY: process.env.KEEPERHUB_API_KEY,
      KEEPERHUB_BASE_URL: process.env.KEEPERHUB_BASE_URL,
      BURSAR_CONFIG_PATH: process.env.BURSAR_CONFIG_PATH ?? "bursar.config.json",
      BURSAR_LEDGER_PATH: process.env.BURSAR_LEDGER_PATH ?? "data/ledger.jsonl",
    },
  });

  banner("1. Loading plugin-bursar into the runtime");
  await bursarPlugin.init?.({} as Record<string, string>, runtime);
  const service = await startService(BursarService);
  console.log(`   plugin: ${bursarPlugin.name}`);
  console.log(`   service: ${BursarService.serviceType} — ${service.capabilityDescription}`);
  console.log(`   actions: ${bursarPlugin.actions?.map((a) => a.name).join(", ")}`);
  console.log(`   providers: ${bursarPlugin.providers?.map((p) => p.name).join(", ")}`);

  // --- What the agent perceives -------------------------------------------
  // This is the part a generic tool integration cannot do: treasury state is
  // in the prompt before the model reasons, not behind a function call.
  banner("2. What the agent knows before it reasons (TREASURY provider)");
  const perception = await treasuryProvider.get(runtime, userMessage("status?"), emptyState());
  console.log(`   ${perception.text}`);
  console.log(`   values: ${JSON.stringify(perception.values)}`);

  // --- Action gating -------------------------------------------------------
  banner("3. Action gating (validate)");
  const vague = userMessage("pay everyone what we owe them");
  const precise = userMessage(`pay out ${formatUnits(BigInt(REVENUE), NATIVE_DECIMALS)}`);
  console.log(`   "pay everyone what we owe them" -> ${await payContributorsAction.validate(runtime, vague)}`);
  console.log(`   "${precise.content.text}" -> ${await payContributorsAction.validate(runtime, precise)}`);
  console.log("   (an action that cannot succeed is never offered to the model)");

  if (!EXECUTE) {
    banner("Dry run complete");
    console.log("   Nothing moved. Re-run with --execute to pay contributors for real.");
    await stopAll();
    return;
  }

  // --- Real money ----------------------------------------------------------
  banner(`4. PAY_CONTRIBUTORS — distributing ${formatUnits(BigInt(REVENUE), NATIVE_DECIMALS)} onchain`);
  const result = await payContributorsAction.handler(
    runtime,
    precise,
    emptyState(),
    undefined,
    async (content) => {
      for (const line of String(content.text ?? "").split("\n")) console.log(`   ${line}`);
      return [];
    },
  );
  console.log(`\n   success: ${(result as { success?: boolean })?.success}`);

  // --- Accounting ----------------------------------------------------------
  banner("5. SWEEP_EARNINGS — consolidating token earnings into the treasury");
  await sweepEarningsAction.handler(runtime, userMessage("collect what we earned"), emptyState(), undefined, async (content) => {
    for (const line of String(content.text ?? "").split("\n")) console.log(`   ${line}`);
    return [];
  });

  banner("6. DEPLOY_SURPLUS — supplying surplus above the buffer to Aave v3");
  await deployYieldAction.handler(runtime, userMessage("put the idle funds to work"), emptyState(), undefined, async (content) => {
    for (const line of String(content.text ?? "").split("\n")) console.log(`   ${line}`);
    return [];
  });

  banner("7. CHECK_GAS_FLOAT — installing the gas keeper that runs without the agent");
  await checkFloatAction.handler(runtime, userMessage("are you low on gas?"), emptyState(), undefined, async (content) => {
    for (const line of String(content.text ?? "").split("\n")) console.log(`   ${line}`);
    return [];
  });

  banner("8. TREASURY_REPORT — where the money went");
  await treasuryReportAction.handler(runtime, userMessage("where did the money go?"), emptyState(), undefined, async (content) => {
    for (const line of String(content.text ?? "").split("\n")) console.log(`   ${line}`);
    return [];
  });

  banner("9. RECONCILE_TREASURY — proving the ledger agrees with the chain");
  await reconcileTreasuryAction.handler(runtime, userMessage("did those go through?"), emptyState(), undefined, async (content) => {
    for (const line of String(content.text ?? "").split("\n")) console.log(`   ${line}`);
    return [];
  });

  await stopAll();
}

function banner(title: string): void {
  console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
