const prompt = require('prompt');
const hre = require("hardhat");
const { type2Transaction } = require('./utils.js');
const VaultProxy = artifacts.require('VaultProxy');
const Vault = artifacts.require('CLVault');
const IPosManager = artifacts.require('INonfungiblePositionManager');
const CLWrapper = artifacts.require('CLWrapper');

async function main() {
  console.log("Upgradable strategy deployment.");
  console.log("Specify a the vault address, and the strategy implementation's name");
  prompt.start();
  const addresses = require("../test/test-config.js");

  const {posId, posManager, targetWidth, strategyName} = await prompt.get(['posId', 'posManager', 'targetWidth', 'strategyName']);

  const vaultProxy = await type2Transaction(VaultProxy.new, addresses.CLVaultImplementation);
  const vaultAddr = vaultProxy.creates;
  const vault = await Vault.at(vaultAddr);

  console.log("Vault Proxy deployed at:", vaultAddr);

  const posManagerContract = await IPosManager.at(posManager);

  await type2Transaction(posManagerContract.approve, vaultAddr, posId);
  await type2Transaction(vault.initializeVault, addresses.Storage, posId, posManager, targetWidth);

  console.log("Vault initialized with CL position", posId);
  
  const StrategyImpl = artifacts.require(strategyName);
  const impl = await type2Transaction(StrategyImpl.new);

  console.log("Strategy Implementation deployed at:", impl.creates);

  const StrategyProxy = artifacts.require('StrategyProxy');
  const proxy = await type2Transaction(StrategyProxy.new, impl.creates);

  console.log("Strategy Proxy deployed at:", proxy.creates);

  const strategy = await StrategyImpl.at(proxy.creates);
  await type2Transaction(strategy.initializeStrategy, addresses.Storage, vaultAddr);

  console.log("Strategy initialized with vault", vaultAddr);

  // await type2Transaction(vault.setStrategy, proxy.creates);

  const wrapper0 = await type2Transaction(CLWrapper.new, addresses.Storage, vaultAddr, true);
  console.log("Wrapper 0 deployed at:", wrapper0.creates);
  const wrapper1 = await type2Transaction(CLWrapper.new, addresses.Storage, vaultAddr, false);
  console.log("Wrapper 1 deployed at:", wrapper1.creates);

  console.log("Deployment complete. New CL vault deployed and initialised at", vaultAddr);
  await hre.run("verify:verify", {address: impl.creates}); 
  await hre.run("verify:verify", {address: wrapper0.creates, constructorArguments: [addresses.Storage, vaultAddr, true]}); 
  await hre.run("verify:verify", {address: wrapper1.creates, constructorArguments: [addresses.Storage, vaultAddr, false]}); 
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });