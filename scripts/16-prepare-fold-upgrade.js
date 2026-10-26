// Deployer-wallet prep for upgrading the LIVE Aave cbETH/ETH fold deployment.
//
// This script performs ONLY the deployer's actions: it deploys the new
// implementation contracts (it does NOT touch the proxies, the position, or
// governance state). After it runs, GOVERNANCE (the Safe) sends the
// transactions printed at the end, which come from scripts/fold-upgrade-plan.js.
// test/aave/fold/upgrade-rehearsal-fork.js runs that same plan through the real
// Safe on a fork.
//
// Two modes:
//
//   npx hardhat run scripts/16-prepare-fold-upgrade.js --network mainnet
//     DEFAULT: the strategy-only rollout that ships. Deployer actions:
//       1. Deploy AaveReserveLib (or reuse one via AAVE_RESERVE_LIB; with only
//          STRATEGY_IMPL set, the library linked into that impl is used).
//       2. Link it and deploy the new strategy implementation (or reuse one via STRATEGY_IMPL).
//       3. Verify both on Basescan.
//     The vault keeps its live impl 0x4942b35f: no FoldVaultV2 is deployed and
//     nothing is scheduled on the vault. Writes Safe Transaction Builder files to
//     OUT (default ./out), the list from plan.strategyOnlyFiles():
//     safe-tx-1-schedule.json, safe-tx-2-upgrade.json, safe-rollback-schedule.json.
//     STRATEGY_ONLY=1 (or true) is still accepted and changes nothing.
//
//   LEGACY_VAULT_UPGRADE=1 npx hardhat run scripts/16-prepare-fold-upgrade.js --network mainnet
//     The earlier strategy + vault rollout (kept for the rehearsal history):
//     steps 1-2 above, plus 3. deploy the FoldVaultV2 impl (or VAULT_IMPL), and
//     the full governancePlan() hand-off. Prints only; writes no files.
//
//   Any other value of LEGACY_VAULT_UPGRADE (or STRATEGY_ONLY other than 1/true/empty,
//   or both set) exits 1 before anything is deployed.
//
//   (optional: AAVE_RESERVE_LIB=0x… STRATEGY_IMPL=0x… [VAULT_IMPL=0x…] to reuse
//    contracts from an earlier run instead of redeploying them; VERIFY_REUSED=1
//    also re-verifies a reused library. A reused STRATEGY_IMPL must be byte-for-byte
//    this build's strategy, library address aside.)
//
// The proxies (strategy 0xcfd2…, vault 0xE78285…) already exist and are reused
// by the upgrade. Nothing here is initialized.
//
// The premium-free flashloan strategy needs AaveReserveLib.flash, which the
// library deployed for impl 0x74ae6e11 (0x2B19aB8A) does not have. A strategy
// linked to a stale library would revert every lever AND delever, i.e. every
// deposit and withdrawal. So every library address this script touches (a
// supplied one, a fresh one, and the one embedded in the strategy impl) must
// match the compiled AaveReserveLib byte-for-byte (except its own address), or
// the script stops before printing anything for governance.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { type2Transaction } = require("./utils.js");
const plan = require("./fold-upgrade-plan.js");

const { STRATEGY_PROXY, SAFE, UL_OWNER, LIB_FQN, STRATEGY_NAME, STALE_LIB, LIVE_STRATEGY_IMPL, LIVE_VAULT_IMPL } = plan;

