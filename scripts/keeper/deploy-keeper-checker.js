// Deploys KeeperChecker on the Storage whose governance is the msig and whose controller is the
// live Controller. No initializer: the constructor is the only setup, so there is no front-run
// window. Wiring (hardWorker, rebalanceExecutor, entries, keeper) is a separate governance batch:
// see docs/keeper-checker-migration.md and scripts/keeper/build-migration-batch.js.
//
//   npx hardhat run scripts/keeper/deploy-keeper-checker.js --network mainnet
//
// Re-run after a Basescan propagation delay (verify only, NO second deploy):
//
//   KEEPER_CHECKER=0x... npx hardhat run scripts/keeper/deploy-keeper-checker.js --network mainnet
//
// With KEEPER_CHECKER set the script deploys nothing: it verifies that address, then prints and
// asserts its governance() and controller(). (VERIFY_ONLY=1 is accepted as a no-op alias; the
// address is what switches the deploy off.)
const { type2Transaction } = require('../utils.js');
const KeeperChecker = artifacts.require('KeeperChecker');
const addresses = require('../../test/test-config.js');

const MSIG = "0x920b1aCb7618B553324aa0F71620226FA2e09870";
const CONTROLLER = "0xF90FF0F7c8Db52bF1bF869F74226eAD125EFa745";

async function main() {
  let address = (process.env.KEEPER_CHECKER || "").replace(/"/g, "").trim();
  if (address) {
    console.log("Reusing KeeperChecker at", address, "(no deploy)");
  } else {
    console.log("Deploy KeeperChecker on Storage", addresses.Storage);
    const checker = await type2Transaction(KeeperChecker.new, addresses.Storage);
    address = checker.creates;
    console.log("KeeperChecker deployed at:", address);
  }

  // Check the deployment first: a Basescan hiccup below must not hide a wrong governance/controller.
  const kc = await KeeperChecker.at(address);
  const governance = await kc.governance();
  const controller = await kc.controller();
  console.log("governance():", governance);
  console.log("controller():", controller);
  if (governance.toLowerCase() !== MSIG.toLowerCase()) throw new Error(`governance() is ${governance}, expected the msig ${MSIG}`);
  if (controller.toLowerCase() !== CONTROLLER.toLowerCase()) throw new Error(`controller() is ${controller}, expected ${CONTROLLER}`);
  console.log("OK: governance == msig, controller == Controller");

  try {
    await hre.run("verify:verify", { address, constructorArguments: [addresses.Storage] });
  } catch (error) {
    // Typically Basescan has not indexed the new contract yet. Exiting 1 here would invite a re-run
    // that deploys a SECOND checker, so report and exit 0.
    console.warn("Verification failed (non-fatal):", error.message || error);
    console.warn(`Re-run once Basescan has indexed it:\n  KEEPER_CHECKER=${address} VERIFY_ONLY=1 npx hardhat run scripts/keeper/deploy-keeper-checker.js --network mainnet`);
  }
  console.log("KEEPER_CHECKER=" + address);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
