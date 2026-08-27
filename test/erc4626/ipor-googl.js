// Utilities
const Utils = require("../utilities/Utils.js");
const {
  impersonates,
  setupCoreProtocol,
  depositVault,
} = require("../utilities/hh-utils.js");
const { installTokenOverlay } = require("../utilities/fork-erc20-overlay.js");

const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");
const IERC20 = artifacts.require("IERC20");

const Strategy = artifacts.require("IPORLendingStrategyMainnet_GOOGL");

// Developed and tested at blockNumber 50510000
//
// GOOGLc carries a single byte of code on Base and is executed natively by the node,
// so a fork cannot run it. installTokenOverlay puts a plain ERC20 at its address and
// seeds the PlasmaVault with its live totalAssets. The PlasmaVault itself is the real one.

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("Base Mainnet IPOR Google Carry Trade", function() {
  let accounts;

  // external contracts
  let underlying;

  // external setup
  let underlyingToken = "0xb2000000000000000000002D0BA3164cc74f58B7";
  let plasmaVault = "0x01DBDB9748ECf71B1fFbb62f5cB41318531bA362";
  let liveTotalAssets = "2877039180";

  // parties in the protocol
  let governance;
  let farmer1;

  // numbers used in tests
  let farmerBalance = "10000000000"; // 100 GOOGLc

  // Core protocol contracts
  let controller;
  let vault;
  let strategy;

  async function setupExternalContracts() {
    underlying = await IERC20.at(underlyingToken);
    console.log("Fetching Underlying at: ", underlying.address);
  }

  async function setupBalance(){
    await installTokenOverlay({
      token: underlyingToken,
      plasmaVault: plasmaVault,
      name: "Alphabet Inc.",
      symbol: "GOOGLc",
      decimals: 8,
      assetsInVault: liveTotalAssets,
      farmer: farmer1,
      farmerBalance: farmerBalance,
    });
  }

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();

    farmer1 = accounts[1];

    // impersonate accounts
    await impersonates([governance]);

    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18});

    // the overlay has to exist before the vault reads the token's symbol and decimals
    await setupBalance();
    await setupExternalContracts();

    [controller, vault, strategy] = await setupCoreProtocol({
      "existingVaultAddress": null,
      "strategyArtifact": Strategy,
      "strategyArtifactIsUpgradable": true,
      "underlying": underlying,
      "governance": governance,
    });
  });

  describe("Happy path", function() {
    it("Farmer should earn money", async function() {
      let farmerOldBalance = new BigNumber(await underlying.balanceOf(farmer1));
      await depositVault(farmer1, underlying, vault, farmerOldBalance);

      let hours = 25;
      let blocksPerHour = 5000;
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

        await Utils.advanceNBlock(blocksPerHour);
      }
      await vault.withdraw(new BigNumber(await vault.balanceOf(farmer1)).toFixed(), { from: farmer1 });
      let farmerNewBalance = new BigNumber(await underlying.balanceOf(farmer1));
      Utils.assertBNGte(farmerNewBalance, farmerOldBalance);

      console.log("earned!");

      await strategy.withdrawAllToVault({from:governance}); // making sure can withdraw all for a next switch
    });
  });
});
