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
const IERC4626 = artifacts.require("contracts/base/interface/IERC4626.sol:IERC4626");

const Strategy = artifacts.require("InactiveVaultERC4626StrategyMainnet_USDC");

// Developed and tested at blockNumber 37210850

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("Base Mainnet Inactive Vault ERC4626 USDC", function() {
  let accounts;

  // external contracts
  let underlying;
  let erc4626Vault;

  // external setup
  let underlyingWhale = "0xDDC976cB693fDa9c7570eC68Df397623E48815e9";

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
    underlying = await IERC20.at("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    // the plain ERC4626 vault the strategy parks the funds in
    erc4626Vault = await IERC4626.at("0xc0c5689e6f4D256E861F65465b691aeEcC0dEb12");
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
    await impersonates([governance, underlyingWhale]);

    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18});

    await setupExternalContracts();
    [controller, vault, strategy] = await setupCoreProtocol({
      "existingVaultAddress": null,
      "strategyArtifact": Strategy,
      "strategyArtifactIsUpgradable": true,
      "underlying": underlying,
      "governance": governance,
    });

    // whale send underlying to farmers
    await setupBalance();
  });

  describe("Happy path", function() {
    it("Farmer should not earn, all yield should be taken as fee", async function() {
      let farmerOldBalance = new BigNumber(await underlying.balanceOf(farmer1));
      await depositVault(farmer1, underlying, vault, farmerBalance);

      const rewardForwarder = await controller.rewardForwarder();
      const oldForwarderBalance = new BigNumber(await underlying.balanceOf(rewardForwarder));
      const oldErc4626Price = new BigNumber(await erc4626Vault.convertToAssets("1000000000000000000"));

      let hours = 10;
      let blocksPerHour = 5000;
      let oldSharePrice;
      let newSharePrice;

      // the vault is inactive: the share price has to stay flat over the whole period
      const initialSharePrice = new BigNumber(await vault.getPricePerFullShare());
      // tolerance of 1e-5 of the share price, to allow for rounding dust
      const sharePriceTolerance = initialSharePrice.div(1e5);

      for (let i = 0; i < hours; i++) {
        console.log("loop ", i);

        oldSharePrice = new BigNumber(await vault.getPricePerFullShare());
        await controller.doHardWork(vault.address, { from: governance });
        newSharePrice = new BigNumber(await vault.getPricePerFullShare());

        console.log("old shareprice: ", oldSharePrice.toFixed());
        console.log("new shareprice: ", newSharePrice.toFixed());
        console.log("pending fee:    ", new BigNumber(await strategy.pendingFee()).toFixed());

        // no yield may reach the depositors, only dust from rounding is tolerated
        let drift = newSharePrice.minus(initialSharePrice).abs();
        assert.equal(drift.lte(sharePriceTolerance), true,
          "share price moved by " + drift.toFixed() + ", started at " + initialSharePrice.toFixed());

        await Utils.advanceNBlock(blocksPerHour);
      }

      // the ERC4626 vault the funds are parked in did produce yield over the period
      const newErc4626Price = new BigNumber(await erc4626Vault.convertToAssets("1000000000000000000"));
      console.log("erc4626 price per share: ", oldErc4626Price.toFixed(), "->", newErc4626Price.toFixed());
      Utils.assertBNGt(newErc4626Price, oldErc4626Price);

      // and all of that yield left the strategy as fee
      const newForwarderBalance = new BigNumber(await underlying.balanceOf(rewardForwarder));
      console.log("reward forwarder gain (USDC): ", newForwarderBalance.minus(oldForwarderBalance).toFixed());
      Utils.assertBNGt(newForwarderBalance, oldForwarderBalance);

      // the fee log shows the full yield being charged as fee
      const feeLogs = await strategy.getPastEvents("PlatformFeeLogInReward", { fromBlock: 0, toBlock: "latest" });
      let platformFeeTotal = new BigNumber(0);
      let chargedProfitTotal = new BigNumber(0);
      for (const feeLog of feeLogs) {
        platformFeeTotal = platformFeeTotal.plus(feeLog.args.feeAmount);
        chargedProfitTotal = chargedProfitTotal.plus(feeLog.args.profitAmount);
      }
      console.log("yield charged as fee (USDC): ", chargedProfitTotal.toFixed());
      console.log("platform fee (USDC):         ", platformFeeTotal.toFixed());
      Utils.assertBNGt(chargedProfitTotal, 0);
      // the whole charged profit is fee, the reward forwarder on Base does not take a strategist
      // fee, so it is split between platform and profit sharing only
      const platformFeeNumerator = new BigNumber(await controller.platformFeeNumerator());
      const distributedNumerator = platformFeeNumerator.plus(new BigNumber(await controller.profitSharingNumerator()));
      const expectedPlatformFee = chargedProfitTotal.times(platformFeeNumerator).div(distributedNumerator);
      const feeSplitDiff = platformFeeTotal.minus(expectedPlatformFee).abs();
      assert.equal(feeSplitDiff.lte(1e3), true,
        "platform fee " + platformFeeTotal.toFixed() + " does not match the expected split " + expectedPlatformFee.toFixed());

      // nothing meaningful is left pending in the strategy
      console.log("pending fee left: ", new BigNumber(await strategy.pendingFee()).toFixed());

      await vault.withdraw(new BigNumber(await vault.balanceOf(farmer1)).toFixed(), { from: farmer1 });
      let farmerNewBalance = new BigNumber(await underlying.balanceOf(farmer1));
      console.log("farmer old balance: ", farmerOldBalance.toFixed());
      console.log("farmer new balance: ", farmerNewBalance.toFixed());

      // the farmer gets the deposit back, without any yield
      let balanceDiff = farmerNewBalance.minus(farmerOldBalance).abs();
      assert.equal(balanceDiff.lte(farmerOldBalance.div(1e5)), true,
        "farmer balance moved by " + balanceDiff.toFixed());
      Utils.assertBNGte(farmerOldBalance, farmerNewBalance);

      await strategy.withdrawAllToVault({from: governance}); // making sure can withdraw all for a next switch
    });
  });
});
