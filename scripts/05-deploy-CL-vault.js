const prompt = require('prompt');
const hre = require("hardhat");
const { type2Transaction } = require('./utils.js');
const VaultProxy = artifacts.require('VaultProxy');
const Vault = artifacts.require('CLVault');
const IPosManager = artifacts.require('INonfungiblePositionManager');

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

  await type2Transaction(vault.setStrategy, proxy.creates);

  console.log("Deployment complete. New CL vault deployed and initialised at", vaultAddr);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
