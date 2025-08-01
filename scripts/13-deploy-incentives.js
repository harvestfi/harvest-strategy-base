const { type2Transaction } = require('./utils.js');
const IncentivesCont = artifacts.require('IncentivesGeneral');
const addresses = require('../test/test-config.js');

async function main() {
  console.log("Deploy the Incentives contract");

  const incentives = await type2Transaction(IncentivesCont.new, addresses.Storage);
  console.log("Incentives deployed at:", incentives.creates);

  console.log("Deployment complete.");
  await hre.run("verify:verify", {address: incentives.creates, constructorArguments: [addresses.Storage]}); 
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });