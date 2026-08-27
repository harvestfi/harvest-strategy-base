// Fleet differential for the CURRENT HookVaultV2 - the one carrying the deposit cap.
//
// The earlier fleet assessment ran against a HookVaultV2 that overrode only _withdraw and
// left the deposit path untouched. The cap added _deposit, maxDeposit and maxMint
// overrides, so the deposit path is no longer stock and that result no longer covers it.
// This re-runs the comparison across live vaults from several strategy families.
//
// Block timestamps are pinned across both branches. Without that, wall-clock drift over
// evm_revert makes the underlying protocol accrue a few wei differently and shows up as a
// fake share-count difference.
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

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC_WHALE = "0xDDC976cB693fDa9c7570eC68Df397623E48815e9";

// One live vault per strategy family, spanning both underlyings.
const FLEET = [
  { name: "morpho mw-USDC", vault: "0x9C012E4fe655b90839e1b65a461B72813c9ac2A4", token: USDC, amount: "1000000000" },
  { name: "morpho gc-USDC", vault: "0x84478106F22750F2C69bFfD632EBA22E439B521A", token: USDC, amount: "1000000000" },
  { name: "fluid USDC",     vault: "0xD9e38d724CC5ee983BC0Fd0Ce35C3eB20417b673", token: USDC, amount: "1000000000" },
  { name: "morpho mw-WETH", vault: "0x14d3f3cf49a4948CF3c8a024430bE6a7eFBD7D1A", token: WETH, amount: "1000000000000000000" },
  { name: "morpho ap-WETH",  vault: "0x3fB00a58FB4871f84903b6c530b541375c5Cc1bc", token: WETH, amount: "1000000000000000000" },
];

describe("HookVaultV2 fleet differential (with deposit cap)", function () {
  let governance, farmer, controller;

  before(async function () {
    governance = addresses.Governance;
    const accounts = await web3.eth.getAccounts();
    farmer = accounts[1];
    await impersonates([governance, USDC_WHALE]);
    for (const to of [governance, USDC_WHALE]) {
      await web3.eth.sendTransaction({ from: accounts[9], to, value: 10e18 });
    }
    // Wrap ETH for the WETH vaults; pull USDC from a whale for the rest.
    const w = await ethers.getContractAt(["function deposit() payable"], WETH, await ethers.getSigner(farmer));
    await (await w.deposit({ value: ethers.utils.parseEther("30") })).wait();
    await (await IERC20.at(USDC)).transfer(farmer, "20000000000", { from: USDC_WHALE });
  });

  for (const t of FLEET) {
    it(`${t.name}: identical on stock VaultV2 and HookVaultV2`, async function () {
      const token = await IERC20.at(t.token);
      const stock = await VaultV2.at(t.vault);
      controller = await IController.at(await stock.controller());
      await token.approve(t.vault, t.amount, { from: farmer });

      // Deploy + schedule before snapshotting so both branches share tx count.
      const impl = await HookVaultV2.new({ from: governance });
      await stock.scheduleUpgrade(impl.address, { from: governance });

      const startTs = (await ethers.provider.getBlock("latest")).timestamp;
      const snap = await network.provider.send("evm_snapshot");

      // Runs one identical cycle with every block timestamp pinned.
      async function cycle(v, upgradeFirst) {
        let ts = startTs + 13 * 3600; // clear nextImplementationDelay identically in both branches
        const step = async (fn) => {
          ts += 12;
          await network.provider.send("evm_setNextBlockTimestamp", [ts]);
          return fn();
        };
        if (upgradeFirst) await step(() => (VaultProxy.at(t.vault)).then(p => p.upgrade({ from: governance })));
        else await step(() => network.provider.send("evm_mine"));

        const depRc = await step(() => v.methods["deposit(uint256)"](t.amount, { from: farmer }));
        const shares = (await v.balanceOf(farmer)).toString();
        const hwRc = await step(() => controller.doHardWork(t.vault, { from: governance }));
        const before = new BigNumber(await token.balanceOf(farmer));
        const wdRc = await step(() => v.methods["withdraw(uint256)"](shares, { from: farmer }));
        const returned = new BigNumber(await token.balanceOf(farmer)).minus(before).toFixed();
        return {
          shares, returned,
          pps: (await v.getPricePerFullShare()).toString(),
          gas: { dep: depRc.receipt.gasUsed, hw: hwRc.receipt.gasUsed, wd: wdRc.receipt.gasUsed },
        };
      }

      const a = await cycle(stock, false);
      await network.provider.send("evm_revert", [snap]);
      const b = await cycle(await HookVaultV2.at(t.vault), true);

      const hooked = await HookVaultV2.at(t.vault);
      console.log(`   cap=${(await hooked.depositCap()).toString()} ` +
                  `compoundOnWithdraw=${await hooked.compoundOnWithdraw()} investOnDeposit=${await hooked.investOnDeposit()}`);
      console.log(`   shares   ${a.shares} | ${b.shares}`);
      console.log(`   returned ${a.returned} | ${b.returned}`);
      console.log(`   pps      ${a.pps} | ${b.pps}`);
      console.log(`   gas dep ${b.gas.dep - a.gas.dep >= 0 ? "+" : ""}${b.gas.dep - a.gas.dep}` +
                  `  hw ${b.gas.hw - a.gas.hw >= 0 ? "+" : ""}${b.gas.hw - a.gas.hw}` +
                  `  wd ${b.gas.wd - a.gas.wd >= 0 ? "+" : ""}${b.gas.wd - a.gas.wd}`);

      assert.equal(b.shares, a.shares, "shares minted must be identical");
      assert.equal(b.returned, a.returned, "underlying returned must be identical");
      assert.equal(b.pps, a.pps, "price per full share must be identical");
    });
  }
});
