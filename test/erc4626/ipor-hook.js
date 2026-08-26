// Verifies the compoundOnWithdraw fix against the live IPOR WETH vault.
//
// IPOR PlasmaVaults lock the depositing account against redemption until
// block.timestamp + REDEMPTION_DELAY_IN_SECONDS (currently 1). With compoundOnWithdraw
// on, VaultV1._withdraw calls doHardWork() - which ends by depositing into the fToken -
// and then redeems from that same fToken in the same transaction, which the lock rejects
// with AccountIsLocked(uint256).
//
// HookVaultV2 + IHardWorkHooks give the withdrawal path doHardWorkOnWithdraw(), which
// credits the exiting user the same accrued interest without the deposit.
//
// The deposit path is intentionally NOT changed: investOnDeposit still runs the full
// doHardWork(), deposit included.
//
// Developed and tested at blockNumber 49260800

const Utils = require("../utilities/Utils.js");
const { impersonates, setupCoreProtocol } = require("../utilities/hh-utils.js");

const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");
const { ethers, network } = require("hardhat");

const IERC20 = artifacts.require("IERC20");
const Strategy = artifacts.require("IPORLendingStrategyMainnet_ETH");
const HookVaultV2 = artifacts.require("HookVaultV2");
const VaultV2 = artifacts.require("VaultV2");
const VaultProxy = artifacts.require("VaultProxy");

const VAULT = "0xA912d926E7c7ac44BE2280bA4247DF1FB4ef02AE";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FARM = "0xD08a2917653d4E460893203471f0000826fb4034";
const LOCKED = "0xa592703b"; // AccountIsLocked(uint256)

