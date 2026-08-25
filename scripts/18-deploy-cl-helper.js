/**
 * Deploy a standalone CLRebalanceHelper.
 *
 * The helper is stateless and deployment-agnostic (every entry point takes `pool` or
 * `posManager` as an argument), so one instance serves every CL vault. Deploying it explicitly
 * — rather than via a config's `deploySharedHelper` flag — makes it visible and auditable that
 * a set of vaults share one helper, which matters when vaults are being compared against each
 * other: a difference in helper version would invalidate the comparison.
 *
 * Usage:
 *   npx hardhat run --network mainnet scripts/18-deploy-cl-helper.js
 *   npx hardhat verify --network mainnet <address>
 */
const hre = require("hardhat");
const { type2Transaction } = require("./utils.js");

const CLRebalanceHelper = artifacts.require("CLRebalanceHelper");

async function main() {
  if (typeof artifacts === "undefined") throw new Error("run via `npx hardhat run`");
  const [deployer] = await web3.eth.getAccounts();
  console.log(`Deploying CLRebalanceHelper from ${deployer} on chainId ${await web3.eth.getChainId()}`);
  const res = await type2Transaction(CLRebalanceHelper.new);
  const addr = res.creates;
  const helper = await CLRebalanceHelper.at(addr);
  console.log("=====================================================");
  console.log("CLRebalanceHelper deployed at:", addr);
  console.log("=====================================================");
  // smoke-test the two views every vault depends on, against a known pool
  const POOL = "0xE846373C1a92B167b4E9cd5d8E4d6B1Db9E90EC7"; // EURC/USDC ts=50
  try {
    console.log("  spotSqrtPriceX96(EURC/USDC) =", (await helper.spotSqrtPriceX96(POOL)).toString());
    console.log("  poolFee(EURC/USDC)          =", (await helper.poolFee(POOL)).toString());
  } catch (e) {
    console.log("  smoke-test failed:", e.message.split("\n")[0]);
  }
  console.log('Set this as "rebalanceHelper" in every config that should share it.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
