
const prompt = require('prompt');
const hre = require("hardhat");
const { type2Transaction } = require('./utils.js');

async function main() {
  console.log("New implementation deployment.");
  console.log("Specify the implementation contract's name");
  prompt.start();

  const {implName} = await prompt.get(['implName']);

  const ImplContract = artifacts.require(implName);

  // Some strategies delegatecall an external library (e.g. AaveReserveLib) to
  // stay under the EIP-170 code-size limit. Their compiled bytecode still
  // carries `__$<hash>$__` placeholders where the library address belongs, and
  // those characters are not valid hex - deploying without linking fails with
  // "invalid hexlify value". Resolve every link reference before deploying.
  const artifact = await hre.artifacts.readArtifact(implName);
  const libNames = Object.values(artifact.linkReferences || {}).flatMap(Object.keys);

  const libraries = {};
  if (libNames.length > 0) {
    console.log(`${implName} links: ${libNames.join(", ")}`);
    console.log("Give each library's already-deployed address (or preset it as an env var of the same name).");

    const missing = libNames.filter((name) => !process.env[name]);
    const answers = missing.length > 0 ? await prompt.get(missing) : {};

    for (const name of libNames) {
      const address = process.env[name] || answers[name];
      if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) {
        throw new Error(`${name}: "${address}" is not a valid address.`);
      }
      if (await hre.ethers.provider.getCode(address) === "0x") {
        throw new Error(`${name}: no contract deployed at ${address} on this network.`);
      }
      ImplContract.link(await artifacts.require(name).at(address));
      libraries[name] = address;
      console.log(`  ${name} -> ${address}`);
    }
  }

  const impl = await type2Transaction(ImplContract.new);

  console.log("Deployment complete. Implementation deployed at:", impl.creates);

  // The deploy is already on-chain by this point; a verification hiccup (the
  // explorer commonly lags a fresh deploy) must not look like a failed deploy,
  // because re-running this script would deploy a second implementation.
  try {
    await hre.run("verify:verify", {
      address: impl.creates,
      ...(libNames.length > 0 ? {libraries} : {}),
    });
  } catch (e) {
    console.log("\nVerification failed - the DEPLOY still succeeded. Do NOT re-run this script.");
    console.log("Reason:", e.message.split("\n")[0]);
    console.log("Re-verify once the deploy has a few confirmations:");
    console.log(`  npx hardhat verify --network <network> ${impl.creates}`);
    if (libNames.length > 0) {
      console.log(`  (library-linked: use the verify:verify task with libraries = ${JSON.stringify(libraries)})`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
