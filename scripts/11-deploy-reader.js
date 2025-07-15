const { type2Transaction } = require('./utils.js');
const ReaderCont = artifacts.require('Reader');
const addresses = require('../test/test-config.js');

async function main() {
  console.log("Deploy the Reader contract");

  const reader = await type2Transaction(ReaderCont.new);
  console.log("Reader deployed at:", reader.creates);

  console.log("Deployment complete.");
  await hre.run("verify:verify", {address: reader.creates}); 
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });