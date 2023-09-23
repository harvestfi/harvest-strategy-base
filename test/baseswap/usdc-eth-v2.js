// Utilities
const Utils = require("../utilities/Utils.js");
const {
  impersonates,
  setupCoreProtocol,
  depositVault,
} = require("../utilities/hh-utils.js");

const addresses = require("../test-config.js");
const { send } = require("@openzeppelin/test-helpers");
const BigNumber = require("bignumber.js");
const IERC20 = artifacts.require("IERC20");

//const Strategy = artifacts.require("");
const Strategy = artifacts.require("BaseSwapStrategyV2Mainnet_USDC_ETH");
const IXBSX = artifacts.require("IXToken");
const IVault = artifacts.require("IVault");

const D18 = new BigNumber(Math.pow(10, 18));

// Developed and tested at blockNumber 4297800

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("Base Mainnet BaseSwap ETH-USDC", function () {
  let accounts;

  // external contracts
  let underlying;

  // external setup
  let underlyingWhale = "0xF3158728B38D2A187d515ABbA908bDbBF18BdF0F";
  let baseswapGovernance = "0xAF1823bACd8EDDA3b815180a61F8741fA4aBc6Dd";
  let hodlVaultAddr = "0x40455352Dd3c5D65A40729C22B12265C17B37b75";
  let bsx = "0xd5046B976188EB40f6DE40fB527F89c05b323385";
  let weth = "0x4200000000000000000000000000000000000006";
  let usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  // parties in the protocol
  let governance;
  let ulOwner;
  let farmer1;

  // numbers used in tests
  let farmerBalance;

  // Core protocol contracts
  let controller;
  let vault;
  let strategy;
  let hodlVault;

  async function setupExternalContracts() {
    underlying = await IERC20.at("0xab067c01C7F5734da168C699Ae9d23a4512c9FdB");
    console.log("Fetching Underlying at: ", underlying.address);
  }

  async function setupBalance() {
    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: underlyingWhale, value: 10e18 });

    farmerBalance = await underlying.balanceOf(underlyingWhale);
    await underlying.transfer(farmer1, farmerBalance, { from: underlyingWhale });
  }

  before(async function () {
    governance = addresses.Governance;
    ulOwner = addresses.ULOwner;
    accounts = await web3.eth.getAccounts();

    farmer1 = accounts[1];

    // impersonate accounts
    await impersonates([governance, underlyingWhale, baseswapGovernance]);

    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18 });
    await web3.eth.sendTransaction({ from: etherGiver, to: baseswapGovernance, value: 10e18 });

    await setupExternalContracts();
    hodlVault = await IVault.at(hodlVaultAddr);
    [controller, vault, strategy, potPool] = await setupCoreProtocol({
      "existingVaultAddress": null,
      "strategyArtifact": Strategy,
      "strategyArtifactIsUpgradable": true,
      "underlying": underlying,
      "governance": governance,
      "rewardPool": true,
      "rewardPoolConfig": {
        type: 'PotPool',
        rewardTokens: [
          hodlVault.address,
        ]
      },
      "liquidation": [{ "baseswap": [bsx, weth, usdc] }],
      "ULOwner": ulOwner
    });

    await strategy.setPotPool(potPool.address, { from: governance });
    await potPool.setRewardDistribution([strategy.address], true, { from: governance });
    await controller.addToWhitelist(strategy.address, { from: governance });

    const xBSX = await IXBSX.at("0xE4750593d1fC8E74b31549212899A72162f315Fa");
    await xBSX.updateTransferWhitelist(hodlVault.address, true, { from: baseswapGovernance });

    // whale send underlying to farmers
    await setupBalance();
  });

  describe("Happy path", function () {
    it("Farmer should earn money", async function () {
      let farmerOldBalance = new BigNumber(await underlying.balanceOf(farmer1));
      let farmerOldHodlBalance = new BigNumber(await hodlVault.balanceOf(farmer1));
      await depositVault(farmer1, underlying, vault, farmerBalance);
      let fTokenBalance = new BigNumber(await vault.balanceOf(farmer1));

      let erc20Vault = await IERC20.at(vault.address);
      await erc20Vault.approve(potPool.address, fTokenBalance, { from: farmer1 });
      await potPool.stake(fTokenBalance, { from: farmer1 });

      let hours = 10;
      let blocksPerHour = 3600;
      let oldSharePrice;
      let newSharePrice;
      let oldHodlSharePrice;
      let newHodlSharePrice;
      let oldPotPoolBalance;
      let newPotPoolBalance;
      let hodlPrice;
      let underlyingPrice;
      let oldValue;
      let newValue;
      for (let i = 0; i < hours; i++) {
        console.log("loop ", i);

        oldSharePrice = new BigNumber(await vault.getPricePerFullShare());
        oldHodlSharePrice = new BigNumber(await hodlVault.getPricePerFullShare());
        oldPotPoolBalance = new BigNumber(await hodlVault.balanceOf(potPool.address));
        await controller.doHardWork(vault.address, { from: governance });
        await controller.doHardWork(hodlVault.address, { from: governance });
        newSharePrice = new BigNumber(await vault.getPricePerFullShare());
        newHodlSharePrice = new BigNumber(await hodlVault.getPricePerFullShare());
        newPotPoolBalance = new BigNumber(await hodlVault.balanceOf(potPool.address));

        hodlPrice = new BigNumber(0.7427).times(D18);
        underlyingPrice = new BigNumber(80028747.8).times(D18);
        console.log("Hodl price:", hodlPrice.toFixed() / D18.toFixed());
        console.log("Underlying price:", underlyingPrice.toFixed() / D18.toFixed());

        oldValue = (fTokenBalance.times(oldSharePrice).times(underlyingPrice)).div(1e36).plus((oldPotPoolBalance.times(oldHodlSharePrice).times(hodlPrice)).div(1e36));
        newValue = (fTokenBalance.times(newSharePrice).times(underlyingPrice)).div(1e36).plus((newPotPoolBalance.times(newHodlSharePrice).times(hodlPrice)).div(1e36));

        console.log("old value: ", oldValue.toFixed() / D18.toFixed());
        console.log("new value: ", newValue.toFixed() / D18.toFixed());
        console.log("growth: ", newValue.toFixed() / oldValue.toFixed());

        console.log("Hodl token in potpool: ", newPotPoolBalance.toFixed());

        apr = (newValue.toFixed() / oldValue.toFixed() - 1) * (24 / (blocksPerHour / 1800)) * 365;
        apy = ((newValue.toFixed() / oldValue.toFixed() - 1) * (24 / (blocksPerHour / 1800)) + 1) ** 365;

        console.log("instant APR:", apr * 100, "%");
        console.log("instant APY:", (apy - 1) * 100, "%");

        await Utils.advanceNBlock(blocksPerHour);
      }
      // withdrawAll to make sure no doHardwork is called when we do withdraw later.
      await vault.withdrawAll({ from: governance });

      // wait until all reward can be claimed by the farmer
      await Utils.waitTime(86400 * 30 * 1000);
      console.log("vaultBalance: ", fTokenBalance.toFixed());
      await potPool.exit({ from: farmer1 });
      await vault.withdraw(fTokenBalance.toFixed(), { from: farmer1 });
      let farmerNewBalance = new BigNumber(await underlying.balanceOf(farmer1));
      let farmerNewHodlBalance = new BigNumber(await hodlVault.balanceOf(farmer1));
      Utils.assertBNGte(farmerNewBalance, farmerOldBalance);
      Utils.assertBNGt(farmerNewHodlBalance, farmerOldHodlBalance);

      oldValue = (fTokenBalance.times(1e18).times(underlyingPrice)).div(1e36);
      newValue = (fTokenBalance.times(newSharePrice).times(underlyingPrice)).div(1e36).plus((farmerNewHodlBalance.times(newHodlSharePrice).times(hodlPrice)).div(1e36));

      apr = (newValue.toFixed() / oldValue.toFixed() - 1) * (24 / (blocksPerHour * hours / 300)) * 365;
      apy = ((newValue.toFixed() / oldValue.toFixed() - 1) * (24 / (blocksPerHour * hours / 300)) + 1) ** 365;

      console.log("Overall APR:", apr * 100, "%");
      console.log("Overall APY:", (apy - 1) * 100, "%");

      console.log("potpool totalShare: ", (new BigNumber(await potPool.totalSupply())).toFixed());
      console.log("Hodl token in potpool: ", (new BigNumber(await hodlVault.balanceOf(potPool.address))).toFixed());
      console.log("Farmer got hodl token from potpool: ", farmerNewHodlBalance.toFixed());
      console.log("earned!");

      await strategy.withdrawAllToVault({ from: governance }); // making sure can withdraw all for a next switch
    });
  });
});
