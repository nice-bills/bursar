import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  readAccountData,
  readReserveData,
  rayToBps,
  formatRate,
  formatHealthFactor,
  accruedInterest,
  shouldDeploy,
  aaveWithdrawWorkflow,
  aaveReserveDataWorkflow,
  aaveRateKeeperWorkflow,
} from "../src/yield/aave.js";

/**
 * Captured from a real execution against Aave v3 on Sepolia, not invented.
 * The shape matters as much as the values: the read nodes nest their fields
 * under `result`, which is how the first version of the parser failed.
 */
const ACCOUNT_OUTPUT = {
  result: {
    ltv: "7000",
    healthFactor:
      "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    totalDebtBase: "0",
    totalCollateralBase: "15495361516",
    availableBorrowsBase: "10846753061",
    currentLiquidationThreshold: "7500",
  },
  success: true,
  addressLink: "https://sepolia.etherscan.io/address/0x8d9a",
};

const RESERVE_OUTPUT = {
  result: {
    liquidityRate: "2343085982982455170535563143",
    stableBorrowRate: "0",
    scaledVariableDebt: "0",
    principalStableDebt: "0",
    currentATokenBalance: "5165120505432263390",
    stableRateLastUpdated: "0",
    usageAsCollateralEnabled: true,
    currentStableDebtTokenBalance: "0",
    currentVariableDebtTokenBalance: "0",
  },
  success: true,
};

describe("reading Aave's account data", () => {
  test("parses a live reading nested under result", () => {
    const account = readAccountData(ACCOUNT_OUTPUT);
    assert.ok(account);
    assert.equal(account.totalCollateralBase, 15_495_361_516n); // $154.95 at 8dp
    assert.equal(account.totalDebtBase, 0n);
    assert.equal(account.ltv, 7000n);
    assert.equal(account.currentLiquidationThreshold, 7500n);
  });

  test("max-uint256 health factor reads as no debt, not as a number", () => {
    // Aave returns type(uint256).max when nothing is borrowed. Carrying that
    // around as a health factor puts 1.1e59 in front of a person deciding
    // whether to act, and compares true against every threshold.
    const account = readAccountData(ACCOUNT_OUTPUT);
    assert.equal(account?.healthFactorWad, null);
    assert.equal(formatHealthFactor(null), "no debt");
  });

  test("a real health factor is kept", () => {
    const account = readAccountData({
      result: { totalCollateralBase: "100", totalDebtBase: "50", healthFactor: "1500000000000000000" },
    });
    assert.equal(account?.healthFactorWad, 1_500_000_000_000_000_000n);
    assert.equal(formatHealthFactor(account!.healthFactorWad), "1.50");
  });

  test("a top-level reading parses too", () => {
    const account = readAccountData({ totalCollateralBase: "1", totalDebtBase: "0" });
    assert.ok(account);
    assert.equal(account.totalCollateralBase, 1n);
  });

  test("a reading missing its core fields returns nothing rather than zeros", () => {
    // Zero collateral and zero debt is a meaningful position. Inventing it from
    // an unreadable response would report a healthy empty account when the
    // truth is that we do not know.
    assert.equal(readAccountData({ result: { ltv: "7000" } }), null);
    assert.equal(readAccountData(null), null);
    assert.equal(readAccountData("nope"), null);
  });
});

describe("reading an Aave position", () => {
  test("parses the supplied balance and live rate", () => {
    const reserve = readReserveData(RESERVE_OUTPUT);
    assert.ok(reserve);
    assert.equal(reserve.currentATokenBalance, 5_165_120_505_432_263_390n);
    assert.equal(reserve.liquidityRateRay, 2_343_085_982_982_455_170_535_563_143n);
    assert.equal(reserve.usageAsCollateralEnabled, true);
    assert.equal(reserve.currentVariableDebtTokenBalance, 0n);
  });

  test("an unreadable position is not a zero position", () => {
    assert.equal(readReserveData({ result: { liquidityRate: "1" } }), null);
    assert.equal(readReserveData(null), null);
  });
});

describe("rate arithmetic", () => {
  test("converts ray to basis points, rounding down", () => {
    // The captured rate is ~234.31% — a testnet number, but the conversion is
    // the same one that governs mainnet.
    assert.equal(rayToBps(2_343_085_982_982_455_170_535_563_143n), 23_430n);
    assert.equal(formatRate(2_343_085_982_982_455_170_535_563_143n), "234.30%");
  });

  test("a whole-percent rate converts exactly", () => {
    // 5% APY in ray.
    assert.equal(rayToBps(5n * 10n ** 25n), 500n);
    assert.equal(formatRate(5n * 10n ** 25n), "5.00%");
  });

  test("rounds down rather than up, so a gate is never cleared by rounding", () => {
    // Just under one basis point must read as zero, not one.
    assert.equal(rayToBps(10n ** 23n - 1n), 0n);
    assert.equal(rayToBps(10n ** 23n), 1n);
  });

  test("a zero rate is zero", () => {
    assert.equal(rayToBps(0n), 0n);
    assert.equal(formatRate(0n), "0.00%");
  });
});

