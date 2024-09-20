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
const Strategy = artifacts.require("MoonwellFoldStrategyV2Mainnet_cbBTC");
const ComptrollerInterface = artifacts.require("ComptrollerInterface");

// Developed and tested at blockNumber 19687680

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("Arbitrum Mainnet Moonwell Fold CBETH", function() {
  let accounts;

  // external contracts
  let underlying;

  // external setup
  let underlyingWhale = "0xAc6BAF334dcE94fe009169bf0e328AF6177B16D2";
  let well = "0xA88594D404727625A9437C3f886C7643872296AE";
  let weth = "0x4200000000000000000000000000000000000006";
  let cbeth = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
  let guardian = "0x35b3314EA652899154BbfE937E3cCC2775ba712e";

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
    underlying = await IERC20.at("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf");
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
    await impersonates([governance, underlyingWhale, guardian]);

    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18});
    await web3.eth.sendTransaction({ from: etherGiver, to: guardian, value: 10e18});

    await setupExternalContracts();
    [controller, vault, strategy] = await setupCoreProtocol({
      "existingVaultAddress": null,
      "strategyArtifact": Strategy,
      "strategyArtifactIsUpgradable": true,
      "underlying": underlying,
      "governance": governance,
      "liquidation": [
        {"aerodrome": [well, weth, cbeth, underlying.address]},
      ]
    });

    // whale send underlying to farmers
    await setupBalance();

    const comptroller = await ComptrollerInterface.at("0xfBb21d0380beE3312B33c4353c8936a0F13EF26C")
    await comptroller._setMarketSupplyCaps(["0xF877ACaFA28c19b96727966690b2f44d35aD5976"], [10000000000], {from: guardian})
    await comptroller._setMarketBorrowCaps(["0xF877ACaFA28c19b96727966690b2f44d35aD5976"], [10000000000], {from: guardian})
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