// Strategy-only is the default; the legacy strategy + vault path needs LEGACY_VAULT_UPGRADE=1
// exactly. Anything ambiguous stops the script before it deploys anything.
function rolloutMode() {
  const legacy = process.env.LEGACY_VAULT_UPGRADE || "";
  const strategyOnly = (process.env.STRATEGY_ONLY || "").toLowerCase();
  if (legacy !== "" && legacy !== "1") {
    throw new Error(`LEGACY_VAULT_UPGRADE=${legacy}: only 1 selects the legacy strategy + vault rollout. `
      + "Unset it for the strategy-only rollout (the default).");
  }
  if (!["", "1", "true"].includes(strategyOnly)) {
    throw new Error(`STRATEGY_ONLY=${process.env.STRATEGY_ONLY}: strategy-only is the default now; `
      + "leave STRATEGY_ONLY unset (1/true are accepted and change nothing). "
      + "The legacy strategy + vault rollout needs LEGACY_VAULT_UPGRADE=1.");
  }
  if (legacy === "1" && strategyOnly !== "") {
    throw new Error("LEGACY_VAULT_UPGRADE=1 and STRATEGY_ONLY are both set. Pick one rollout.");
  }
  return legacy === "1" ? "legacy" : "strategy-only";
}

async function verify(label, args) {
  if (hre.network.name === "hardhat") {
    console.log(`   ${label}: verify skipped on the hardhat network`);
    return;
  }
  try {
    await hre.run("verify:verify", args);
    console.log(`   verified ${label}`);
  } catch (e) {
    console.log(`   ${label} verify skipped/failed:`, e.message);
  }
}

const printTx = (tx) => {
  console.log(`\n${tx.label}`);
  tx.calls.forEach((c, i) => console.log(`   ${tx.calls.length > 1 ? `${i + 1}. ` : ""}${c.desc}\n      to   ${c.to}\n      data ${c.data}`));
  if (tx.operation === 1) {
    console.log(`   As one Safe transaction (Transaction Builder produces the same):`);
    console.log(`      to ${tx.to} (MultiSendCallOnly 1.4.1)  value 0  operation 1 (delegatecall)`);
    console.log(`      data ${tx.data}`);
  } else {
    console.log(`   As one Safe transaction: to ${tx.to}  value 0  operation 0 (call)`);
  }
};

// Why tx 2 is bundled, and what it does not avoid. Shared by both modes.
function printBundleNote() {
  console.log("\nWhy Safe tx 2 must be ONE batch: preInteract() runs on the OLD impl and books the fee");
  console.log("on any gain since the last interaction, then the upgrade's finalizeUpgrade() resyncs");
  console.log("storedBalance without booking a fee. Bundled, the share price after tx 2 matches the");
  console.log("new-impl override at the block before, time-aligned, within 0.01 bp, and no fee is forgiven.");
  console.log("StrategyProxy.upgrade() only succeeds when");
  console.log("called by governance (finalizeUpgrade is onlyGovernance), so no one can run the upgrade");
  console.log("without the bundle. Execute it strictly after nextImplementationTimestamp.");
  console.log("Expect a one-off share-price move in Safe tx 2 either way: the old impl reports a cached");
  console.log("balance, and preInteract() books the carry accrued since the last vault interaction");
  console.log("(-7.6 bps in the rehearsal at block 52896800 + 12h). That is already-incurred P&L, not");
  console.log("an upgrade effect; the Spectra PT books a drop of it permanently, whenever it is realised.");
  console.log("The reference for that move is the stateDiff-override value printed by");
  console.log("`node scripts/fold-upgrade-check.js --phase before-upgrade`, not the rehearsal's -7.6 bps.");
}

function writeTxBuilderFiles(out, files) {
  fs.mkdirSync(out, { recursive: true });
  for (const { file, description, tx } of files) {
    const f = path.join(out, file);
    fs.writeFileSync(f, JSON.stringify(plan.txBuilderFile(file, description, tx), null, 2));
    console.log(`   wrote ${f} (${tx.calls.length} raw call${tx.calls.length > 1 ? "s" : ""})`);
  }
}