describe("letting Aave's rate decide whether to deploy", () => {
  const reserve = readReserveData(RESERVE_OUTPUT)!;

  test("deploys when the protocol is paying above the floor", () => {
    const decision = shouldDeploy(reserve, 50n);
    assert.equal(decision.deploy, true);
    assert.match(decision.reason, /234\.30%/);
  });

  test("declines when the rate has collapsed below the floor", () => {
    const flat = { ...reserve, liquidityRateRay: 10n ** 24n }; // 0.10%
    const decision = shouldDeploy(flat, 50n);
    assert.equal(decision.deploy, false);
    assert.match(decision.reason, /below the 0\.50% floor/);
  });

  test("a rate exactly at the floor clears it", () => {
    const atFloor = { ...reserve, liquidityRateRay: 50n * 10n ** 23n }; // 0.50%
    assert.equal(shouldDeploy(atFloor, 50n).deploy, true);
  });

  test("fails closed when the rate cannot be read at all", () => {
    // Not knowing what Aave pays is not the same as Aave paying enough.
    const decision = shouldDeploy(null, 50n);
    assert.equal(decision.deploy, false);
    assert.match(decision.reason, /could not be read/);
  });
});

describe("accrued interest", () => {
  test("is the aToken balance above what was supplied", () => {
    const reserve = readReserveData(RESERVE_OUTPUT)!;
    const principal = 5_000_000_000_000_000_000n; // 5 LINK supplied
    assert.deepEqual(accruedInterest(reserve, principal), {
      interest: 165_120_505_432_263_390n,
      principalIsStale: false,
    });
  });

  test("never reports a loss that cannot happen, and says the principal is stale", () => {
    // aToken balances do not shrink on their own. A negative here means the
    // principal figure is wrong — most likely an unaccounted withdrawal — and
    // inventing a loss would be worse than reporting nothing earned. But
    // reporting a flat zero hid the staleness, so the caller is now told.
    const reserve = readReserveData(RESERVE_OUTPUT)!;
    assert.deepEqual(accruedInterest(reserve, 9n * 10n ** 18n), {
      interest: 0n,
      principalIsStale: true,
    });
  });

  test("an exactly-matching principal is not stale", () => {
    const reserve = readReserveData(RESERVE_OUTPUT)!;
    assert.deepEqual(accruedInterest(reserve, reserve.currentATokenBalance), {
      interest: 0n,
      principalIsStale: false,
    });
  });
});

describe("the workflows sent to KeeperHub", () => {
  test("the withdraw names Aave's own action and the asset", () => {
    const workflow = aaveWithdrawWorkflow(
      11155111,
      "0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5",
      "1000000000000000000",
      "0x8d9abc5b07917229159886be02e5eed1dc7fbdc9",
      "LINK",
    );
    const node = workflow.nodes.find((n) => n.id === "withdraw");
    assert.equal(node?.data.config.actionType, "aave-v3/withdraw");
    assert.equal(node?.data.config.amount, "1000000000000000000");
    assert.equal(node?.data.config.network, "11155111");
  });

  test("the rate keeper only withdraws on the true branch", () => {
    // The edge that matters. Without the handle, a keeper withdraws on every
    // run regardless of the rate — which is worse than having no keeper,
    // because it drains the position precisely when the rate is fine.
    const workflow = aaveRateKeeperWorkflow(
      11155111,
      "0xasset",
      `0x${"1".repeat(40)}`,
      "LINK",
      10n ** 25n,
      "10000000000000000",
    );
    const edge = workflow.edges.find((e) => e.target === "withdraw");
    assert.equal(edge?.sourceHandle, "true");
    assert.equal(edge?.source, "gate");
  });

  test("the keeper gates on the nested rate field and compares in ray", () => {
    // Two things this pins: the read node nests under `result`, and the
    // comparison stays in ray. Converting to a percentage first would round
    // away the boundary the whole decision turns on.
    const floor = 10n ** 25n; // 1%
    const workflow = aaveRateKeeperWorkflow(
      11155111,
      "0xasset",
      `0x${"1".repeat(40)}`,
      "LINK",
      floor,
      "1",
    );
    const condition = String(workflow.nodes.find((n) => n.id === "gate")?.data.config.condition);
    assert.match(condition, /result\.liquidityRate/);
    assert.ok(condition.includes(floor.toString()), "the floor must be compared in ray");
  });

  test("the keeper runs on KeeperHub's schedule, not the agent's", () => {
    // The point of the keeper is that it reacts while the agent is down, and a
    // rate collapse does not wait for the agent to come back up.
    const workflow = aaveRateKeeperWorkflow(
      11155111,
      "0xasset",
      `0x${"1".repeat(40)}`,
      "LINK",
      10n ** 25n,
      "1",
    );
    const trigger = workflow.nodes.find((n) => n.type === "trigger");
    assert.equal(trigger?.data.config.triggerType, "Schedule");
  });

  test("position reads for different holders get different workflow names", () => {
    // Workflows are upserted by name, so two holders sharing one name would
    // mean each read silently overwrote the other's.
    const a = aaveReserveDataWorkflow(11155111, "0xasset", `0x${"1".repeat(40)}`, "LINK");
    const b = aaveReserveDataWorkflow(11155111, "0xasset", `0x${"2".repeat(40)}`, "LINK");
    assert.notEqual(a.name, b.name);
  });
});
