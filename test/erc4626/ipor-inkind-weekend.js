// In-kind redemption while the Fusion vault is closed for the weekend.
//
// IPOR registers a blanket pre-hook on the PlasmaVault's deposit/mint/withdraw/redeem
// whenever the market is closed, so every one of those reverts. Transfers are not gated.
// So the strategy cannot supply - a weekend deposit stays idle in the strategy - and it
// cannot redeem - a normal withdrawal that needs one reverts - but it can still hand out
// what it holds in kind. And what it holds is BOTH the position and that idle underlying.
// This exercises exactly that state and checks the in-kind exit pays both legs.
//
// AAPLc carries a single byte of code on Base and is executed natively, so the token is
// overlaid with a plain ERC20; the PlasmaVault, its pre-hooks and its shares are real.
//
// Developed and tested at blockNumber 51514926 (Saturday 19 Sep 2026, 12:00 UTC)

const Utils = require("../utilities/Utils.js");
const { impersonates, setupCoreProtocol, depositVault } = require("../utilities/hh-utils.js");
const { installTokenOverlay } = require("../utilities/fork-erc20-overlay.js");

const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");
const { ethers, network } = require("hardhat");

const IERC20 = artifacts.require("IERC20");
const IERC4626 = artifacts.require("contracts/base/interface/IERC4626.sol:IERC4626");
const HookVaultV2InKind = artifacts.require("HookVaultV2InKind");
const Strategy = artifacts.require("IPORLendingStrategyMainnet_AAPL");

const TOKEN = "0xb200000000000000000000C2e324d24d7eEcd1fb";
const PLASMA_VAULT = "0x31744E44d6aF88225C1dBEFbe5Df8308fAeA641B";
const LIVE_STRATEGY = "0x5F2603d36172bA680Cd7a416Fb9e47a1A7f06438"; // holds real PlasmaVault shares
const LIVE_TOTAL_ASSETS = "11378366193";
const GATE = "4b97281f";                                             // IPOR's closed-market revert
const DEPOSIT = "5000000000";                                        // 50 AAPLc each

const num = (x) => Number(new BigNumber(x).toFixed());

