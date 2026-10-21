// Deploys KeeperChecker on the Storage whose governance is the msig and whose controller is the
// live Controller. No initializer: the constructor is the only setup, so there is no front-run
// window. Wiring (hardWorker, rebalanceExecutor, entries, keeper) is a separate governance batch:
// see docs/keeper-checker-migration.md and scripts/keeper/build-migration-batch.js.
//
//   npx hardhat run scripts/keeper/deploy-keeper-checker.js --network mainnet
const { type2Transaction } = require('../utils.js');
const KeeperChecker = artifacts.require('KeeperChecker');
const addresses = require('../../test/test-config.js');

async function main() {
  console.log("Deploy KeeperChecker on Storage", addresses.Storage);
  const checker = await type2Transaction(KeeperChecker.new, addresses.Storage);
  console.log("KeeperChecker deployed at:", checker.creates);
  await hre.run("verify:verify", { address: checker.creates, constructorArguments: [addresses.Storage] });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
