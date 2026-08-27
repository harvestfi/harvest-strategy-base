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

const Strategy = artifacts.require("IPORLendingStrategyMainnet_META");

// Developed and tested at blockNumber 50510000
//
// METAc carries a single byte of code on Base and is executed natively by the node,
// so a fork cannot run it. installTokenOverlay puts a plain ERC20 at its address and
// seeds the PlasmaVault with its live totalAssets. The PlasmaVault itself is the real one.

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("Base Mainnet IPOR Meta Carry Trade", function() {
  let accounts;

  // external contracts
  let underlying;

  // external setup
  let underlyingToken = "0xb2000000000000000000008bC8786B856E61707C";
  let plasmaVault = "0xCd19f18884bf388b866D05cDd1ae351133821F01";
  let liveTotalAssets = "1183782285";

  // parties in the protocol
  let governance;
  let farmer1;

  // numbers used in tests
  let farmerBalance = "10000000000"; // 100 METAc

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
      name: "Meta Platforms Inc.",
      symbol: "METAc",
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
