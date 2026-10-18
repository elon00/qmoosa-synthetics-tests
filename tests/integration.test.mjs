import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateDebtSharesToMint,
  calculateUserDebtValue,
  calculateExchangeAmount,
  calculateCollateralRatio,
  calculateLiquidation,
  WAD,
  BPS_DIVISOR
} from "@qmoosa/synthetics-protocol";
import { SyntheticsEngine } from "@qmoosa/synthetics-engine";
import { SyntheticsClient, generateKeyPair } from "@qmoosa/synthetics-sdk";

function setupSyntheticsSystem() {
  const { publicKey, privateKey } = generateKeyPair();
  const engine = new SyntheticsEngine(publicKey, 31337);

  engine.registerSynthDirect("sUSD", "Synthetic USD", "sUSD");
  engine.registerSynthDirect("sETH", "Synthetic Ether", "sETH");
  engine.registerSynthDirect("sBTC", "Synthetic Bitcoin", "sBTC");

  engine.setOraclePriceDirect("COLLATERAL", 10n * WAD); // $10 SNX
  engine.setOraclePriceDirect("sUSD", 1n * WAD);
  engine.setOraclePriceDirect("sETH", 2000n * WAD);
  engine.setOraclePriceDirect("sBTC", 50000n * WAD);

  const alice = "0xAliceStaker1111111111111111111111111";
  const bob = "0xBobStaker222222222222222222222222222";
  const liquidator = "0xLiquidator3333333333333333333333333";

  engine.setUserCollateralBalance(alice, 10000n * WAD);
  engine.setUserCollateralBalance(bob, 10000n * WAD);
  engine.setUserCollateralBalance(liquidator, 50000n * WAD);

  const client = new SyntheticsClient(engine, {
    issuerContractAddress: "0xQmoosaSyntheticsIssuer",
    defaultDeadlineSeconds: 600
  });

  return { engine, client, alice, bob, liquidator, publicKey, privateKey };
}

test("1. Multi-Repo Mathematical Invariant Verification", () => {
  // Issuance of 5000 sUSD with 0 existing debt
  const shares = calculateDebtSharesToMint(5000n * WAD, 0n, 0n);
  assert.equal(shares, 5000n * WAD);

  // User debt is 5000 USD
  const debt = calculateUserDebtValue(shares, shares, 5000n * WAD);
  assert.equal(debt, 5000n * WAD);

  // 1000 SNX at $10 = $10,000 collateral against $2500 debt -> 400% ratio
  const ratio = calculateCollateralRatio(1000n * WAD, 10n * WAD, 2500n * WAD, 18);
  assert.equal(ratio, 40000n);

  // Zero slippage exchange with 30 bps fee
  const { destAmount, feeUsd } = calculateExchangeAmount(2000n * WAD, 1n * WAD, 2000n * WAD, 30n);
  assert.equal(feeUsd, 6n * WAD); // $6.00 (30 bps of $2,000)
  assert.equal(destAmount, (1994n * WAD) / 2000n); // 0.997 sETH
});

test("2. End-to-End Staking, Issuance, and Zero-Slippage Synthetic Trading", async () => {
  const { client, alice } = setupSyntheticsSystem();

  // 1. Stake 2000 SNX ($20,000 collateral)
  const stk = await client.executeStake(alice, 2000n * WAD);
  assert.equal(stk.success, true);

  // 2. Issue 4000 sUSD (500% ratio at 200% min ratio)
  const iss = await client.executeIssue(alice, 4000n * WAD);
  assert.equal(iss.success, true);

  const pos1 = client.getStakerPosition(alice);
  assert.equal(pos1.isSolvent, true);
  assert.equal(pos1.debtValueUsd, 4000n * WAD);
  assert.equal(pos1.collateralRatioBps, 50000n);

  // 3. Exchange 2000 sUSD to sETH
  const exc = await client.executeExchange(alice, "sUSD", 2000n * WAD, "sETH");
  assert.equal(exc.success, true);
  assert.equal(exc.details.destKey, "sETH");
});

test("3. Dynamic Pooled Debt Risk Socialization", async () => {
  const { engine, client, alice, bob } = setupSyntheticsSystem();

  // Alice and Bob both stake $50,000 collateral and issue 2000 sUSD each
  await client.executeStake(alice, 5000n * WAD);
  await client.executeIssue(alice, 2000n * WAD);

  await client.executeStake(bob, 5000n * WAD);
  await client.executeIssue(bob, 2000n * WAD);

  // Alice swaps 2000 sUSD to sETH (holds 0.997 sETH)
  await client.executeExchange(alice, "sUSD", 2000n * WAD, "sETH");

  // ETH price surges from $2000 to $4000
  engine.overrideOraclePriceDirect("sETH", 4000n * WAD);

  // Global debt increased
  const globalDebt = client.getTotalGlobalDebt();
  assert.ok(globalDebt > 5900n * WAD);

  // Both stakers' debts increased symmetrically (risk socialization of debt pool)
  const posA = client.getStakerPosition(alice);
  const posB = client.getStakerPosition(bob);
  assert.equal(posA.debtValueUsd, posB.debtValueUsd);
  assert.ok(posA.debtValueUsd > 2900n * WAD);
});

test("4. Multi-Repo Liquidation and Shortfall Bad Debt Accounting", async () => {
  const { engine, client, alice, liquidator } = setupSyntheticsSystem();

  await client.executeStake(alice, 1000n * WAD); // 1000 SNX at $10 = $10,000 value
  await client.executeIssue(alice, 4000n * WAD); // 4000 sUSD (250% ratio)

  // Crash collateral price from $10 to $2 -> $2000 collateral against $4000 debt (< 200%)
  engine.overrideOraclePriceDirect("COLLATERAL", 2n * WAD);

  const posBefore = client.getStakerPosition(alice);
  assert.equal(posBefore.isSolvent, false);
  assert.equal(posBefore.isLiquidatable, true);

  // Liquidator stakes and issues sUSD
  await client.executeStake(liquidator, 50000n * WAD);
  await client.executeIssue(liquidator, 10000n * WAD);

  // Liquidate Alice for 3000 sUSD
  const liq = await client.executeLiquidate(liquidator, alice, 3000n * WAD);
  assert.equal(liq.success, true);

  // Bad debt deficit recorded
  assert.ok(engine.protocolBadDebt > 0n);
});
