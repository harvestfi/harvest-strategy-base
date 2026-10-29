/**
 * Verify every contract a CLVaultV2 deployment produced, from its snapshot file.
 *
 * scripts/20 writes the snapshot but originally verified nothing — the `verify: true` flag in the
 * configs was read by no code at all. This module is what that flag now drives, and it is also
 * runnable standalone for a deployment that already landed:
 *
 *   CL_SNAPSHOT=scripts/deployments/cl/usdc-aaplc-v2-w240.json \
 *     npx hardhat run --network mainnet scripts/21-verify-cl-vault-v2.js
 *
 * Every contract is attempted independently: an "Already Verified" or a single failure must not
 * stop the rest, because a partially verified deployment is the state that is hardest to reason
 * about later.
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function verifyOne(label, args) {
  try {
    await hre.run("verify:verify", args);
    console.log(`  ${label.padEnd(22)} VERIFIED  ${args.address}`);
    return "verified";
  } catch (e) {
    const msg = (e.message || "").toLowerCase();
    if (msg.includes("already verified") || msg.includes("already been verified")) {
      console.log(`  ${label.padEnd(22)} already verified  ${args.address}`);
      return "already";
    }
    console.log(`  ${label.padEnd(22)} FAILED    ${args.address}\n      ${(e.message || "").split("\n")[0].slice(0, 200)}`);
    return "failed";
  }
}

async function verifyDeployment(snapshot) {
  console.log(`verifying ${snapshot.name}`);
  const results = {};
  // The strategy implementation is LINKED to the rebalance library; without the libraries field
  // the bytecode will not match and verification fails with a confusing mismatch error.
  results.library = await verifyOne("CLRebalanceLibV2", { address: snapshot.rebalanceLibrary });
  results.vaultImpl = await verifyOne("CLVaultV2 impl", { address: snapshot.vaultImplementation });
  results.strategyImpl = await verifyOne("StrategyV2 impl", {
    address: snapshot.strategyImplementation,
    libraries: { CLRebalanceLibV2: snapshot.rebalanceLibrary },
  });
  results.vaultProxy = await verifyOne("VaultProxy", {
    address: snapshot.vault,
    constructorArguments: [snapshot.vaultImplementation],
  });
  results.strategyProxy = await verifyOne("StrategyProxy", {
    address: snapshot.strategy,
    constructorArguments: [snapshot.strategyImplementation],
  });
  if (snapshot.wrappers) {
    // The wrappers were constructed against the BRIDGE storage, not addresses.Storage — passing the
    // wrong one here is the classic reason wrapper verification fails (it bit the V1 deploy script).
    const wstorage = snapshot.wrapperConstructorStorage || snapshot.setupStorage;
    if (!wstorage) {
      console.log("  wrappers               SKIPPED — snapshot has no record of the storage they were built against");
    } else {
      results.wrapper0 = await verifyOne("CLWrapperV2 token0", {
        address: snapshot.wrappers.token0,
        constructorArguments: [wstorage, snapshot.vault, true],
      });
      results.wrapper1 = await verifyOne("CLWrapperV2 token1", {
        address: snapshot.wrappers.token1,
        constructorArguments: [wstorage, snapshot.vault, false],
      });
    }
  }
  const failed = Object.entries(results).filter(([, v]) => v === "failed").map(([k]) => k);
  console.log(failed.length ? `\n  ${failed.length} FAILED: ${failed.join(", ")}` : "\n  all contracts verified");
  return results;
}

async function main() {
  const p = process.env.CL_SNAPSHOT;
  if (!p) throw new Error("CL_SNAPSHOT is required (path to a deployment snapshot json)");
  await verifyDeployment(JSON.parse(fs.readFileSync(path.resolve(p), "utf8")));
}

module.exports = { verifyDeployment };
if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
