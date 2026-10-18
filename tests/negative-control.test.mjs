import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SyntheticsEngine, AdminAuthManager, WAD } from "@qmoosa/synthetics-engine";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function setupAdversarialSystem() {
  const { publicKey, privateKey } = AdminAuthManager.generateKeyPair();
  const engine = new SyntheticsEngine(publicKey, 31337);

  engine.registerSynthDirect("sUSD", "Synthetic USD", "sUSD");
  engine.registerSynthDirect("sETH", "Synthetic Ether", "sETH");

  engine.setOraclePriceDirect("COLLATERAL", 10n * WAD);
  engine.setOraclePriceDirect("sUSD", 1n * WAD);
  engine.setOraclePriceDirect("sETH", 2000n * WAD);

  const alice = "0xAlice1111111111111111111111111111111111";
  const attacker = "0xAttacker6666666666666666666666666666666666";

  engine.setUserCollateralBalance(alice, 5000n * WAD);
  engine.setUserCollateralBalance(attacker, 50000n * WAD);

  return { engine, publicKey, privateKey, alice, attacker };
}

test("Negative Control 1: Undercollateralized synth issuance fails closed with zero mutation", () => {
  const { engine, alice } = setupAdversarialSystem();
  engine.stakeCollateral(alice, 1000n * WAD); // $10,000 collateral, max debt = $5,000

  assert.throws(
    () => engine.issueSynths(alice, 6000n * WAD),
    /MINT_BREAKS_SOLVENCY/
  );

  const pos = engine.getStakerPosition(alice);
  assert.equal(pos.debtShares, 0n);
  assert.equal(engine.getUserSynthBalance(alice, "sUSD"), 0n);
});

test("Negative Control 2: Unstaking collateral that breaks minimum ratio strictly fails closed", () => {
  const { engine, alice } = setupAdversarialSystem();
  engine.stakeCollateral(alice, 1000n * WAD);
  engine.issueSynths(alice, 4000n * WAD); // 250% ratio

  // Unstaking 500 SNX leaves 500 SNX ($5000 value), ratio drops to 125% (< 200%)
  assert.throws(
    () => engine.unstakeCollateral(alice, 500n * WAD),
    /UNSTAKE_BREAKS_SOLVENCY/
  );

  assert.equal(engine.stakedCollateral.get(alice), 1000n * WAD);
});

test("Negative Control 3: Forged Ed25519 administrative signature strictly fails closed", () => {
  const { engine } = setupAdversarialSystem();
  const { privateKey: fakeKey } = AdminAuthManager.generateKeyPair();

  const now = Math.floor(Date.now() / 1000);
  const forgedIntent = AdminAuthManager.signAdminIntent(
    "SET_EXCHANGE_FEE",
    { feeBps: 10 },
    1,
    now + 3600,
    "QMOOSA:SYNTHETICS_ENGINE:31337",
    fakeKey
  );

  assert.throws(
    () => engine.executeAdminIntent(forgedIntent),
    /Cryptographic verification failed/
  );
});

test("Negative Control 4: Nonce replay attack strictly fails closed", () => {
  const { engine, privateKey } = setupAdversarialSystem();

  const now = Math.floor(Date.now() / 1000);
  const intent = AdminAuthManager.signAdminIntent(
    "SET_EXCHANGE_FEE",
    { feeBps: 10 },
    1,
    now + 3600,
    "QMOOSA:SYNTHETICS_ENGINE:31337",
    privateKey
  );

  engine.executeAdminIntent(intent);

  assert.throws(
    () => engine.executeAdminIntent(intent),
    /Nonce replay rejected/
  );
});

test("Negative Control 5: Hostile liquidator cannot liquidate a healthy staker", () => {
  const { engine, alice, attacker } = setupAdversarialSystem();
  engine.stakeCollateral(alice, 1000n * WAD);
  engine.issueSynths(alice, 1000n * WAD); // 1000% ratio (super healthy)

  assert.throws(
    () => engine.liquidate(attacker, alice, 500n * WAD),
    /POSITION_SOLVENT/
  );
});

test("Negative Control 6: Deliberate archive tampering causes verify:archive to fail with exit code 1", () => {
  const archivePath = path.join(rootDir, "packages", "qmoosa-synthetics-protocol-1.0.0.tgz");
  const original = fs.readFileSync(archivePath);
  try {
    fs.appendFileSync(archivePath, "CORRUPT_BYTES");
    assert.throws(
      () => execSync("node scripts/verify-source-integrity.mjs --mode=archive", {
        cwd: rootDir,
        stdio: "pipe"
      }),
      /Command failed/
    );
  } finally {
    fs.writeFileSync(archivePath, original);
  }
});

test("Negative Control 7: Stale oracle timestamp fails closed", () => {
  const { engine } = setupAdversarialSystem();
  const pastTime = Math.floor(Date.now() / 1000) - 4000;

  assert.throws(
    () => engine.setOraclePriceDirect("sETH", 2100n * WAD, pastTime),
    /ORACLE_PRICE_STALE/
  );
});

test("Negative Control 8: Price deviation exceeding 50% fails closed without override", () => {
  const { engine } = setupAdversarialSystem();

  assert.throws(
    () => engine.setOraclePriceDirect("sETH", 4000n * WAD), // 100% increase > 50% max deviation
    /PRICE_DEVIATION_EXCEEDED/
  );
});

test("Negative Control 9: Bad debt recorded upon severe underwater shortfall liquidation", () => {
  const { engine, alice, attacker } = setupAdversarialSystem();
  engine.stakeCollateral(alice, 1000n * WAD); // 1000 SNX
  engine.issueSynths(alice, 4000n * WAD); // $4000 debt

  // Crash collateral to $2/SNX ($2000 total collateral against $4000 debt)
  engine.overrideOraclePriceDirect("COLLATERAL", 2n * WAD);

  // Attacker liquidates
  engine.stakeCollateral(attacker, 50000n * WAD);
  engine.issueSynths(attacker, 10000n * WAD);

  engine.liquidate(attacker, alice, 3000n * WAD);
  assert.ok(engine.protocolBadDebt > 0n);
});
