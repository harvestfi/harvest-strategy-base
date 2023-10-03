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
const Strategy = artifacts.require("CurveStrategyMainnet_4pool");

// Developed and tested at blockNumber 4777500

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("Arbitrum Mainnet Curve 4pool", function() {
  let accounts;

  // external contracts
  let underlying;

  // external setup
  let underlyingWhale = "0x6dD8b1bD490e14bF3DA72450D6d6112276Ac986e";
  let crv = "0x8Ee73c484A26e0A5df2Ee2a4960B789967dd0415";
  let crvusd = "0x417Ac0e078398C154EdFadD9Ef675d30Be60Af93";
  let weth = "0x4200000000000000000000000000000000000006";
  let crvWhale = "0xf7Bd34Dd44B92fB2f9C3D2e31aAAd06570a853A6";
  let crvToken;

  // parties in the protocol
  let governance;
  let farmer1;

  // numbers used in tests
  let farmerBalance;

  // Core protocol contracts
  let controller;
  let vault;
  let strategy;

  async function setupExternalContracts() {
    underlying = await IERC20.at("0xf6C5F01C7F3148891ad0e19DF78743D31E390D1f");
    crvToken = await IERC20.at(crv);
    console.log("Fetching Underlying at: ", underlying.address);
  }

  async function setupBalance(){
    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: underlyingWhale, value: 10e18});

    farmerBalance = await underlying.balanceOf(underlyingWhale);
    await underlying.transfer(farmer1, farmerBalance, { from: underlyingWhale });
  }

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();

    farmer1 = accounts[1];

    // impersonate accounts
    await impersonates([governance, underlyingWhale, crvWhale]);

    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18});
    await web3.eth.sendTransaction({ from: etherGiver, to: crvWhale, value: 10e18});

    await setupExternalContracts();

    await crvToken.transfer(governance, new BigNumber(10000e18), {from: crvWhale});
    await crvToken.approve("0x22819ABfFeBfdD2ffF1a147741440068ca63Af33", new BigNumber(10000e18), {from: governance});

    [controller, vault, strategy] = await setupCoreProtocol({
      "existingVaultAddress": "0x492A07E2f2BD6a85597052f6497aC830DA0a5f63",
      "strategyArtifact": Strategy,
      "strategyArtifactIsUpgradable": true,
      "upgradeStrategy": true,
      "underlying": underlying,
      "governance": governance,
      "liquidation": [
        {"curve": [crv, crvusd]},
        {"curve": [crvusd, crv]},
        {"curve": [crv, crvusd, weth]},
      ]
    });

    // whale send underlying to farmers
    await setupBalance();

    await strategy.addRewardToken(crvusd);
  });

  describe("Happy path", function() {
    it("Farmer should earn money", async function() {
      let farmerOldBalance = new BigNumber(await underlying.balanceOf(farmer1));
      await depositVault(farmer1, underlying, vault, farmerBalance);

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
      await vault.withdraw(new BigNumber(await vault.balanceOf(farmer1)).toFixed(), { from: farmer1 });
      let farmerNewBalance = new BigNumber(await underlying.balanceOf(farmer1));
      Utils.assertBNGt(farmerNewBalance, farmerOldBalance);

      apr = (farmerNewBalance.toFixed()/farmerOldBalance.toFixed()-1)*(24/(blocksPerHour*hours/1800))*365;
      apy = ((farmerNewBalance.toFixed()/farmerOldBalance.toFixed()-1)*(24/(blocksPerHour*hours/1800))+1)**365;

      console.log("earned!");
      console.log("APR:", apr*100, "%");
      console.log("APY:", (apy-1)*100, "%");

      await strategy.withdrawAllToVault({from:governance}); // making sure can withdraw all for a next switch

    });
  });
});
