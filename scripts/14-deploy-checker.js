const { type2Transaction } = require('./utils.js');
const ChainlinkChecker = artifacts.require('ChainlinkChecker');
const addresses = require('../test/test-config.js');

async function main() {
  console.log("Deploy the ChainlinkChecker contract");

  const checker = await type2Transaction(ChainlinkChecker.new, addresses.Storage);
  console.log("ChainlinkChecker deployed at:", checker.creates);

  console.log("Deployment complete.");
  await hre.run("verify:verify", {address: checker.creates, constructorArguments: [addresses.Storage]}); 
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });