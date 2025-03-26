const { type2Transaction } = require('./utils.js');
const DripContr = artifacts.require('Drip');
const addresses = require('../test/test-config.js');

async function main() {
  console.log("Deploy the Drip contract");

  const drip = await type2Transaction(DripContr.new, addresses.Storage);
  console.log("Drip deployed at:", drip.creates);

  console.log("Deployment complete.");
  await hre.run("verify:verify", {address: drip.creates, constructorArguments: [addresses.Storage]}); 
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });