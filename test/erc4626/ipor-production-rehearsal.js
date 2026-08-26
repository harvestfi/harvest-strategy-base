// Dry run of the exact production sequence for the IPOR WETH vault, against live
// mainnet state on a fork. Nothing is stubbed: no setupCoreProtocol, no artificial
// liquidator paths, no strategy re-deploy from scratch. Every call below is one the
// Harvest governance Safe will make for real, in this order.
//
//   1. deploy IPORLendingStrategyMainnet_ETH   (new strategy implementation)
//   2. deploy HookVaultV2                      (new vault implementation)
//   3. strategy.scheduleUpgrade(strategyImpl)  - governance
//   4. vault.scheduleUpgrade(vaultImpl)        - governance
//   5. wait nextImplementationDelay (12h)
//   6. StrategyProxy(strategy).upgrade()       - governance
//   7. VaultProxy(vault).upgrade()             - governance
//   8. vault.setCompoundOnWithdraw(true)       - governance
//
// Steps 3-4 and 6-7 are order-independent: a hooked strategy under a stock vault is
// never asked for the hook, and a hooked vault over a stock strategy falls back to
// doHardWork(). Only step 8 depends on both being live.
//
// Developed and tested at blockNumber 49260800

const Utils = require("../utilities/Utils.js");
const { impersonates } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");
const { ethers, network } = require("hardhat");

const IERC20 = artifacts.require("IERC20");
const IController = artifacts.require("IController");
const Strategy = artifacts.require("IPORLendingStrategyMainnet_ETH");
const IUpgradeableStrategy = artifacts.require("IUpgradeableStrategy");
const StrategyProxy = artifacts.require("StrategyProxy");
const VaultProxy = artifacts.require("VaultProxy");
const VaultV2 = artifacts.require("VaultV2");
const HookVaultV2 = artifacts.require("HookVaultV2");

const VAULT = "0xA912d926E7c7ac44BE2280bA4247DF1FB4ef02AE";
const STRAT = "0xce5833251fCc922acF0e21C50D9A2bcCB1202704";
const CONTROLLER = "0xF90FF0F7c8Db52bF1bF869F74226eAD125EFa745";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const usdcWhale = "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