describe("Base Mainnet IPOR carry trade - in-kind while the market is closed", function () {
  let accounts, governance, farmer1, farmer2;
  let underlying, fToken, pv, vault, strategy, controller;

  before(async function () {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();
    farmer1 = accounts[1];
    farmer2 = accounts[2];
    await impersonates([governance, LIVE_STRATEGY]);
    for (const to of [governance, LIVE_STRATEGY]) {
      await web3.eth.sendTransaction({ from: accounts[9], to, value: 5e18 });
    }
    for (const f of [farmer1, farmer2]) {
      await installTokenOverlay({
        token: TOKEN, plasmaVault: PLASMA_VAULT, name: "Apple Inc.", symbol: "AAPLc",
        decimals: 8, assetsInVault: LIVE_TOTAL_ASSETS, farmer: f, farmerBalance: DEPOSIT,
      });
    }
    underlying = await IERC20.at(TOKEN);
    fToken = await IERC4626.at(PLASMA_VAULT);
    pv = await IERC20.at(PLASMA_VAULT);

    const impl = await HookVaultV2InKind.new({ from: governance });
    [controller, vault, strategy] = await setupCoreProtocol({
      existingVaultAddress: null, vaultImplementationOverride: impl.address,
      strategyArtifact: Strategy, strategyArtifactIsUpgradable: true, underlying, governance,
    });
    vault = await HookVaultV2InKind.at(vault.address);
    // Mirror the live vaults.
    await vault.setInvestOnDeposit(true, { from: governance });
    await vault.setCompoundOnWithdraw(true, { from: governance });
    await vault.setRedeemInKindEnabled(true, { from: governance });
  });

  it("precondition: the PlasmaVault is closed at this block", async function () {
    let dep = "", red = "";
    try { await fToken.deposit(1000, strategy.address, { from: farmer1, gas: 3e6 }); } catch (e) { dep = e.message || ""; }
    try { await fToken.redeem(1000, strategy.address, strategy.address, { from: farmer1, gas: 3e6 }); } catch (e) { red = e.message || ""; }
    assert.include(dep, GATE, "deposit must be gated");
    assert.include(red, GATE, "redeem must be gated");
  });

  it("weekend deposits succeed and park idle in the strategy", async function () {
    await depositVault(farmer1, underlying, vault, DEPOSIT);
    await depositVault(farmer2, underlying, vault, DEPOSIT);
    const idle = num(await underlying.balanceOf(strategy.address));
    console.log("  strategy idle after two weekend deposits:", idle);
    assert.equal(idle, 2 * num(DEPOSIT), "the deposits must be idle in the strategy, not supplied");
    assert.equal(num(await pv.balanceOf(strategy.address)), 0, "nothing could have been supplied");
  });

  it("the strategy also holds a position (seeded, since it cannot supply while closed)", async function () {
    // Transfers are not gated, so the position a real strategy carries into the weekend
    // can be reproduced by moving live PlasmaVault shares across.
    const live = new BigNumber(await pv.balanceOf(LIVE_STRATEGY));
    const seed = live.times(0.9).integerValue(BigNumber.ROUND_DOWN).toFixed();
    await pv.transfer(strategy.address, seed, { from: LIVE_STRATEGY });
    await network.provider.send("evm_mine"); // the transfer arms IPOR's one-block lock

    // A harvest during the closure: the supply is deferred, and the fee on the gain is
    // paid straight out of idle - no redemption needed, so the gate is never touched.
    const idleBefore = num(await underlying.balanceOf(strategy.address));
    await strategy.doHardWork({ from: governance });
    const idleAfter = num(await underlying.balanceOf(strategy.address));
    console.log("  harvest while closed: idle", idleBefore, "->", idleAfter, "| pendingFee", num(await strategy.pendingFee()));
    assert.isTrue(idleAfter < idleBefore, "the fee must have been paid from idle");
    assert.equal(num(await strategy.pendingFee()), 0, "nothing left pending: idle covered the fee");

    // Now a gain nobody has harvested yet, so the in-kind exit has a fee to carve out.
    const more = live.minus(seed).times(0.9).integerValue(BigNumber.ROUND_DOWN).toFixed();
    await pv.transfer(strategy.address, more, { from: LIVE_STRATEGY });
    await network.provider.send("evm_mine");
    await strategy.syncBalance({ from: governance }); // accrues the fee but does not pay it

    const idle = num(await underlying.balanceOf(strategy.address));
    const shares = num(await pv.balanceOf(strategy.address));
    const fee = num(await strategy.pendingFee());
    console.log("  state under test: idle", idle, "| position", shares, "shares =", num(await fToken.convertToAssets(String(shares))), "underlying | unharvested fee", fee);
    assert.isTrue(idle > 0 && shares > 0, "the state under test is idle AND a position");
    assert.isTrue(fee > 0 && fee < idle, "an unharvested fee, smaller than idle, so it is carved from the idle leg");
  });

  it("redeemInKind pays BOTH legs: the idle underlying and the position, pro-rata", async function () {
    const shares1 = new BigNumber(await vault.balanceOf(farmer1)).toFixed();
    const supply = num(await vault.totalSupply());
    const fraction = num(shares1) / supply;
    const tvl = num(await strategy.investedUnderlyingBalance());
    const idle0 = num(await underlying.balanceOf(strategy.address));
    const pos0 = num(await pv.balanceOf(strategy.address));
    const fee0 = num(await strategy.pendingFee());
    const pps0 = num(await vault.getPricePerFullShare());
    const ent2Before = num(await vault.underlyingBalanceWithInvestmentForHolder(farmer2));

    const [previewAssets, previewPool] = Object.values(await vault.previewRedeemInKind(shares1));
    const a0 = num(await underlying.balanceOf(farmer1)), p0 = num(await pv.balanceOf(farmer1));
    await vault.redeemInKind(shares1, farmer1, farmer1, { from: farmer1 });
    const gotAssets = num(await underlying.balanceOf(farmer1)) - a0;
    const gotPool = num(await pv.balanceOf(farmer1)) - p0;

    console.log("  farmer1 redeems", (fraction * 100).toFixed(2) + "% in kind");
    console.log("  received underlying", gotAssets, "(preview", num(previewAssets) + ")");
    console.log("  received position ", gotPool, "(preview", num(previewPool) + ")");

    // The fix: both legs are paid. Before it, the idle leg was 0.
    assert.isTrue(gotAssets > 0, "the idle underlying must be paid out");
    assert.isTrue(gotPool > 0, "the position must be paid out");
    // Preview tracks execution (a block passes between them, so the fee accrues by a hair).
    assert.approximately(gotAssets / num(previewAssets), 1, 1e-7, "assets preview must track execution");
    assert.approximately(gotPool / num(previewPool), 1, 1e-7, "pool-shares preview must track execution");

    // Fee carved once, idle first: with fee < idle the whole fee comes out of the idle leg
    // and the position leg is untouched.
    const expectAssets = Math.floor((idle0 - fee0) * fraction);
    const expectPool = Math.floor(pos0 * fraction);
    assert.approximately(gotAssets / expectAssets, 1, 1e-6, "idle leg must be pro-rata of idle net of the fee");
    assert.approximately(gotPool / expectPool, 1, 1e-9, "position leg must be pro-rata of the whole position");

    // And the two legs together are exactly the redeemer's slice of the strategy's value.
    const value = gotAssets + num(await fToken.convertToAssets(String(gotPool)));
    assert.approximately(value / (tvl * fraction), 1, 1e-4, "both legs must sum to the pro-rata slice of TVL");

    // Nobody else moves.
    const pps1 = num(await vault.getPricePerFullShare());
    const ent2After = num(await vault.underlyingBalanceWithInvestmentForHolder(farmer2));
    console.log("  bystander pps", pps0, "->", pps1, "| entitlement", ent2Before, "->", ent2After);
    assert.approximately(pps1 / pps0, 1, 2e-4, "an in-kind exit must not reprice the remaining holder");
    assert.approximately(ent2After / ent2Before, 1, 2e-4, "the remaining holder keeps their entitlement");
  });

  it("a normal withdrawal that needs a redeem reverts, shares intact - then in-kind still works", async function () {
    const shares2 = new BigNumber(await vault.balanceOf(farmer2)).toFixed();
    let msg = "";
    try { await vault.withdraw(shares2, { from: farmer2, gas: 6e6 }); } catch (e) { msg = e.message || ""; }
    assert.include(msg, GATE, "a withdrawal that must redeem should surface IPOR's closed-market revert");
    assert.equal((await vault.balanceOf(farmer2)).toString(), shares2, "a reverted withdrawal must not burn shares");

    const a0 = num(await underlying.balanceOf(farmer2)), p0 = num(await pv.balanceOf(farmer2));
    await vault.redeemInKind(shares2, farmer2, farmer2, { from: farmer2 });
    const gotAssets = num(await underlying.balanceOf(farmer2)) - a0;
    const gotPool = num(await pv.balanceOf(farmer2)) - p0;
    console.log("  farmer2 fell back to in-kind: underlying", gotAssets, "| position", gotPool);
    assert.isTrue(gotAssets > 0 && gotPool > 0, "the in-kind fallback must pay both legs");
    assert.equal((await vault.balanceOf(farmer2)).toString(), "0");
  });
});
