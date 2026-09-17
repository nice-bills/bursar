/**
 * Read Bursar's Aave v3 position from the protocol itself.
 *
 *   npm run aave              # read account health, the position, and the live rate
 *   npm run aave -- --withdraw 1000000000000000000   # pull 1 unit back out
 *
 * This is the half of the integration that was missing. Supplying to Aave is a
 * push — it proves a transaction landed, not that the position exists, earns,
 * or can be unwound. Everything here reads Aave's own contract state through
 * KeeperHub and reports what the protocol actually says.
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";

import { assetPolicyFor, loadConfig } from "../src/config.js";
import { KeeperHubClient, KeeperHubError } from "../src/keeperhub/client.js";
import { Ledger } from "../src/ledger/store.js";
import { formatUnits } from "../src/units.js";
import {
  aaveAccountDataWorkflow,
  aaveReserveDataWorkflow,
  aaveWithdrawWorkflow,
  aaveRateKeeperWorkflow,
  readAccountData,
  readReserveData,
  accruedInterest,
  shouldDeploy,
  formatRate,
  formatHealthFactor,
  rayToBps,
} from "../src/yield/aave.js";
import type { WorkflowDefinition } from "../src/treasury/workflows.js";

/**
 * Validate flags before anything is authored or executed.
 *
 * These used to be checked deep in `main`, after two workflows had already been
 * created and run — so a mistyped amount failed after side effects rather than
 * at the point the operator could still fix it.
 */
function baseUnits(flag: string, raw: string | undefined): string {
  if (!raw || !/^\d+$/.test(raw)) {
    console.error(
      `${flag} needs an amount in base units — whole digits only, no decimal point.\n` +
        `  Got: ${raw ?? "nothing"}. For 0.1 LINK (18 decimals) that is 100000000000000000.`,
    );
    process.exit(1);
  }
  return raw;
}

const withdrawIndex = process.argv.indexOf("--withdraw");
const WITHDRAW =
  withdrawIndex >= 0 ? baseUnits("--withdraw", process.argv[withdrawIndex + 1]) : null;

/**
 * Author the rate keeper and run it once.
 *
 * `--keeper <floorBps> <amountBaseUnits>` — the floor is what makes this
 * demonstrable in both directions: set it under Aave's current rate and the
 * gate must hold, set it over and the keeper must pull the position out.
 */
const keeperIndex = process.argv.indexOf("--keeper");
const KEEPER = keeperIndex >= 0
  ? {
      floorBps: baseUnits("--keeper <floorBps>", process.argv[keeperIndex + 1]),
      amount: baseUnits("--keeper <floorBps> <amount>", process.argv[keeperIndex + 2]),
    }
  : null;

/**
 * Floor below which supplying is not worth the gas.
 *
 * Read from the config inside `main`, so this script gates on the same number
 * the plugin does. A hardcoded 50 here meant the captured output demonstrated a
 * threshold that `yield.minApyBps` was not actually set to.
 */

async function runWorkflow(
  client: KeeperHubClient,
  workflow: WorkflowDefinition,
  known: Map<string, string>,
): Promise<unknown> {
  const existing = known.get(workflow.name);
  let id: string;
  if (existing) {
    await client.updateWorkflow(existing, workflow, `wf-${randomUUID()}`);
    id = existing;
  } else {
    const created = (await client.createWorkflow(workflow, `wf-${randomUUID()}`)) as {
      id?: string;
    };
    id = created?.id ?? "";
  }
  if (!id) throw new Error(`No workflow id for ${workflow.name}`);

  const run = await client.executeWorkflow(id, {}, `run-${randomUUID()}`);
  const final = await client.awaitExecution(run.executionId);
  if (final.status !== "success") {
    const error = (final.raw as { error?: string })?.error;
    throw new Error(`${workflow.name} finished ${final.status}${error ? `: ${error}` : ""}`);
  }
  for (const link of final.transactionLinks) console.log(`  tx: ${link}`);
  return final.output;
}