async function main() {
  const STRATEGY_ONLY = rolloutMode() === "strategy-only";
  console.log(`=== Deployer prep: Aave cbETH/ETH fold upgrade${STRATEGY_ONLY ? " (strategy-only: the vault is not touched)" : " (LEGACY_VAULT_UPGRADE: strategy + vault)"} ===\n`);
  // A VAULT_IMPL in strategy-only mode means the operator is mixing up the two rollouts.
  // Stop before deploying anything rather than silently ignoring it.
  if (STRATEGY_ONLY && process.env.VAULT_IMPL) {
    throw new Error("VAULT_IMPL is set but the strategy-only rollout (the default) never touches the vault. "
      + "Unset VAULT_IMPL, or set LEGACY_VAULT_UPGRADE=1 for the strategy + vault rollout.");
  }
  const provider = hre.ethers.provider;
  const libArtifact = await hre.artifacts.readArtifact("AaveReserveLib");
  const stratArtifact = await hre.artifacts.readArtifact(STRATEGY_NAME);

  // A reused strategy impl must be exactly this build (library address aside), checked
  // before anything is deployed: otherwise a stale or foreign impl gets the Safe's files.
  const reusedImpl = process.env.STRATEGY_IMPL;
  if (reusedImpl) {
    await plan.assertImplMatchesBuild(provider, stratArtifact, reusedImpl);
    console.log(`0) STRATEGY_IMPL ${reusedImpl} is byte-for-byte this build's ${STRATEGY_NAME} (library address aside)`);
  }

  // 1) AaveReserveLib: deploy fresh, reuse a pre-deployed one, or (STRATEGY_IMPL without
  //    AAVE_RESERVE_LIB) take the one linked into the reused impl.
  const AaveReserveLib = artifacts.require("AaveReserveLib");
  let libAddress = process.env.AAVE_RESERVE_LIB;
  let libDeployed = false;
  if (libAddress) {
    console.log("1) Reusing AaveReserveLib at:       ", libAddress);
  } else if (reusedImpl) {
    libAddress = plan.linkedLibraries(await provider.getCode(reusedImpl), stratArtifact)[LIB_FQN];
    if (!libAddress) throw new Error(`the ${STRATEGY_NAME} artifact has no link reference for ${LIB_FQN}`);
    console.log("1) Using the AaveReserveLib linked into STRATEGY_IMPL:", libAddress);
    if (libAddress.toLowerCase() === STALE_LIB.toLowerCase()) {
      throw new Error(`strategy impl ${reusedImpl} is linked to the stale library ${STALE_LIB}`);
    }
  } else {
    const lib = await type2Transaction(AaveReserveLib.new);
    libAddress = lib.creates;
    libDeployed = true;
    console.log("1) AaveReserveLib deployed at:      ", libAddress);
  }
  await plan.assertLibraryMatchesBuild(provider, libArtifact, libAddress);
  console.log("   bytecode matches this build's AaveReserveLib");

  // 2) New strategy implementation (references AaveReserveLib, so link first).
  let stratImpl = reusedImpl;
  if (stratImpl) {
    console.log("2) Reusing strategy impl at:        ", stratImpl);
  } else {
    const StrategyImpl = artifacts.require(STRATEGY_NAME);
    StrategyImpl.link(await AaveReserveLib.at(libAddress));
    stratImpl = (await type2Transaction(StrategyImpl.new)).creates;
    console.log("2) New strategy impl deployed at:   ", stratImpl);
  }
  // Read the library address back out of the impl's runtime code: this is what
  // the proxy will actually delegatecall into.
  const linked = plan.linkedLibraries(await provider.getCode(stratImpl), stratArtifact);
  const linkedLib = linked[LIB_FQN];
  console.log("   impl is linked to AaveReserveLib:", linkedLib);
  if (linkedLib.toLowerCase() === STALE_LIB.toLowerCase()) {
    throw new Error(`strategy impl ${stratImpl} is linked to the stale library ${STALE_LIB}`);
  }
  await plan.assertLibraryMatchesBuild(provider, libArtifact, linkedLib);
  if (linkedLib.toLowerCase() !== libAddress.toLowerCase()) {
    throw new Error(`strategy impl ${stratImpl} is linked to ${linkedLib}, not to ${libAddress}`);
  }
  if (!reusedImpl) await plan.assertImplMatchesBuild(provider, stratArtifact, stratImpl);
  console.log("   impl runtime code matches this build exactly (library address aside)");

  if (STRATEGY_ONLY) {
    // 3) Verify on Basescan (best-effort; won't abort on failure).
    if (libDeployed || process.env.VERIFY_REUSED) await verify("AaveReserveLib", { address: libAddress });
    await verify("strategy impl", { address: stratImpl, libraries: { AaveReserveLib: libAddress } });
    return handOffStrategyOnly({ libAddress, stratImpl, linkedLib });
  }

  // 3) New FoldVaultV2 implementation (no constructor args, no immutables, no library).
  const vaultArtifact = await hre.artifacts.readArtifact("FoldVaultV2");
  let vaultImpl = process.env.VAULT_IMPL;
  if (vaultImpl) {
    console.log("3) Reusing FoldVaultV2 impl at:     ", vaultImpl);
  } else {
    const FoldVaultV2 = artifacts.require("FoldVaultV2");
    vaultImpl = (await type2Transaction(FoldVaultV2.new)).creates;
    console.log("3) New FoldVaultV2 impl deployed at:", vaultImpl);
  }
  if ((await provider.getCode(vaultImpl)).toLowerCase() !== vaultArtifact.deployedBytecode.toLowerCase()) {
    throw new Error(`FoldVaultV2 impl ${vaultImpl} is not this build's FoldVaultV2`);
  }

  // 4) Verify on Basescan (best-effort; won't abort on failure).
  if (libDeployed || process.env.VERIFY_REUSED) await verify("AaveReserveLib", { address: libAddress });
  await verify("strategy impl", { address: stratImpl, libraries: { AaveReserveLib: libAddress } });
  await verify("FoldVaultV2 impl", { address: vaultImpl });

  // --- Hand-off -----------------------------------------------------------------
  const { safeTxs, eoaTxs, optionalSafeTxs } = plan.governancePlan({ strategyImpl: stratImpl, vaultImpl });

  console.log(`\n=== Deployer done. Governance next: Safe ${SAFE} (2-of-3, 12h upgrade delay) ===`);
  console.log("The ORDER matters. Execute exactly in this sequence:");
  safeTxs.forEach(printTx);
  printBundleNote();
  console.log("VaultProxy.upgrade() is governance-only for the same reason.");
  console.log("\nDo NOT call FoldVaultV2.setPreviewLens(). With the lens set, previewRedeem becomes");
  console.log(`pool-dependent and withdraw() is disabled; the Spectra PT ${plan.SPECTRA_PT}`);
  console.log("reads previewRedeem as its IBT rate and calls withdraw(). The vault ships with the lens unset.");
  console.log(`\nThe deposit cap is storage and survives the upgrade unchanged (live: 200 WETH). No action.`);

  console.log(`\n=== NOT through the Safe: ULOwner EOA ${UL_OWNER} ===`);
  console.log("CLChainlinkChecker's governance is this EOA, so this call would revert a Safe batch.");
  eoaTxs.forEach((tx) => console.log(`\n${tx.label}\n   ${tx.desc}\n      from ${tx.from}\n      to   ${tx.to}\n      data ${tx.data}`));

  console.log("\n=== For a governance decision (not part of the upgrade) ===");
  optionalSafeTxs.forEach(printTx);

  console.log("\n=== Deployed addresses (record these) ===");
  console.log(JSON.stringify({
    aaveReserveLib: libAddress,
    newStrategyImpl: stratImpl,
    newFoldVaultV2Impl: vaultImpl,
  }, null, 2));

  console.log("\nIf Basescan verification failed above (propagation delay), re-run this script with");
  console.log("the addresses above so that nothing is redeployed:");
  console.log(`  LEGACY_VAULT_UPGRADE=1 AAVE_RESERVE_LIB=${libAddress} STRATEGY_IMPL=${stratImpl} VAULT_IMPL=${vaultImpl} VERIFY_REUSED=1 \\`);
  console.log("    npx hardhat run scripts/16-prepare-fold-upgrade.js --network mainnet");
}

