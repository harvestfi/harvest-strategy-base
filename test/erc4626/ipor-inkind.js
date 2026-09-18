// In-kind redemption for the IPOR carry-trade vaults.
//
// While enabled, a holder burns vault shares and receives their pro-rata slice of the
// PlasmaVault's own shares instead of the underlying - an exit that works even when the
// PlasmaVault has no instantly redeemable liquidity. The switch is off by default and the
// normal withdrawal path keeps working throughout.
//
// The carry-trade tokens carry a single byte of code on Base and are executed natively by
// the node, so installTokenOverlay puts a plain ERC20 at the token's address and seeds the
// PlasmaVault with its live totalAssets. The PlasmaVault itself is the real one.
//
// Developed and tested at blockNumber 50510000

const Utils = require("../utilities/Utils.js");
const { impersonates, setupCoreProtocol, depositVault } = require("../utilities/hh-utils.js");
const { installTokenOverlay } = require("../utilities/fork-erc20-overlay.js");

const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");
const { ethers, network } = require("hardhat");

const IERC20 = artifacts.require("IERC20");
const HookVaultV2InKind = artifacts.require("HookVaultV2InKind");

// One entry per live carry-trade vault. Code is shared, so AAPLc is exercised in depth and
// the others get the round-trip smoke test.
const FLEET = [
  { name: "AAPLc",  artifact: "IPORLendingStrategyMainnet_AAPL",  token: "0xb200000000000000000000C2e324d24d7eEcd1fb", plasmaVault: "0x31744E44d6aF88225C1dBEFbe5Df8308fAeA641B", label: "Apple Inc.",           assets: "3523363035" },
  { name: "GOOGLc", artifact: "IPORLendingStrategyMainnet_GOOGL", token: "0xb2000000000000000000002D0BA3164cc74f58B7", plasmaVault: "0x01DBDB9748ECf71B1fFbb62f5cB41318531bA362", label: "Alphabet Inc.",        assets: "2877039180" },
  { name: "METAc",  artifact: "IPORLendingStrategyMainnet_META",  token: "0xb2000000000000000000008bC8786B856E61707C", plasmaVault: "0xCd19f18884bf388b866D05cDd1ae351133821F01", label: "Meta Platforms Inc.",  assets: "1183782285" },
  { name: "NVDAc",  artifact: "IPORLendingStrategyMainnet_NVDA",  token: "0xb20000000000000000000078ee7ce2fE4908108C", plasmaVault: "0xFb132f4C6d9DCF4f80483Ea7D96C5A5dccfcFE83", label: "NVIDIA Corporation",   assets: "5079675083" },
];

const FARMER_BALANCE = "10000000000"; // 100 tokens, 8 decimals

const num = (x) => Number(new BigNumber(x).toFixed());