async function main(): Promise<void> {
  const apiKey = process.env.KEEPERHUB_API_KEY;
  if (!apiKey) throw new Error("KEEPERHUB_API_KEY is not set.");

  const config = await loadConfig(process.env.BURSAR_CONFIG_PATH ?? "bursar.config.json");
  if (!config.yield?.enabled) {
    console.log("Yield is not enabled in the config — nothing to read.");
    return;
  }

  const { chainId, asset, poolAddress } = config.yield;
  const MIN_APY_BPS = BigInt(config.yield.minAprBps);

  // Every read below is scoped to a holder, so without one there is nothing to
  // ask Aave about. The address is optional in config because it can fall back
  // to the org's signer, but that fallback belongs to the execution path, not
  // to a reporting script that would otherwise print another account's position.
  const user = config.treasury.address;
  if (!user) {
    throw new Error(
      "No treasury.address configured. Aave positions are per-account, so set it " +
        "to the wallet whose position you want to read.",
    );
  }
  const symbol = assetPolicyFor(config.policy, asset)?.symbol ?? "asset";
  const decimals = assetPolicyFor(config.policy, asset)?.decimals ?? 18;

  const client = new KeeperHubClient({ apiKey, baseUrl: process.env.KEEPERHUB_BASE_URL });
  const rows = ((await client.listWorkflows()) ?? []) as Array<{ id: string; name: string }>;
  const known = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.name, r.id]));

  console.log(`Aave v3 on chain ${chainId}`);
  console.log(`  pool : ${poolAddress}`);
  console.log(`  user : ${user}`);
  console.log(`  asset: ${symbol} ${asset}\n`);

  // --- what the protocol says about the account -----------------------------
  console.log("Reading account health from Aave...");
  const accountOutput = await runWorkflow(
    client,
    aaveAccountDataWorkflow(chainId, user),
    known,
  );
  const account = readAccountData(accountOutput);
  if (!account) {
    console.log(`  could not parse: ${JSON.stringify(accountOutput)?.slice(0, 300)}`);
  } else {
    // Base currency is USD at 8 decimals on every v3 market.
    const usd = (v: bigint): string => `$${(Number(v) / 1e8).toFixed(2)}`;
    console.log(`  collateral     : ${usd(account.totalCollateralBase)}`);
    console.log(`  debt           : ${usd(account.totalDebtBase)}`);
    console.log(`  borrowing power: ${usd(account.availableBorrowsBase)}`);
    console.log(`  health factor  : ${formatHealthFactor(account.healthFactorWad)}`);
    console.log(`  LTV            : ${Number(account.ltv) / 100}%`);
  }

  // --- what the protocol says about this position ---------------------------
  console.log(`\nReading the ${symbol} position from Aave...`);
  const reserveOutput = await runWorkflow(
    client,
    aaveReserveDataWorkflow(chainId, asset, user, symbol),
    known,
  );
  const reserve = readReserveData(reserveOutput);
  if (!reserve) {
    console.log(`  could not parse: ${JSON.stringify(reserveOutput)?.slice(0, 300)}`);
  } else {
    console.log(
      `  supplied  : ${formatUnits(reserve.currentATokenBalance, decimals)} ${symbol} (aToken)`,
    );
    console.log(`  debt      : ${formatUnits(reserve.currentVariableDebtTokenBalance, decimals)} ${symbol}`);
    const rateRay = reserve.liquidityRateRay;
    console.log(
      rateRay === undefined
        ? `  supply APR: unreadable — the gate will refuse to supply`
        : `  supply APR: ${formatRate(rateRay)} (${rayToBps(rateRay)} bps)`,
    );
    console.log(`  collateral: ${reserve.usageAsCollateralEnabled ? "enabled" : "disabled"}`);

    // Interest earned, measured against what the ledger says we put in.
    const ledger = new Ledger(process.env.BURSAR_LEDGER_PATH ?? "data/ledger.jsonl");
    // The service holds this lock for its whole life; a script writing the
    // same file has to take it too, or the two interleave appends and each
    // reads the caps before the other writes.
    await ledger.acquire();
    // Release on every exit path. A lock left behind by a crashed script is
    // taken over as stale eventually, but not before it has refused a run.
    const releaseLock = () => void ledger.release();
    process.once("exit", releaseLock);
    process.once("SIGINT", () => {
      releaseLock();
      process.exit(130);
    });
    // Latest row per intent, not every row: two confirmed rows for one intent
    // would otherwise count the same supply twice. This is what every
    // aggregate on the Ledger itself does.
    let principal = 0n;
    for (const entry of (await ledger.latestByIntent()).values()) {
      if (entry.leg !== "yield" || entry.status !== "confirmed") continue;
      if (entry.token?.toLowerCase() !== asset.toLowerCase()) continue;
      principal += BigInt(entry.amount);
    }
    if (principal > 0n) {
      const earned = accruedInterest(reserve, principal);
      console.log(`\n  supplied by Bursar: ${formatUnits(principal, decimals)} ${symbol}`);
      if (earned.principalIsStale) {
        // Withdrawals do not write ledger movements, so the recorded principal
        // is what went IN, not what is still there.
        console.log(
          `  accrued interest  : not derivable — the position (` +
            `${formatUnits(reserve.currentATokenBalance, decimals)} ${symbol}) is below the ` +
            `${formatUnits(principal, decimals)} ${symbol} supplied, so something has been ` +
            `withdrawn since.`,
        );
      } else {
        console.log(`  accrued interest  : ${formatUnits(earned.interest, decimals)} ${symbol}`);
      }
    }

    // The gate that now governs deployment.
    const decision = shouldDeploy(reserve, MIN_APY_BPS);
    console.log(
      `\n  deploy surplus? ${decision.deploy ? "yes" : "no"} — ${decision.reason}`,
    );
  }

  // --- the leg Aave drives on its own ---------------------------------------
  if (KEEPER) {
    const { floorBps, amount } = KEEPER;
    if (!floorBps || !/^\d+$/.test(floorBps) || !amount || !/^\d+$/.test(amount)) {
      throw new Error("--keeper wants <floorBps> <amountBaseUnits>, both as digits");
    }
    // Basis points back to ray, the scale Aave reports rates in.
    const floorRay = BigInt(floorBps) * 10n ** 23n;

    const workflow = aaveRateKeeperWorkflow(
      chainId,
      asset,
      user,
      symbol,
      floorRay,
      amount,
    );
    console.log(`\nAuthoring the rate keeper — floor ${formatRate(floorRay)}...`);
    const output = await runWorkflow(client, workflow, known);

    // Whether the gate held is the whole result. A keeper that withdrew when
    // the rate was fine would be worse than no keeper.
    const text = JSON.stringify(output) ?? "";
    const hash = text.match(/"transactionHash":"(0x[0-9a-fA-F]{64})"/)?.[1];
    if (hash) {
      console.log(`  the rate was below the floor — the keeper withdrew, with no agent involved`);
      console.log(`  tx: https://sepolia.etherscan.io/tx/${hash}`);
    } else {
      console.log(`  the rate cleared the floor — the gate held and nothing moved`);
      console.log(`  output: ${text.slice(0, 260)}`);
    }
  }

  // --- the return leg -------------------------------------------------------
  if (WITHDRAW) {
    if (!/^\d+$/.test(WITHDRAW)) {
      throw new Error(`--withdraw wants base units as digits, got ${JSON.stringify(WITHDRAW)}`);
    }
    console.log(`\nWithdrawing ${formatUnits(BigInt(WITHDRAW), decimals)} ${symbol} from Aave...`);
    const output = await runWorkflow(
      client,
      aaveWithdrawWorkflow(chainId, asset, WITHDRAW, user, symbol),
      known,
    );
    // The withdraw node reports its receipt in the output rather than in the
    // execution's transactionHashes, so read it from there — a withdrawal
    // without a verifiable hash is a claim, not proof.
    const o = (output ?? {}) as Record<string, unknown>;
    const call = (o.executedCall ?? {}) as Record<string, unknown>;
    const hash =
      (typeof o.transactionHash === "string" && o.transactionHash) ||
      (typeof call.transactionHash === "string" && call.transactionHash) ||
      null;
    console.log(`  success : ${o.success === true ? "yes" : String(o.success)}`);
    console.log(`  reverted: ${String(call.reverted)}`);
    if (hash) console.log(`  tx      : https://sepolia.etherscan.io/tx/${hash}`);
    else console.log(`  raw     : ${JSON.stringify(output)?.slice(0, 400)}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof KeeperHubError) {
    console.error(`\n✗ ${error.message}\n  ${JSON.stringify(error.body, null, 2)}`);
  } else {
    console.error(`\n✗ ${error instanceof Error ? error.stack : String(error)}`);
  }
  process.exit(1);
});