function handOffStrategyOnly({ libAddress, stratImpl, linkedLib }) {
  // The Transaction Builder files and the txs printed below are the same objects.
  const files = plan.strategyOnlyFiles({ strategyImpl: stratImpl });
  const [tx1, tx2, rollback] = files.map((f) => f.tx);

  console.log(`\n=== Deployer done. Governance next: Safe ${SAFE} (2-of-3, 12h upgrade delay) ===`);
  console.log("Prerequisite: the keeper (KeeperChecker with the fold strategy) is live first.");
  console.log(`Strategy impl ${stratImpl} is linked to AaveReserveLib ${linkedLib} (not the stale ${STALE_LIB}).`);
  console.log("The ORDER matters. Execute exactly in this sequence:");

  console.log(`\n${tx1.label}`);
  console.log(`   ${tx1.calls[0].desc}\n      to   ${tx1.calls[0].to}  value 0  operation 0 (call)\n      data ${tx1.calls[0].data}`);
  console.log("   Then: STRATEGY_IMPL=<impl> SCHEDULE_TX=<Safe exec tx hash> node scripts/fold-upgrade-check.js --phase after-schedule");

  console.log(`\n${tx2.label}`);
  tx2.calls.forEach((c, i) => console.log(`   ${i + 1}. ${c.desc}\n      to   ${c.to}\n      data ${c.data}`));
  console.log("   For reference only, the single Safe transaction Transaction Builder makes of these two calls:");
  console.log(`      to ${tx2.to} (MultiSendCallOnly 1.4.1)  value 0  operation 1 (delegatecall)`);
  console.log(`      data ${tx2.data}`);
  console.log("   Before signing: STRATEGY_IMPL=<impl> node scripts/fold-upgrade-check.js --phase before-upgrade");
  console.log("   After:          STRATEGY_IMPL=<impl> UPGRADE_TX=<Safe exec tx hash> node scripts/fold-upgrade-check.js --phase after-upgrade");
  printBundleNote();
  console.log("Per-transaction deposits are limited by DEX depth (~25 WETH on the new Aero pool today):");
  console.log("a deposit buys ~12.5x its size in cbETH, and larger ones revert on the 50 bp swap floor.");

  console.log(`\n${rollback.label} (only if needed; then, strictly after 12h, Safe tx 2 again: its calls are impl-independent)`);
  console.log(`   ${rollback.calls[0].desc}\n      to   ${rollback.calls[0].to}  value 0  operation 0 (call)\n      data ${rollback.calls[0].data}`);
  console.log(`   (${LIVE_STRATEGY_IMPL} is the live impl today.)`);

  // Transaction Builder files: the RAW inner calls. Builder wraps the 2-call file in a
  // delegatecall to MultiSendCallOnly itself; a pre-encoded multiSend(bytes) call in the
  // file would go out as operation 0 and both governance-only calls would revert.
  const out = process.env.OUT || "./out";
  console.log(`\n=== Safe Transaction Builder files (chainId 8453, Safe ${SAFE}) ===`);
  writeTxBuilderFiles(out, files);
  console.log("   Load each in Transaction Builder: tx 1 and the rollback must decode as ONE call to");
  console.log(`   ${STRATEGY_PROXY}, value 0; tx 2 as a delegatecall to ${plan.MULTISEND_CALL_ONLY}`);
  console.log("   with the two inner calls above. Builder may warn about a checksum / 'modified' file on");
  console.log("   import (these files are generated, not exported from Builder): expected; check the decoded calls.");

  console.log(`\nVault: no action. Its impl stays ${LIVE_VAULT_IMPL}; schedule nothing on it.`);

  console.log("\n=== Deployed addresses (record these) ===");
  console.log(JSON.stringify({ aaveReserveLib: libAddress, newStrategyImpl: stratImpl }, null, 2));

  console.log("\nIf Basescan verification failed above (propagation delay), re-run this script with");
  console.log("the addresses above so that nothing is redeployed:");
  console.log(`  AAVE_RESERVE_LIB=${libAddress} STRATEGY_IMPL=${stratImpl} VERIFY_REUSED=1 \\`);
  console.log("    npx hardhat run scripts/16-prepare-fold-upgrade.js --network mainnet");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
