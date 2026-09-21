// The four carry-trade strategies collect their rewards in USDC, a 6-decimal token.
// _liquidateRewards kept the sale behind a fixed 1e12 dust gate: a millionth of an
// 18-decimal token, but a million USDC. Every hard work notified the fee on the whole
// USDC balance and then returned, so nothing ever reached the underlying and the same
// USDC was skimmed again on the next hard work. The gate now scales with the reward
// token's decimals.
//
// Runs against the live fAAPLc strategy and its real PlasmaVault. AAPLc carries a
// single byte of code on Base and is executed natively, so the token is overlaid with a
// plain ERC20 and the Aerodrome pool the liquidator routes through is given a balance to
// pay out of; its price comes from its own untouched storage.
//
// Developed and tested at blockNumber 51596600 (a Monday, 09:22 UTC - the PlasmaVault is
// closed, so the AAPLc bought parks idle in the strategy and is supplied at the next
// opening, exactly as on a weekend).

const Utils = require("../utilities/Utils.js");
const { impersonates } = require("../utilities/hh-utils.js");
const { installTokenOverlay } = require("../utilities/fork-erc20-overlay.js");

const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");

const IERC20 = artifacts.require("IERC20");
const Strategy = artifacts.require("IPORLendingStrategyMainnet_AAPL");
const IUpgradeableStrategy = artifacts.require("IUpgradeableStrategy");

const TOKEN = "0xb200000000000000000000C2e324d24d7eEcd1fb";            // AAPLc, 8 decimals
const PLASMA_VAULT = "0x31744E44d6aF88225C1dBEFbe5Df8308fAeA641B";
const LIVE_STRATEGY = "0x5F2603d36172bA680Cd7a416Fb9e47a1A7f06438";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_WHALE = "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a";
const LIVE_TOTAL_ASSETS = "11378427653";                              // PlasmaVault.totalAssets() at the fork block
// The Aerodrome CL USDC/AAPLc pool the liquidator's registered route swaps through.
const ROUTE_POOL = "0xa3b1e3f9747065e2073722ff4c9027d3ea4994f0";
const GIFT = "200000000";                                              // 200 USDC of rewards
const num = (x) => Number(x.toString());

describe("Base Mainnet IPOR carry trade - USDC rewards are sold into the underlying", function () {
  let accounts, governance;
  let underlying, usdc, pv, strategy;

  async function usdcHeld() { return num(await usdc.balanceOf(LIVE_STRATEGY)); }
  async function underlyingHeld() {
    const idle = num(await underlying.balanceOf(LIVE_STRATEGY));
    const position = num(await strategy.currentBalance());
    return { idle, position, total: idle + position };
  }

  before(async function () {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();
    await impersonates([governance, USDC_WHALE]);
    for (const to of [governance, USDC_WHALE]) {
      await web3.eth.sendTransaction({ from: accounts[9], to, value: 5e18 });
    }

    const overlay = await installTokenOverlay({
      token: TOKEN, plasmaVault: PLASMA_VAULT, name: "Apple Inc.", symbol: "AAPLc",
      decimals: 8, assetsInVault: LIVE_TOTAL_ASSETS,
    });
    await overlay.mint(ROUTE_POOL, "1000000000000"); // 10,000 AAPLc for the pool to pay a swap out of

    underlying = await IERC20.at(TOKEN);
    usdc = await IERC20.at(USDC);
    pv = await IERC20.at(PLASMA_VAULT);
    strategy = await Strategy.at(LIVE_STRATEGY);

    assert.equal((await strategy.rewardToken()).toLowerCase(), USDC.toLowerCase(), "precondition: the reward token is USDC");
    assert.isTrue(await strategy.sell(), "precondition: selling is on");
  });

  it("control: the live implementation notifies the fee on the stuck USDC and sells nothing", async function () {
    const usdcBefore = await usdcHeld();
    const before = await underlyingHeld();
    assert.isTrue(usdcBefore > 0, "precondition: USDC rewards are sitting in the strategy");

    await strategy.doHardWork({ from: governance });

    const usdcAfter = await usdcHeld();
    const after = await underlyingHeld();
    console.log("  USDC in strategy", usdcBefore, "->", usdcAfter, "(fee skimmed again, nothing sold)");
    console.log("  underlying idle + position", before.total, "->", after.total);
    assert.isTrue(usdcAfter > 0 && usdcAfter < usdcBefore, "the fee is taken from the same USDC yet again");
    assert.isTrue(usdcAfter > usdcBefore * 0.5, "only a fee share leaves; the rest stays stuck");
    assert.equal(after.idle, before.idle, "no AAPLc was bought");
    assert.equal(after.position, before.position, "the position did not move");
  });

  it("after the upgrade the same hard work sells the USDC into AAPLc", async function () {
    const impl = await Strategy.new({ from: governance });
    const upgradable = await IUpgradeableStrategy.at(LIVE_STRATEGY);
    await upgradable.scheduleUpgrade(impl.address, { from: governance });
    await Utils.waitHours(13);
    await upgradable.upgrade({ from: governance });

    await usdc.transfer(LIVE_STRATEGY, GIFT, { from: USDC_WHALE });
    const usdcBefore = await usdcHeld();
    const before = await underlyingHeld();

    await strategy.doHardWork({ from: governance });

    const usdcAfter = await usdcHeld();
    const after = await underlyingHeld();
    const bought = after.total - before.total;
    // usdcBefore includes the fee share notified before the sale, so this overstates the
    // pool price by that share; it is a sanity figure, not an assertion.
    console.log("  USDC in strategy", usdcBefore, "->", usdcAfter);
    console.log("  underlying idle + position", before.total, "->", after.total, "(bought", bought, "= " + (bought / 1e8).toFixed(4), "AAPLc)");
    console.log("  implied price incl. fee share: $" + ((usdcBefore - usdcAfter) / 1e6 / (bought / 1e8)).toFixed(2), "per AAPLc");
    assert.isTrue(usdcAfter <= 1, "at most one unit of USDC (the 6-decimal floor) may remain");
    assert.isTrue(bought > 0, "the underlying grew by the AAPLc bought");
    assert.isTrue(after.idle > before.idle, "the PlasmaVault is closed at this block, so the AAPLc parks idle");
  });

  it("a further hard work with nothing to sell does not swap and does not revert", async function () {
    const usdcBefore = await usdcHeld();
    const before = await underlyingHeld();
    await strategy.doHardWork({ from: governance });
    assert.equal(await usdcHeld(), usdcBefore, "no USDC moved");
    assert.equal((await underlyingHeld()).total, before.total, "nothing bought");
  });
});