describe("Base Mainnet IPOR carry trade - in-kind redemption", function () {
  let accounts, governance, farmer1, farmer2;

  before(async function () {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();
    farmer1 = accounts[1];
    farmer2 = accounts[2];
    await impersonates([governance]);
    await web3.eth.sendTransaction({ from: accounts[9], to: governance, value: 10e18 });
  });

  // Fresh vault + strategy on the in-kind implementation, funded farmers.
  async function deploy(spec, farmers = [farmer1]) {
    for (const f of farmers) {
      await installTokenOverlay({
        token: spec.token, plasmaVault: spec.plasmaVault, name: spec.label, symbol: spec.name,
        decimals: 8, assetsInVault: spec.assets, farmer: f, farmerBalance: FARMER_BALANCE,
      });
    }
    const underlying = await IERC20.at(spec.token);
    const impl = await HookVaultV2InKind.new({ from: governance });
    const [controller, v, strategy] = await setupCoreProtocol({
      existingVaultAddress: null,
      vaultImplementationOverride: impl.address,
      strategyArtifact: artifacts.require(spec.artifact),
      strategyArtifactIsUpgradable: true,
      underlying, governance,
    });
    const vault = await HookVaultV2InKind.at(v.address);
    const pv = await IERC20.at(spec.plasmaVault);
    return { underlying, vault, strategy, controller, pv };
  }

  describe("Drop-in behaviour with the switch off", function () {
    it("defaults to off, refuses in-kind, and round-trips normally", async function () {
      const { underlying, vault, strategy, controller } = await deploy(FLEET[0]);
      assert.isFalse(await vault.redeemInKindEnabled(), "must default to off");

      let msg = "";
      try { await vault.redeemInKind(1, farmer1, farmer1, { from: farmer1 }); }
      catch (e) { msg = e.message || ""; }
      assert.include(msg, "In-kind redemptions not enabled");

      // The inherited surface is untouched: deposit, harvest, withdraw all as before.
      const before = num(await underlying.balanceOf(farmer1));
      await depositVault(farmer1, underlying, vault, FARMER_BALANCE);
      await controller.doHardWork(vault.address, { from: governance });
      await vault.withdraw((await vault.balanceOf(farmer1)).toString(), { from: farmer1 });
      const after = num(await underlying.balanceOf(farmer1));
      console.log("  round trip with the switch off:", before, "->", after);
      assert.isTrue(after >= before * 0.999, "a normal round trip must still work");
      // And the HookVaultV2 surface survived the subclassing.
      assert.equal((await vault.depositCap()).toString(), "0");
      assert.isFalse(await vault.compoundOnWithdraw());
    });

    it("only governance can flip the switch", async function () {
      const { vault } = await deploy(FLEET[0]);
      let msg = "";
      try { await vault.setRedeemInKindEnabled(true, { from: farmer1 }); } catch (e) { msg = e.message || ""; }
      assert.include(msg, "Not governance");
      assert.isFalse(await vault.redeemInKindEnabled());
    });
  });

  describe("In-kind payout", function () {
    it("pays the exact pro-rata slice of PlasmaVault shares, and preview matches", async function () {
      const { underlying, vault, strategy, controller, pv } = await deploy(FLEET[0]);
      await depositVault(farmer1, underlying, vault, FARMER_BALANCE);
      await controller.doHardWork(vault.address, { from: governance });
      await vault.setRedeemInKindEnabled(true, { from: governance });
      assert.equal(await vault.inKindToken(), pv.address, "inKindToken must be the PlasmaVault");

      const shares = new BigNumber(await vault.balanceOf(farmer1));
      const half = shares.idiv(2).toFixed();
      const supply = num(await vault.totalSupply());
      const stratShares = num(await pv.balanceOf(strategy.address));

      const [previewAssets, previewPool] = Object.values(await vault.previewRedeemInKind(half));
      const recipientBefore = num(await pv.balanceOf(farmer2));
      const tx = await vault.redeemInKind(half, farmer2, farmer1, { from: farmer1 });
      const got = num(await pv.balanceOf(farmer2)) - recipientBefore;

      console.log("  strategy held", stratShares, "PlasmaVault shares; redeeming", half, "of", supply, "vault shares");
      console.log("  preview", num(previewPool), "| actual", got);
      // A block passes between the preview call and the redemption, and the fee accrues in
      // it, so the two differ by a hair. Anything larger would be a real divergence.
      assert.approximately(got / num(previewPool), 1, 1e-7, "preview must track execution");
      assert.isTrue(got <= num(previewPool), "preview must never understate the fee taken");
      assert.isTrue(got > 0, "must pay out something");

      // Pro-rata, net of the shares backing the pending fee.
      const feeShares = num(await (await artifacts.require("contracts/base/interface/IERC4626.sol:IERC4626").at(pv.address)).previewWithdraw((await strategy.pendingFee()).toString()));
      const expected = Math.floor((stratShares - feeShares) * num(half) / supply);
      console.log("  expected (net of", feeShares, "fee shares):", expected);
      assert.approximately(got / expected, 1, 1e-9, "payout must be the pro-rata slice net of fee shares");

      // The holder's vault shares are gone and the remainder still redeems normally.
      assert.equal((await vault.balanceOf(farmer1)).toString(), shares.minus(half).toFixed());
      await vault.withdraw((await vault.balanceOf(farmer1)).toString(), { from: farmer1 });
      assert.equal((await vault.balanceOf(farmer1)).toString(), "0");
    });

    it("does not move the share price for the holders who stay", async function () {
      const { underlying, vault, strategy, controller, pv } = await deploy(FLEET[0], [farmer1, farmer2]);
      await depositVault(farmer1, underlying, vault, FARMER_BALANCE);
      await depositVault(farmer2, underlying, vault, FARMER_BALANCE);
      await controller.doHardWork(vault.address, { from: governance });
      await vault.setRedeemInKindEnabled(true, { from: governance });

      const ppsBefore = num(await vault.getPricePerFullShare());
      const entitlementBefore = num(await vault.underlyingBalanceWithInvestmentForHolder(farmer2));
      await vault.redeemInKind((await vault.balanceOf(farmer1)).toString(), farmer1, farmer1, { from: farmer1 });
      const ppsAfter = num(await vault.getPricePerFullShare());
      const entitlementAfter = num(await vault.underlyingBalanceWithInvestmentForHolder(farmer2));

      console.log("  bystander pps", ppsBefore, "->", ppsAfter, "| entitlement", entitlementBefore, "->", entitlementAfter);
      assert.approximately(ppsAfter / ppsBefore, 1, 2e-4, "an in-kind exit must not reprice the remaining holders");
      assert.approximately(entitlementAfter / entitlementBefore, 1, 2e-4, "the bystander keeps their entitlement");
    });

    it("keeps the fee carve-out honest when a loss is still being carried", async function () {
      // The high water mark means a gain first repays lossCarry and only the excess is
      // charged. A fee simulation that ignored the carry would overstate the pending fee
      // and carve too many shares out of the payout.
      const { underlying, vault, strategy, controller, pv } = await deploy(FLEET[0]);
      await depositVault(farmer1, underlying, vault, FARMER_BALANCE);
      await controller.doHardWork(vault.address, { from: governance });
      await vault.setRedeemInKindEnabled(true, { from: governance });

      // Simulate a NAV dip, then a recovery: shares out of the strategy and back.
      const held = new BigNumber(await pv.balanceOf(strategy.address));
      const moved = held.idiv(20).toFixed();
      await impersonates([strategy.address]);
      await web3.eth.sendTransaction({ from: accounts[9], to: strategy.address, value: 1e18 });
      await pv.transfer(accounts[7], moved, { from: strategy.address });
      await strategy.doHardWork({ from: governance });
      const carry = num(await strategy.lossCarry());
      console.log("  lossCarry after the dip:", carry);
      assert.isTrue(carry > 0, "precondition: a loss must be carried");

      await pv.transfer(strategy.address, moved, { from: accounts[7] });
      // Still carrying: the recovery repays the carry, so no fee is due on it.
      const simulated = num(await strategy.syncedInvestedUnderlyingBalance());
      const preview = num(await vault.previewRedeemInKind((await vault.balanceOf(farmer1)).toString()).then(r => Object.values(r)[1]));
      const held2 = num(await pv.balanceOf(strategy.address));
      console.log("  synced invested", simulated, "| full-exit preview", preview, "of", held2, "held");

      const beforeBal = num(await pv.balanceOf(farmer2));
      await vault.redeemInKind((await vault.balanceOf(farmer1)).toString(), farmer2, farmer1, { from: farmer1 });
      const got = num(await pv.balanceOf(farmer2)) - beforeBal;
      console.log("  paid out", got, "=", (got / held2 * 100).toFixed(2) + "% of the position");
      assert.approximately(got / preview, 1, 1e-7, "preview must still track execution while carrying a loss");
      assert.isTrue(got > held2 * 0.99, "the carry must not inflate the fee carve-out");
    });
  });

  describe("Whole fleet", function () {
    for (const spec of FLEET) {
      it(`${spec.name}: in-kind round trip`, async function () {
        const { underlying, vault, strategy, controller, pv } = await deploy(spec);
        await depositVault(farmer1, underlying, vault, FARMER_BALANCE);
        await controller.doHardWork(vault.address, { from: governance });
        await vault.setRedeemInKindEnabled(true, { from: governance });

        const shares = (await vault.balanceOf(farmer1)).toString();
        const [, previewPool] = Object.values(await vault.previewRedeemInKind(shares));
        const before = num(await pv.balanceOf(farmer1));
        await vault.redeemInKind(shares, farmer1, farmer1, { from: farmer1 });
        const got = num(await pv.balanceOf(farmer1)) - before;
        console.log(`  ${spec.name}: received ${got} PlasmaVault shares (preview ${num(previewPool)})`);
        assert.approximately(got / num(previewPool), 1, 1e-7, "preview must track execution");
        assert.isTrue(got > 0);
        assert.equal((await vault.balanceOf(farmer1)).toString(), "0");
      });
    }
  });
});