describe("Base Mainnet IPOR Lending ETH - compoundOnWithdraw", function () {
  let accounts, governance, farmer1, farmer2;
  let underlying, usdcToken;
  let controller, vault, strategy;

  let usdcWhale = "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a";

  async function upgradeVaultTo(artifact) {
    const impl = await artifact.new({ from: governance });
    const asVault = await VaultV2.at(VAULT);
    await asVault.scheduleUpgrade(impl.address, { from: governance });
    await Utils.waitHours(13);
    await (await VaultProxy.at(VAULT)).upgrade({ from: governance });
    return artifact.at(VAULT);
  }

  // Arms the path under test: idle underlying and pending rewards in the strategy, so
  // the withdrawal's hard work has something to liquidate and (pre-fix) to deposit.
  async function armStrategy() {
    await underlying.transfer(strategy.address, "10000000000000000", { from: farmer1 });
    await usdcToken.transfer(strategy.address, "5000000", { from: usdcWhale });
  }

  async function revertDataOf(txHash) {
    const tr = await network.provider.send("debug_traceTransaction", [txHash]);
    const rv = tr.returnValue || "";
    return rv.startsWith("0x") ? rv : "0x" + rv;
  }

  before(async function () {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();
    farmer1 = accounts[1];
    farmer2 = accounts[2];

    await impersonates([governance, usdcWhale]);
    const etherGiver = accounts[9];
    for (const to of [governance, usdcWhale]) {
      await web3.eth.sendTransaction({ from: etherGiver, to, value: 10e18 });
    }

    underlying = await IERC20.at(WETH);
    usdcToken = await IERC20.at(USDC);

    [controller, vault, strategy] = await setupCoreProtocol({
      existingVaultAddress: VAULT,
      strategyArtifact: Strategy,
      strategyArtifactIsUpgradable: true,
      upgradeStrategy: true,
      underlying: underlying,
      governance: governance,
      liquidation: [{ aerodrome: [FARM, WETH] }],
    });

    // Fund the farmers by wrapping ETH.
    const weth = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)"], WETH);
    for (const f of [farmer1, farmer2]) {
      const signer = await ethers.getSigner(f);
      await (await weth.connect(signer).deposit({ value: ethers.utils.parseEther("50") })).wait();
      await (await weth.connect(signer).approve(VAULT, ethers.constants.MaxUint256)).wait();
    }

    // Both flags on. investOnDeposit is left as-is by this change; compoundOnWithdraw is
    // the one being fixed.
    await vault.setInvestOnDeposit(true, { from: governance });
    await vault.setCompoundOnWithdraw(true, { from: governance });
  });

  it("control: compoundOnWithdraw reverts on stock VaultV2", async function () {
    const stockVault = await VaultV2.at(VAULT);
    await stockVault.methods["deposit(uint256)"]("5000000000000000000", { from: farmer2 });
    await network.provider.send("evm_mine");
    await armStrategy();

    const shares = (await stockVault.balanceOf(farmer2)).toString();
    const v = await ethers.getContractAt("VaultV2", VAULT, await ethers.getSigner(farmer2));

    let message = "";
    try {
      await v["withdraw(uint256)"](shares, { gasLimit: 6000000 });
    } catch (e) {
      message = e.message || "";
    }
    console.log("  stock VaultV2 withdraw reverted:", message.slice(0, 140));
    assert.notEqual(message, "", "precondition: this is the bug being fixed - it must revert");
    assert.include(message, LOCKED.slice(2), "should revert with AccountIsLocked");
  });

  it("the same withdrawal succeeds on HookVaultV2", async function () {
    vault = await upgradeVaultTo(HookVaultV2);
    assert.isTrue(await strategy.supportsHardWorkHooks());
    assert.isTrue(await vault.compoundOnWithdraw());

    await armStrategy();
    const shares = (await vault.balanceOf(farmer2)).toString();
    const before = new BigNumber(await underlying.balanceOf(farmer2));
    await vault.methods["withdraw(uint256)"](shares, { from: farmer2 });
    const after = new BigNumber(await underlying.balanceOf(farmer2));

    console.log("  farmer2 WETH", before.toFixed(), "->", after.toFixed());
    Utils.assertBNGt(after, before);
    assert.equal((await vault.balanceOf(farmer2)).toString(), "0");
  });

  it("still credits the withdrawing user the interest accrued since the last hard work", async function () {
    await vault.methods["deposit(uint256)"]("5000000000000000000", { from: farmer1 });
    const shares = (await vault.balanceOf(farmer1)).toString();

    // Grow the strategy's fToken position without touching storedBalance, which is what
    // accrued-but-unharvested interest looks like. IPOR caches totalAssets, so simply
    // advancing time does not move convertToAssets; depositing into the fToken on the
    // strategy's behalf produces the same stale-storedBalance state deterministically.
    const donor = await ethers.getSigner(accounts[8]);
    const weth = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)"], WETH, donor);
    await (await weth.deposit({ value: ethers.utils.parseEther("2") })).wait();
    await (await weth.approve(await strategy.fToken(), ethers.constants.MaxUint256)).wait();
    const fTok = await ethers.getContractAt(
      ["function deposit(uint256,address) returns (uint256)"], await strategy.fToken(), donor);
    await (await fTok.deposit(ethers.utils.parseEther("1"), strategy.address)).wait();
    await network.provider.send("evm_mine"); // clear the lock the donation just armed

    // storedBalance is now stale: currentBalance() has grown past it, and that gap is
    // exactly what compoundOnWithdraw is meant to credit to the exiting user.
    const stored = new BigNumber(await strategy.storedBalance());
    const current = new BigNumber(await strategy.currentBalance());
    const gap = current.minus(stored);
    console.log("  stored ", stored.toFixed());
    console.log("  current", current.toFixed(), "(gap", gap.toFixed() + ")");
    assert.isTrue(gap.gt(0), "precondition: interest must have accrued");

    // Price the withdrawal with the flag off vs on, from the same state.
    const snapshot = await network.provider.send("evm_snapshot");
    await vault.setCompoundOnWithdraw(false, { from: governance });
    const b0 = new BigNumber(await underlying.balanceOf(farmer1));
    await vault.methods["withdraw(uint256)"](shares, { from: farmer1 });
    const withoutCompound = new BigNumber(await underlying.balanceOf(farmer1)).minus(b0);
    await network.provider.send("evm_revert", [snapshot]);

    await vault.setCompoundOnWithdraw(true, { from: governance });
    const b1 = new BigNumber(await underlying.balanceOf(farmer1));
    await vault.methods["withdraw(uint256)"](shares, { from: farmer1 });
    const withCompound = new BigNumber(await underlying.balanceOf(farmer1)).minus(b1);

    console.log("  received without compoundOnWithdraw:", withoutCompound.toFixed());
    console.log("  received with    compoundOnWithdraw:", withCompound.toFixed());
    Utils.assertBNGt(withCompound, withoutCompound);
  });

  it("does not deposit into the fToken on the withdrawal path", async function () {
    await vault.methods["deposit(uint256)"]("2000000000000000000", { from: farmer1 });
    await network.provider.send("evm_mine");
    await armStrategy();

    const positionBefore = new BigNumber(await strategy.currentBalance());
    const shares = (await vault.balanceOf(farmer1)).toString();
    await vault.methods["withdraw(uint256)"](shares, { from: farmer1 });
    const positionAfter = new BigNumber(await strategy.currentBalance());

    console.log("  fToken position", positionBefore.toFixed(), "->", positionAfter.toFixed());
    // A withdrawal may shrink the position, but it must never grow it.
    assert.isTrue(positionAfter.lte(positionBefore), "withdrawal must not deposit into the fToken");
  });

  it("leaves investOnDeposit alone - a deposit still deploys into the fToken", async function () {
    // Drain idle so the only source of a position increase is the deposit itself.
    await controller.doHardWork(vault.address, { from: governance });
    await network.provider.send("evm_mine");

    const positionBefore = new BigNumber(await strategy.currentBalance());
    await vault.methods["deposit(uint256)"]("3000000000000000000", { from: farmer1 });
    const positionAfter = new BigNumber(await strategy.currentBalance());

    console.log("  fToken position", positionBefore.toFixed(), "->", positionAfter.toFixed());
    Utils.assertBNGt(positionAfter, positionBefore);
    assert.isTrue(
      positionAfter.minus(positionBefore).gte("2900000000000000000"),
      "investOnDeposit should have supplied the deposit"
    );
  });

  it("keeps doHardWork() deploying capital, so the keeper is unaffected", async function () {
    await underlying.transfer(strategy.address, "1000000000000000000", { from: farmer1 });
    const idleBefore = new BigNumber(await underlying.balanceOf(strategy.address));
    const suppliedBefore = new BigNumber(await strategy.currentBalance());
    assert.isTrue(idleBefore.gt(0));

    await controller.doHardWork(vault.address, { from: governance });

    const idleAfter = new BigNumber(await underlying.balanceOf(strategy.address));
    const suppliedAfter = new BigNumber(await strategy.currentBalance());
    console.log("  idle    ", idleBefore.toFixed(), "->", idleAfter.toFixed());
    console.log("  supplied", suppliedBefore.toFixed(), "->", suppliedAfter.toFixed());
    Utils.assertBNGt(suppliedAfter, suppliedBefore);
    assert.isTrue(idleAfter.lt(idleBefore), "keeper harvest should deploy the idle balance");
  });
});