describe("IPOR WETH vault - production rehearsal", function () {
  let governance, farmer, controller, weth, usdc;
  let strategyImpl, vaultImpl;
  let pre = {};
  let preVaultImpl, preStrategyImpl;

  async function implOf(proxy) {
    return "0x" + (await ethers.provider.getStorageAt(proxy, IMPL_SLOT)).slice(26);
  }

  async function snapshotVaultState() {
    const v = await VaultV2.at(VAULT);
    return {
      strategy: (await v.strategy()).toLowerCase(),
      controller: (await v.controller()).toLowerCase(),
      underlying: (await v.underlying()).toLowerCase(),
      totalSupply: (await v.totalSupply()).toString(),
      name: await v.name(),
      symbol: await v.symbol(),
      decimals: (await v.decimals()).toString(),
      pps: (await v.getPricePerFullShare()).toString(),
      tvl: (await v.underlyingBalanceWithInvestment()).toString(),
      investOnDeposit: await v.investOnDeposit(),
      fracNum: (await v.vaultFractionToInvestNumerator()).toString(),
      fracDen: (await v.vaultFractionToInvestDenominator()).toString(),
    };
  }

  before(async function () {
    governance = addresses.Governance;
    const accounts = await web3.eth.getAccounts();
    farmer = accounts[1];
    await impersonates([governance, usdcWhale]);
    for (const to of [governance, usdcWhale]) {
      await web3.eth.sendTransaction({ from: accounts[9], to, value: 10e18 });
    }
    controller = await IController.at(CONTROLLER);
    weth = await IERC20.at(WETH);
    usdc = await IERC20.at(USDC);

    const w = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)"],
      WETH, await ethers.getSigner(farmer));
    await (await w.deposit({ value: ethers.utils.parseEther("40") })).wait();
    await (await w.approve(VAULT, ethers.constants.MaxUint256)).wait();

    pre = await snapshotVaultState();
    preVaultImpl = await implOf(VAULT);
    preStrategyImpl = await implOf(STRAT);
    console.log("   live vault impl   :", await implOf(VAULT));
    console.log("   live strategy impl:", await implOf(STRAT));
    console.log("   TVL:", pre.tvl, "pps:", pre.pps);
  });

  it("step 1-2: deploys both implementations", async function () {
    strategyImpl = await Strategy.new({ from: governance });
    vaultImpl = await HookVaultV2.new({ from: governance });
    console.log("   strategy impl:", strategyImpl.address);
    console.log("   vault impl   :", vaultImpl.address);

    const code = await ethers.provider.getCode(vaultImpl.address);
    const size = (code.length - 2) / 2;
    console.log("   HookVaultV2 deployed size:", size, "bytes (EIP-170 limit 24576)");
    assert.isBelow(size, 24576);
  });

  it("step 3-4: governance schedules both upgrades", async function () {
    await (await IUpgradeableStrategy.at(STRAT)).scheduleUpgrade(strategyImpl.address, { from: governance });
    await (await VaultV2.at(VAULT)).scheduleUpgrade(vaultImpl.address, { from: governance });

    // Nothing has changed yet - the timelock has not elapsed.
    assert.equal(await implOf(VAULT), preVaultImpl, "vault impl must not change on schedule");
    assert.equal(await implOf(STRAT), preStrategyImpl, "strategy impl must not change on schedule");
    const shouldV = await (await VaultV2.at(VAULT)).shouldUpgrade();
    assert.isFalse(shouldV[0], "upgrade must not be ready before the delay elapses");
    console.log("   both scheduled; impls unchanged, shouldUpgrade() still false");
  });

  it("step 5-7: after 12h, both proxies upgrade and vault state is preserved exactly", async function () {
    await Utils.waitHours(13);
    await (await StrategyProxy.at(STRAT)).upgrade({ from: governance });
    await (await VaultProxy.at(VAULT)).upgrade({ from: governance });

    assert.equal((await implOf(STRAT)).toLowerCase(), strategyImpl.address.toLowerCase());
    assert.equal((await implOf(VAULT)).toLowerCase(), vaultImpl.address.toLowerCase());
    console.log("   vault impl now   :", await implOf(VAULT));
    console.log("   strategy impl now:", await implOf(STRAT));

    const after = await snapshotVaultState();
    for (const k of Object.keys(pre)) {
      // pps and tvl move with accrued interest over the 12h wait; everything else is identity.
      if (k === "pps" || k === "tvl") continue;
      assert.equal(String(after[k]), String(pre[k]), `vault field ${k} changed across the upgrade`);
    }
    Utils.assertBNGte(new BigNumber(after.pps), new BigNumber(pre.pps));
    console.log("   all identity fields preserved; pps", pre.pps, "->", after.pps);

    const s = await Strategy.at(STRAT);
    assert.isTrue(await s.supportsHardWorkHooks(), "strategy should now advertise the hook");
  });

  it("step 8: enabling compoundOnWithdraw does not break withdrawals", async function () {
    const vault = await HookVaultV2.at(VAULT);
    assert.isFalse(await vault.compoundOnWithdraw(), "precondition: currently off in production");
    await vault.setCompoundOnWithdraw(true, { from: governance });
    assert.isTrue(await vault.compoundOnWithdraw());

    await vault.methods["deposit(uint256)"]("20000000000000000000", { from: farmer });
    await network.provider.send("evm_mine");

    // Arm the path that used to revert: rewards to liquidate at withdrawal time.
    await usdc.transfer(STRAT, "50000000", { from: usdcWhale });
    await Utils.waitHours(25);

    const shares = (await vault.balanceOf(farmer)).toString();
    const b0 = new BigNumber(await weth.balanceOf(farmer));
    await vault.methods["withdraw(uint256)"](shares, { from: farmer });
    const b1 = new BigNumber(await weth.balanceOf(farmer));
    console.log("   farmer WETH", b0.toFixed(), "->", b1.toFixed());
    Utils.assertBNGt(b1, b0);
  });

  it("post-upgrade: keeper harvest still works with mainnet liquidator routes only", async function () {
    await usdc.transfer(STRAT, "50000000", { from: usdcWhale });
    await Utils.waitHours(25);
    const idleBefore = new BigNumber(await weth.balanceOf(STRAT));
    const usdcBefore = new BigNumber(await usdc.balanceOf(STRAT));

    await controller.doHardWork(VAULT, { from: governance });

    const usdcAfter = new BigNumber(await usdc.balanceOf(STRAT));
    console.log("   strategy USDC", usdcBefore.toFixed(), "->", usdcAfter.toFixed());
    console.log("   strategy idle WETH", idleBefore.toFixed(), "->", (await weth.balanceOf(STRAT)).toString());
    assert.isTrue(usdcAfter.lt(usdcBefore), "rewards should liquidate through the live UL routes");
  });

  it("post-upgrade: investOnDeposit still deploys into IPOR in the deposit tx", async function () {
    const vault = await HookVaultV2.at(VAULT);
    const s = await Strategy.at(STRAT);
    assert.isTrue(await vault.investOnDeposit());

    const posBefore = new BigNumber(await s.currentBalance());
    await vault.methods["deposit(uint256)"]("10000000000000000000", { from: farmer });
    const posAfter = new BigNumber(await s.currentBalance());
    console.log("   fToken position", posBefore.toFixed(), "->", posAfter.toFixed());
    Utils.assertBNGt(posAfter, posBefore);
    assert.isTrue(posAfter.minus(posBefore).gte("9000000000000000000"),
      "the deposit should have been supplied to IPOR");
  });
});
