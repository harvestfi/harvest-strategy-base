// Utilities
const Utils = require("../utilities/Utils.js");
const {
  impersonates,
  setupCoreProtocol,
  depositVault,
} = require("../utilities/hh-utils.js");

const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");
const IERC20 = artifacts.require("IERC20");
const IUpgradeableStrategy = artifacts.require("IUpgradeableStrategy");

//const Strategy = artifacts.require("");
const Strategy = artifacts.require("AerodromeVolatileStrategyMainnet_GENOME_ETH");

// Developed and tested at blockNumber 13631345

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("Arbitrum Mainnet Aerodrome GENOME-ETH", function() {
  let accounts;

  // external contracts
  let underlying;

  // external setup
  let underlyingWhale = "0x889DcC719c347B86BD2786908056d69B95CCCCd9";
  let aero = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
  let weth = "0x4200000000000000000000000000000000000006";
  let genome = "0x1db0c569ebb4a8b57AC01833B9792F526305e062";

  // parties in the protocol
  let governance;
  let farmer1;
  let farmer2;

  // numbers used in tests
  let farmer1Balance;
  let farmer2Balance;

  // Core protocol contracts
  let controller;
  let vault;
  let strategy;

  async function setupExternalContracts() {
    underlying = await IERC20.at("0x963ceee215e5b0B1dCB221C3bA398De66abC73D9");
    console.log("Fetching Underlying at: ", underlying.address);
  }

  async function setupBalance(){
    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: underlyingWhale, value: 10e18});

    farmer1Balance = new BigNumber(await underlying.balanceOf(underlyingWhale)).div(10).times(9);
    farmer2Balance = new BigNumber(await underlying.balanceOf(underlyingWhale)).minus(farmer1Balance);
    await underlying.transfer(farmer1, farmer1Balance, { from: underlyingWhale });
    await underlying.transfer(farmer2, farmer2Balance, { from: underlyingWhale });
  }

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();

    farmer1 = accounts[1];
    farmer2 = accounts[2];

    // impersonate accounts
    await impersonates([governance, underlyingWhale]);

    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18});

    await setupExternalContracts();
    [controller, vault, strategy] = await setupCoreProtocol({
      "existingVaultAddress": "0x284c60490212DB0dc0b8F93503d35744f8053381",
      "strategyArtifact": Strategy,
      "strategyArtifactIsUpgradable": true,
      "announceStrategy": true,
      "underlying": underlying,
      "governance": governance,
      "liquidation": [
        // {"aerodrome": [aero, weth]},
        // {"aerodrome": [aero, weth, genome]},
      ]
    });

    // whale send underlying to farmers
    await setupBalance();

    const vaultAsUpgradable = await IUpgradeableStrategy.at(await vault.address);
    await vaultAsUpgradable.scheduleUpgrade("0x90188FEd247002e81dAC2Bc74f547C5e4f703c5D", { from: config.governance });
    console.log("Upgrade scheduled. Waiting...");
    await Utils.waitHours(13);
    await vaultAsUpgradable.upgrade({ from: config.governance });
    await vault.setInvestOnDeposit(true, {from: governance});
    console.log(await vault.investOnDeposit());
  });

  describe("Happy path", function() {
    it("Farmer should earn money", async function() {
      let farmerOldBalance = new BigNumber(await underlying.balanceOf(farmer1));
      await depositVault(farmer1, underlying, vault, farmerOldBalance.toFixed());

      let hours = 10;
      let blocksPerHour = 3600;
      let oldSharePrice;
      let newSharePrice;

      for (let i = 0; i < hours; i++) {
        console.log("loop ", i);

        let underlyingBalanceBef = new BigNumber(await underlying.balanceOf(farmer2));
        console.log("Deposit: ", underlyingBalanceBef.toFixed());
        oldSharePrice = new BigNumber(await vault.getPricePerFullShare());
        await depositVault(farmer2, underlying, vault, underlyingBalanceBef);
        let vaultBalance = new BigNumber(await vault.balanceOf(farmer2));
        newSharePrice = new BigNumber(await vault.getPricePerFullShare());

        console.log("dep shareprice: ", underlyingBalanceBef.times(1e18).div(vaultBalance).toFixed());
        console.log("old shareprice: ", oldSharePrice.toFixed());
        console.log("new shareprice: ", newSharePrice.toFixed());
        console.log("growth: ", newSharePrice.toFixed() / oldSharePrice.toFixed());

        oldSharePrice = new BigNumber(await vault.getPricePerFullShare());
        await controller.doHardWork(vault.address, { from: governance });
        newSharePrice = new BigNumber(await vault.getPricePerFullShare());

        await vault.withdraw(vaultBalance, { from: farmer2 });
        let underlyingBalanceAft = new BigNumber(await underlying.balanceOf(farmer2));
        console.log("Withdraw:", underlyingBalanceAft.toFixed());

        console.log("old shareprice: ", oldSharePrice.toFixed());
        console.log("new shareprice: ", newSharePrice.toFixed());
        console.log("growth: ", newSharePrice.toFixed() / oldSharePrice.toFixed());
        console.log("check:  ", underlyingBalanceAft.toFixed() / underlyingBalanceBef.toFixed());

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
