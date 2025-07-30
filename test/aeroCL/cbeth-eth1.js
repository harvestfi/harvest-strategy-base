// Utilities
const Utils = require("../utilities/Utils.js");
const {
  impersonates,
  setupCoreProtocol,
} = require("../utilities/hh-utils.js");

const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");

//const Strategy = artifacts.require("");
const Strategy = artifacts.require("AerodromeCLStrategyMainnet_cbETH_ETH1");
const IERC721 = artifacts.require("IERC721");

// Developed and tested at blockNumber 32896930

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("CL test", function() {
  let accounts;

  // external setup
  let underlyingWhale = "0x6a74649aCFD7822ae8Fb78463a9f2192752E5Aa2";
  let posId = 19447757
  let posManager = "0x827922686190790b37229fd06084350E74485b72";
//   let aero = "0x940181a94A35A4569E4529A3CDfB74e38FD98631"
//   let superoeth = "0xDBFeFD2e8460a6Ee4955A68582F85708BAEA60A3"

  // parties in the protocol
  let governance;
  let farmer1;

  // Core protocol contracts
  let controller;
  let vault;
  let strategy;

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();

    farmer1 = governance;

    // impersonate accounts
    await impersonates([governance, underlyingWhale]);

    const nftToken = await IERC721.at(posManager);
    await nftToken.transferFrom(underlyingWhale, governance, posId, { from: underlyingWhale });

    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18});

    [controller, vault, strategy] = await setupCoreProtocol({
      "CLVault": true,
      "CLSetup": {
        posId: posId,
        posManager: posManager,
        targetWidth: 1,
      },
      "existingVaultAddress": null,
      "strategyArtifact": Strategy,
      "strategyArtifactIsUpgradable": true,
      "governance": governance,
    //   "liquidation": [
    //     {"aerodrome": [aero, superoeth]},
    //   ]
    });

    let sqrtPrice = new BigNumber(await vault.getSqrtPriceX96())
    let tick = new BigNumber(await vault.getCurrentTick())
    let inRange = await vault.inRange()
    let amounts = await vault.getCurrentTokenAmounts()
    let weights = await vault.getCurrentTokenWeights()

    console.log(sqrtPrice.toFixed())
    console.log(tick.toFixed())
    console.log(inRange)
    console.log(new BigNumber(amounts[0]).toFixed(), new BigNumber(amounts[1]).toFixed())
    console.log(new BigNumber(weights[0]).toFixed(), new BigNumber(weights[1]).toFixed())
  });

  describe("Happy path", function() {
    it("Farmer should earn money", async function() {
      let sharePrice = new BigNumber(await vault.getPricePerFullShare());
      let farmerOldBalance = new BigNumber(await vault.balanceOf(farmer1)).times(sharePrice).div(1e18);

      let hours = 10;
      let blocksPerHour = 3600;
      let oldSharePrice;
      let newSharePrice;

      for (let i = 0; i < hours; i++) {
        console.log("loop ", i);

        oldSharePrice = new BigNumber(await vault.getPricePerFullShare());
        await controller.doHardWork(vault.address, { from: governance });
        newSharePrice = new BigNumber(await vault.getPricePerFullShare());

        console.log("old shareprice: ", oldSharePrice.toFixed());
        console.log("new shareprice: ", newSharePrice.toFixed());
        console.log("growth: ", newSharePrice.toFixed() / oldSharePrice.toFixed());

        apr = (newSharePrice.toFixed()/oldSharePrice.toFixed()-1)*(24/(blocksPerHour/1800))*365;
        apy = ((newSharePrice.toFixed()/oldSharePrice.toFixed()-1)*(24/(blocksPerHour/1800))+1)**365;

        console.log("instant APR:", apr*100, "%");
        console.log("instant APY:", (apy-1)*100, "%");

        await Utils.advanceNBlock(blocksPerHour);
      }
      sharePrice = new BigNumber(await vault.getPricePerFullShare());
      let farmerNewBalance = new BigNumber(await vault.balanceOf(farmer1)).times(sharePrice).div(1e18);
      Utils.assertBNGt(farmerNewBalance, farmerOldBalance);

      apr = (farmerNewBalance.toFixed()/farmerOldBalance.toFixed()-1)*(24/(blocksPerHour*hours/1800))*365;
      apy = ((farmerNewBalance.toFixed()/farmerOldBalance.toFixed()-1)*(24/(blocksPerHour*hours/1800))+1)**365;

      console.log("earned!");
      console.log("APR:", apr*100, "%");
      console.log("APY:", (apy-1)*100, "%");

      await strategy.withdrawAllToVault(true, { from: governance }); // making sure can withdraw all for a next switch
    });
  });
});