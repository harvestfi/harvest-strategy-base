// Deployer-wallet prep for the checker() overflow fix on the LIVE Aave
// cbETH/ETH fold strategy.
//
// Background: checker() evaluated `health < (targetHealth() * 99) / 100`. When
// there is no leverage target (fold() == false, or borrowTargetFactorNumerator()
// == 0) targetHealth() is type(uint256).max, so that multiplication overflowed
// and the view reverted with panic 0x11 instead of answering. Governance setting
// the borrow target to 0 put the live strategy in exactly that state.
//
// The fix is confined to the checker() view: no storage layout change, no
// selector change, no change to any state-changing path. Only the STRATEGY
// implementation needs redeploying - the vault is untouched.
//
// This script performs ONLY the deployer's actions: it deploys the new strategy
// implementation. It does NOT touch the proxy; GOVERNANCE runs the timelocked
// scheduleUpgrade + upgrade calls printed at the end.
//
//   npx hardhat run scripts/17-prepare-checker-fix-upgrade.js --network mainnet
//
// AaveReserveLib is unchanged by this fix, so the already-deployed library is
// reused by default. Override with AAVE_RESERVE_LIB=0x... to point elsewhere,
// or set DEPLOY_LIB=1 to deploy a fresh one.

const hre = require("hardhat");
const { type2Transaction } = require("./utils.js");

// --- The live deployment being upgraded (Base mainnet) ---------------------
const STRATEGY_PROXY = "0xcfd2f32E6d533653cEd5Ba7E5fe1a76C3c626757";
const GOVERNANCE = "0x920b1aCb7618B553324aa0F71620226FA2e09870"; // msig that runs the upgrade
const DEFAULT_RESERVE_LIB = "0x2B19aB8A9b31798f2536c440B596816e2aa10033"; // already deployed, unchanged
const STRATEGY_NAME = "Aave2AssetFoldStrategyMainnet_ETH_cbETH"; // same variant as deployed

async function main() {
  console.log("=== Deployer prep: Aave cbETH/ETH fold checker() fix ===\n");

  // 1) AaveReserveLib - reuse the deployed one unless told otherwise.
  const AaveReserveLib = artifacts.require("AaveReserveLib");
  let libAddress = process.env.AAVE_RESERVE_LIB || DEFAULT_RESERVE_LIB;
  if (process.env.DEPLOY_LIB === "1") {
    const lib = await type2Transaction(AaveReserveLib.new);
    libAddress = lib.creates;
    console.log("1) AaveReserveLib freshly deployed at:", libAddress);
  } else {
    const code = await hre.ethers.provider.getCode(libAddress);
    if (code === "0x") {
      throw new Error(
        `AaveReserveLib has no code at ${libAddress}. Set AAVE_RESERVE_LIB=0x... or DEPLOY_LIB=1.`
      );
    }
    console.log("1) Reusing deployed AaveReserveLib at:", libAddress);
  }
  const libInstance = await AaveReserveLib.at(libAddress);

  // 2) New strategy implementation (references AaveReserveLib, so link first).
  const StrategyImpl = artifacts.require(STRATEGY_NAME);
  StrategyImpl.link(libInstance);
  const strat = await type2Transaction(StrategyImpl.new);
  console.log("2) New strategy impl deployed at:    ", strat.creates);

  // 3) Verify on the explorer (best-effort; won't abort on failure).
  try {
    await hre.run("verify:verify", {
      address: strat.creates,
      libraries: { AaveReserveLib: libAddress },
    });
    console.log("   verified strategy impl");
  } catch (e) {
    console.log("   strategy verify skipped/failed:", e.message);
  }

  // --- Hand-off to governance ------------------------------------------------
  console.log("\n=== Deployer done. Governance (%s) next: ===", GOVERNANCE);
  console.log("Strategy-only upgrade; the vault needs no change.\n");
  console.log(`  1. IUpgradeSource(${STRATEGY_PROXY}).scheduleUpgrade(${strat.creates})`);
  console.log("  2. (wait nextImplementationDelay, 43200s / 12h)");
  console.log(`  3. StrategyProxy(${STRATEGY_PROXY}).upgrade()`);
  console.log("\nAfter the upgrade, confirm the fix on the proxy:");
  console.log(`  ${STRATEGY_PROXY}.checker()  ->  must return (false, <payload>) and NOT revert`);
  console.log("  (false is correct while the borrow target is 0 and the debt is already repaid;");
  console.log("   it returns true only while there is still debt to unwind.)");

  console.log("\n=== Deployed addresses (record these) ===");
  console.log(JSON.stringify({
    aaveReserveLib: libAddress,
    newStrategyImpl: strat.creates,
  }, null, 2));

  console.log("\nIf explorer verification failed above (propagation delay), re-verify once the");
  console.log("deploy tx has a few confirmations - do NOT re-run this script, it would redeploy.");
  console.log(`  use the verify:verify task with libraries = { AaveReserveLib: "${libAddress}" }.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
