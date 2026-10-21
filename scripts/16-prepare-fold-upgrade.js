// Deployer-wallet prep for upgrading the LIVE Aave cbETH/ETH fold deployment.
//
// This script performs ONLY the deployer's actions: it deploys the new
// implementation contracts (it does NOT touch the proxies, the position, or
// governance state). After it runs, GOVERNANCE (the Safe) and the ULOwner EOA
// send the transactions printed at the end, which come from
// scripts/fold-upgrade-plan.js. test/aave/fold/upgrade-rehearsal-fork.js runs
// that same plan through the real Safe on a fork.
//
// Deployer actions:
//   1. Deploy AaveReserveLib (or reuse one via AAVE_RESERVE_LIB).
//   2. Link it and deploy the new strategy implementation (or reuse one via STRATEGY_IMPL).
//   3. Deploy the new FoldVaultV2 implementation (or reuse one via VAULT_IMPL).
//   4. Verify all three on Basescan.
// The proxies (strategy 0xcfd2…, vault 0xE78285…) already exist and are reused
// by the upgrade. Nothing here is initialized.
//
//   npx hardhat run scripts/16-prepare-fold-upgrade.js --network mainnet
//   (optional: AAVE_RESERVE_LIB=0x… STRATEGY_IMPL=0x… VAULT_IMPL=0x… to reuse
//    contracts from an earlier run instead of redeploying them)
//
// The premium-free flashloan strategy needs AaveReserveLib.flash, which the
// library deployed for impl 0x74ae6e11 (0x2B19aB8A) does not have. A strategy
// linked to a stale library would revert every lever AND delever, i.e. every
// deposit and withdrawal. So every library address this script touches (a
// supplied one, a fresh one, and the one embedded in the strategy impl) must
// match the compiled AaveReserveLib byte-for-byte (except its own address), or
// the script stops before printing anything for governance.

const hre = require("hardhat");
const { type2Transaction } = require("./utils.js");
const plan = require("./fold-upgrade-plan.js");

const { STRATEGY_PROXY, VAULT_PROXY, SAFE, UL_OWNER, LIB_FQN, STRATEGY_NAME } = plan;

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

async function main() {
  console.log("=== Deployer prep: Aave cbETH/ETH fold upgrade ===\n");
  const provider = hre.ethers.provider;
  const libArtifact = await hre.artifacts.readArtifact("AaveReserveLib");
  const stratArtifact = await hre.artifacts.readArtifact(STRATEGY_NAME);
  const vaultArtifact = await hre.artifacts.readArtifact("FoldVaultV2");

  // 1) AaveReserveLib: deploy fresh, or reuse a pre-deployed one.
  const AaveReserveLib = artifacts.require("AaveReserveLib");
  let libAddress = process.env.AAVE_RESERVE_LIB;
  let libDeployed = false;
  if (libAddress) {
    console.log("1) Reusing AaveReserveLib at:       ", libAddress);
  } else {
    const lib = await type2Transaction(AaveReserveLib.new);
    libAddress = lib.creates;
    libDeployed = true;
    console.log("1) AaveReserveLib deployed at:      ", libAddress);
  }
  await plan.assertLibraryMatchesBuild(provider, libArtifact, libAddress);
  console.log("   bytecode matches this build's AaveReserveLib");

  // 2) New strategy implementation (references AaveReserveLib, so link first).
  let stratImpl = process.env.STRATEGY_IMPL;
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
  await plan.assertLibraryMatchesBuild(provider, libArtifact, linkedLib);
  if (linkedLib.toLowerCase() !== libAddress.toLowerCase()) {
    throw new Error(`strategy impl ${stratImpl} is linked to ${linkedLib}, not to ${libAddress}`);
  }

  // 3) New FoldVaultV2 implementation (no constructor args, no immutables, no library).
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

  console.log(`\n=== Deployer done. Governance next: Safe ${SAFE} (2-of-3, 12h upgrade delay) ===`);
  console.log("The ORDER matters. Execute exactly in this sequence:");
  safeTxs.forEach(printTx);
  console.log("\nWhy Safe tx 2 must be ONE batch: preInteract() runs on the OLD impl and books the fee");
  console.log("on any gain since the last interaction, then the upgrade's finalizeUpgrade() resyncs");
  console.log("storedBalance without booking a fee. Bundled, the share price is continuous to the wei");
  console.log("across upgrade() and no fee is forgiven. StrategyProxy.upgrade() and VaultProxy.upgrade()");
  console.log("only succeed when called by governance (finalizeUpgrade is onlyGovernance), so no one can");
  console.log("run the upgrade without the bundle. Execute it strictly after nextImplementationTimestamp.");
  console.log("Expect a one-off share-price move in Safe tx 2 either way: the old impl reports a cached");
  console.log("balance, and preInteract() books the carry accrued since the last vault interaction");
  console.log("(-7.6 bps in the rehearsal at block 52896800 + 12h). That is already-incurred P&L, not");
  console.log("an upgrade effect; the Spectra PT books a drop of it permanently, whenever it is realised.");
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
  console.log(`  AAVE_RESERVE_LIB=${libAddress} STRATEGY_IMPL=${stratImpl} VAULT_IMPL=${vaultImpl} VERIFY_REUSED=1 \\`);
  console.log("    npx hardhat run scripts/16-prepare-fold-upgrade.js --network mainnet");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
