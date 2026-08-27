// HookVaultV2 must be a drop-in replacement for VaultV2 when the strategy does NOT
// implement IHardWorkHooks: the hook probe fails, the vault falls back to
// IStrategy.doHardWork(), and behaviour is identical to the stock implementation.
//
// Exercised against a live Morpho vault whose strategy has no hooks, with both
// investOnDeposit and compoundOnWithdraw enabled so the fallback is actually reached.
//
// Developed and tested at blockNumber 49260800

const Utils = require("../utilities/Utils.js");
const { impersonates } = require("../utilities/hh-utils.js");

const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");
const { ethers, network } = require("hardhat");

const IERC20 = artifacts.require("IERC20");
const VaultV2 = artifacts.require("VaultV2");
const HookVaultV2 = artifacts.require("HookVaultV2");
const VaultProxy = artifacts.require("VaultProxy");
const IController = artifacts.require("IController");

// Morpho Moonwell USDC vault - a plain strategy with no hard work hooks.
const VAULT = "0x9C012E4fe655b90839e1b65a461B72813c9ac2A4";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_WHALE = "0xDDC976cB693fDa9c7570eC68Df397623E48815e9";

describe("HookVaultV2 fallback for strategies without hooks", function () {
  let accounts, governance, farmer;
  let usdc, stockVault, hookVault, strategy, controller;

  async function depositAndWithdraw(vaultInstance, label) {
    const amount = "1000000000"; // 1,000 USDC
    const before = new BigNumber(await usdc.balanceOf(farmer));
    await vaultInstance.methods["deposit(uint256)"](amount, { from: farmer });
    const shares = (await vaultInstance.balanceOf(farmer)).toString();
    await vaultInstance.methods["withdraw(uint256)"](shares, { from: farmer });
    const after = new BigNumber(await usdc.balanceOf(farmer));
    const delta = after.minus(before);
    console.log(`  ${label}: shares minted ${shares}, USDC delta ${delta.toFixed()}`);
    return { shares, delta };
  }

  before(async function () {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();
    farmer = accounts[1];

    await impersonates([governance, USDC_WHALE]);
    const etherGiver = accounts[9];
    for (const to of [governance, USDC_WHALE]) {
      await web3.eth.sendTransaction({ from: etherGiver, to, value: 10e18 });
    }

    usdc = await IERC20.at(USDC);
    stockVault = await VaultV2.at(VAULT);
    controller = await IController.at(await stockVault.controller());
    strategy = await stockVault.strategy();

    await usdc.transfer(farmer, "10000000000", { from: USDC_WHALE });
    await usdc.approve(VAULT, "10000000000", { from: farmer });

    // Force both flags on so the hard work call inside _deposit/_withdraw is reached.
    await stockVault.setInvestOnDeposit(true, { from: governance });
    await stockVault.setCompoundOnWithdraw(true, { from: governance });
    console.log("Vault:", VAULT, "strategy:", strategy);
  });

  it("the strategy genuinely has no hooks", async function () {
    // Mirror HookVaultV2._supportsHardWorkHooks exactly: a proxy without the function
    // may return empty data instead of reverting, which must read as "not supported".
    let supported = false;
    try {
      const data = await ethers.provider.call({
        to: strategy,
        data: ethers.utils.id("supportsHardWorkHooks()").slice(0, 10),
      });
      supported = ethers.utils.hexDataLength(data) === 32 &&
        ethers.utils.defaultAbiCoder.decode(["bool"], data)[0];
    } catch (e) {
      supported = false;
    }
    console.log("  strategy advertises hooks:", supported);
    assert.isFalse(supported, "this test needs a strategy WITHOUT the hooks");
  });

  it("produces the same result on HookVaultV2 as on stock VaultV2", async function () {
    // The upgrade path burns 13 hours on the timelock, and the underlying Morpho vault
    // accrues in that time. Give both runs the same elapsed time so the only difference
    // measured is the vault implementation.
    // Schedule before snapshotting so both branches run from the same state and the
    // same transaction count - the underlying Morpho vault accrues per block, so an
    // extra transaction on one side alone would show up as a rounding difference.
    const impl = await HookVaultV2.new({ from: governance });
    await stockVault.scheduleUpgrade(impl.address, { from: governance });

    const snapshot = await network.provider.send("evm_snapshot");
    await Utils.waitHours(13);
    await network.provider.send("evm_mine"); // stands in for the upgrade() transaction
    const stock = await depositAndWithdraw(stockVault, "stock VaultV2   ");
    await network.provider.send("evm_revert", [snapshot]);

    await Utils.waitHours(13);
    await (await VaultProxy.at(VAULT)).upgrade({ from: governance });
    hookVault = await HookVaultV2.at(VAULT);
    const hooked = await depositAndWithdraw(hookVault, "HookVaultV2     ");

    assert.equal(hooked.shares, stock.shares, "share mint must be identical");
    assert.equal(hooked.delta.toFixed(), stock.delta.toFixed(), "USDC returned must be identical");
  });

  it("still lets the keeper harvest through HookVaultV2", async function () {
    const ppsBefore = new BigNumber(await hookVault.getPricePerFullShare());
    await Utils.advanceNBlock(100);
    await controller.doHardWork(VAULT, { from: governance });
    const ppsAfter = new BigNumber(await hookVault.getPricePerFullShare());
    console.log("  pps", ppsBefore.toFixed(), "->", ppsAfter.toFixed());
    assert.isTrue(ppsAfter.gte(ppsBefore), "share price must not fall across a harvest");
  });
});
