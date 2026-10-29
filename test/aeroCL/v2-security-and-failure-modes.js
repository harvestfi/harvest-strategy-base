// Adversarial + failure-mode suite for CLVaultV2, built from the audit findings.
//
// Every case here is a REGRESSION TEST for a specific defect that was found in review, or for a
// failure mode the happy-path suite does not reach. Where a case asserts "this reverts", it also
// asserts the reason, so a function that starts reverting for an unrelated reason is not mistaken
// for a passing guard.
const { impersonates } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

const VaultProxy = artifacts.require("VaultProxy");
const StrategyProxy = artifacts.require("StrategyProxy");
const CLVaultV2 = artifacts.require("CLVaultV2");
const CLRebalanceLibV2 = artifacts.require("CLRebalanceLibV2");
const Strategy = artifacts.require("AerodromeCLStrategyV2");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const IPool = artifacts.require("contracts/base/interface/concentrated-liquidity/IPool.sol:IPool");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IERC721 = artifacts.require("IERC721");
const MockCountingUL = artifacts.require("MockCountingUL");

const V3 = require("../utilities/aero-v3-fixture.js");
const { NPM, POOL, GAUGE, WHALE, AERO, AERO_WHALE, WETH, CBBTC, HELPER, TS, WINDOW } = V3;
const WIDTH = 8;
const TARGET_BPS = 8000, BAND_BPS = 1000, SAFETY = 15; // window and safety are in BLOCKS
V3.disableConfirmationListeners(VaultProxy, StrategyProxy, CLVaultV2, CLRebalanceLibV2, Strategy, IPosManager, IPool, IERC20, IERC721, MockCountingUL);
const BN = web3.utils.toBN;
const CONTROLLER_ABI = [
  { name: "universalLiquidator", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "setUniversalLiquidator", type: "function", stateMutability: "nonpayable", inputs: [{ name: "u", type: "address" }], outputs: [] },
];


async function expectRevert(fn, needle, label) {
  let threw = false, msg = "";
  try { await fn(); } catch (e) { threw = true; msg = e.message; }
  assert.equal(threw, true, `${label}: expected a revert, call succeeded`);
  if (needle) {
    assert.equal(new RegExp(needle, "i").test(msg), true,
      `${label}: expected revert matching /${needle}/, got: ${msg.split("\n")[0]}`);
  }
}

describe("CLVaultV2 — security and failure modes", function () {
  this.timeout(3600000);
  let gov, user, attacker, vault, strategy, npm, nft, t0, t1, gauge, snap;
  let linked = false;

  const evmNow = async () => Number((await web3.eth.getBlock("latest")).timestamp);
  const advance = V3.mine; // blocks, at 2s each
  const depositTs = async () => Number(await gauge.methods.depositBlock(await vault.posId()).call());
  const fund = async (who, w, c) => {
    await t0.transfer(who, web3.utils.toWei(w), { from: WHALE });
    await t1.transfer(who, c, { from: WHALE });
    await t0.approve(vault.address, web3.utils.toWei(w), { from: who });
    await t1.approve(vault.address, c, { from: who });
  };

  // Built once and snapshotted: rebuilding it per test would pull 2 cbBTC from the whale each time.
  before(async () => {
    const acc = await web3.eth.getAccounts();
    gov = addresses.Governance; user = acc[5]; attacker = acc[7];
    await impersonates([gov, WHALE]);
    for (const a of [gov, user, attacker, WHALE, acc[6]]) {
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x21E19E0C9BAB2400000"] });
    }
    t0 = await IERC20.at(WETH); t1 = await IERC20.at(CBBTC);
    npm = await IPosManager.at(NPM); nft = await IERC721.at(NPM);
    gauge = V3.gauge();
    await V3.setWindow(WINDOW);
    await V3.registerAeroV3Routes();

    await t0.transfer(gov, web3.utils.toWei("40"), { from: WHALE });
    await t1.transfer(gov, "200000000", { from: WHALE });
    await t0.approve(NPM, web3.utils.toWei("40"), { from: gov });
    await t1.approve(NPM, "200000000", { from: gov });

    const tick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
    const lower = (Math.floor(tick / TS) - WIDTH / 2) * TS;
    const mint = async (w0, w1) => {
      const res = await npm.mint({ token0: WETH, token1: CBBTC, tickSpacing: TS, tickLower: lower,
        tickUpper: lower + WIDTH * TS, amount0Desired: w0, amount1Desired: w1, amount0Min: 0,
        amount1Min: 0, recipient: gov, deadline: (await evmNow()) + 1800, sqrtPriceX96: 0 }, { from: gov });
      const evs = await nft.getPastEvents("Transfer", { fromBlock: res.receipt.blockNumber, toBlock: res.receipt.blockNumber });
      return evs.filter(e => e.returnValues.to.toLowerCase() === gov.toLowerCase()).map(e => e.returnValues.tokenId).pop();
    };
    const stakedId = await mint(web3.utils.toWei("8"), "40000000");
    const bufferId = await mint(web3.utils.toWei("2"), "10000000");

    // The truffle artifact keeps its link across tests, so only link once per run.
    if (!linked) {
      const lib = await CLRebalanceLibV2.new({ from: gov });
      await Strategy.link(lib);
      linked = true;
    }
    const impl = await CLVaultV2.new({ from: gov });
    const proxy = await VaultProxy.new(impl.address, { from: gov });
    vault = await CLVaultV2.at(proxy.address);
    await nft.approve(vault.address, stakedId, { from: gov });
    await nft.approve(vault.address, bufferId, { from: gov });
    await vault.initializeVault(addresses.Storage, stakedId, bufferId, NPM, WIDTH, TARGET_BPS, BAND_BPS, SAFETY, { from: gov });
    await vault.setRebalanceHelper(HELPER, { from: gov });
    await vault.setRebalanceSafetyConfig(10000, 100, 120, 200, { from: gov });
    await vault.setRebalanceConfig(0, 5, gov, { from: gov });
    await vault.setLanePause(false, false, false, false, { from: gov });

    const sImpl = await Strategy.new({ from: gov });
    const sProxy = await StrategyProxy.new(sImpl.address, { from: gov });
    strategy = await Strategy.at(sProxy.address);
    await strategy.initializeBaseStrategy(addresses.Storage, vault.address, GAUGE, AERO, { from: gov });
    await vault.setStrategy(strategy.address, { from: gov });
    await vault.restakePosition({ from: gov });
    snap = await hre.network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await hre.network.provider.send("evm_revert", [snap]);
    snap = await hre.network.provider.send("evm_snapshot");
  });

  // ==========================================================================================
  describe("access control — every privileged entry point", function () {
    it("rebalanceStakeRatio cannot be called by an outsider (window-reset griefing)", async () => {
      // Found in audit: this was permissionless. An attacker could loop it to keep restarting the
      // gauge window and permanently starve the vault of harvests AND range rebalances.
      await advance(WINDOW + SAFETY + 60);
      await expectRevert(() => vault.rebalanceStakeRatio({ from: attacker }),
        "ErrNotRebalanceExecutor", "rebalanceStakeRatio by attacker");
    });

    it("rebalanceCurrentTick, restakePosition and doHardWork reject outsiders", async () => {
      await expectRevert(() => vault.rebalanceCurrentTick(WIDTH, { from: attacker }), "revert", "rebalance");
      await expectRevert(() => vault.restakePosition({ from: attacker }), "revert", "restakePosition");
      await expectRevert(() => vault.doHardWork({ from: attacker }), "revert", "doHardWork");
    });

    it("strategy NFT mutators are vault-only — an outsider cannot move the positions", async () => {
      await expectRevert(() => strategy.increaseBuffer(1, 1, { from: attacker }), "revert", "increaseBuffer");
      await expectRevert(() => strategy.decreaseBuffer(1, 0, 0, attacker, { from: attacker }), "revert", "decreaseBuffer");
      await expectRevert(() => strategy.moveLiquidity(1, 2, 1, { from: attacker }), "revert", "moveLiquidity");
      await expectRevert(() => strategy.migratePositions(attacker, { from: attacker }), "revert", "migratePositions");
    });

    it("governance-only setters reject outsiders", async () => {
      await expectRevert(() => vault.setStakeConfig(5000, 500, 30, { from: attacker }), "revert", "setStakeConfig");
      await expectRevert(() => vault.setLanePause(true, true, true, true, { from: attacker }), "revert", "setLanePause");
      await expectRevert(() => vault.sweepStrayToken(AERO, attacker, { from: attacker }), "revert", "sweepStrayToken");
      await expectRevert(() => strategy.emergencyExit({ from: attacker }), "revert", "emergencyExit");
      await expectRevert(() => strategy.setGauge(attacker, { from: attacker }), "revert", "setGauge");
    });
  });

  // ==========================================================================================
  describe("pause lanes actually gate user flow", function () {
    it("pauseDepositWithdraw blocks both deposit and withdraw", async () => {
      // Found in audit: setLanePause wrote the flags but deposit/withdraw never read them.
      await fund(user, "1", "5000000");
      await vault.setLanePause(true, false, false, false, { from: gov });
      await expectRevert(() => vault.deposit(web3.utils.toWei("1"), "5000000", 0, user, { from: user }),
        "ErrDepositWithdrawPaused", "deposit while paused");
      await expectRevert(() => vault.withdraw("1", 0, 0, { from: gov }),
        "ErrDepositWithdrawPaused", "withdraw while paused");
    });

    it("withdrawOnly blocks deposits but still allows withdrawals", async () => {
      await fund(user, "1", "5000000");
      await vault.setLanePause(false, false, false, true, { from: gov });
      await expectRevert(() => vault.deposit(web3.utils.toWei("1"), "5000000", 0, user, { from: user }),
        "ErrWithdrawOnly", "deposit in withdrawOnly");
      const before = BN(await vault.balanceOf(gov));
      await vault.withdraw(before.div(BN(100)).toString(), 0, 0, { from: gov });
      assert.equal(BN(await vault.balanceOf(gov)).lt(before), true, "withdrawals must remain open");
    });

    it("pauseRebalance blocks both rebalance paths", async () => {
      await advance(WINDOW + SAFETY + 60);
      await vault.setLanePause(false, false, true, false, { from: gov });
      await expectRevert(() => vault.rebalanceCurrentTick(WIDTH, { from: gov }), "ErrRebalancePaused", "range rebalance");
      await expectRevert(() => vault.rebalanceStakeRatio({ from: gov }), "ErrRebalancePaused", "ratio rebalance");
    });
  });

  // ==========================================================================================
  describe("value conservation", function () {
    it("a deposit refunds whatever the position could not consume", async () => {
      // Found in audit: the vault forwarded the FULL amounts to the strategy and then measured its
      // OWN balance for the refund, so unconsumed tokens were stranded in the strategy forever.
      await fund(user, "3", "1000");       // wildly lopsided: nearly all token0 must come back
      const b0 = BN(await t0.balanceOf(user));
      await vault.deposit(web3.utils.toWei("3"), "1000", 0, user, { from: user });
      const spent0 = b0.sub(BN(await t0.balanceOf(user)));
      const strandedInStrategy = BN(await t0.balanceOf(strategy.address));
      console.log(`      supplied 3 WETH, position consumed ${web3.utils.fromWei(spent0)}, stranded in strategy=${web3.utils.fromWei(strandedInStrategy)}`);
      assert.equal(spent0.lt(BN(web3.utils.toWei("3"))), true, "an unbalanced deposit must not consume everything");
      assert.equal(strandedInStrategy.lt(BN(web3.utils.toWei("0.001"))), true, "unconsumed deposit must not be stranded in the strategy");
    });

    it("one withdrawer cannot sweep the fees earned by everyone else", async () => {
      // Found in audit: decreaseBuffer collected with amount0Max/amount1Max = uint128.max and paid
      // the whole collected total to the withdrawer, handing them every holder's accrued fees.
      await fund(user, "1", "5000000");
      await vault.deposit(web3.utils.toWei("1"), "5000000", 0, user, { from: user });
      const ppsBefore = BN(await vault.getPricePerFullShare());
      const shares = BN(await vault.balanceOf(user));
      await vault.withdraw(shares.toString(), 0, 0, { from: user });
      const ppsAfter = BN(await vault.getPricePerFullShare());
      console.log(`      pps ${ppsBefore} -> ${ppsAfter}`);
      assert.equal(ppsAfter.gte(ppsBefore.mul(BN(9999)).div(BN(10000))), true,
        "an exit must not drag price-per-share down for remaining holders");
    });

    it("deposit then immediate withdraw cannot extract value, with idle present to extract", async () => {
      // Rewritten twice over. The original asserted `d0 <= 0 || d1 <= 0`, a single-leg disjunction
      // that is near-impossible to violate (a round trip changes the token MIX, so one leg almost
      // always falls) — and it created no idle, so there was nothing to extract in the first place.
      // Both flaws together meant it could not detect the very bug it was named for: a deposit priced
      // on a basis that excludes idle while the payout includes it. Measured extraction on that bug
      // was 80% of a donation, and this test stayed green throughout.
      await t0.transfer(strategy.address, web3.utils.toWei("0.5"), { from: WHALE });
      await t1.transfer(vault.address, "2000000", { from: WHALE });
      const navL = BN(await vault.underlyingBalanceWithInvestment());
      const totalL = BN(await vault.totalLiquidity());
      assert.equal(navL.gt(totalL), true, "test premise: there must be idle available to extract");

      await fund(attacker, "2", "10000000");
      const v0 = BN(await t0.balanceOf(attacker)), v1 = BN(await t1.balanceOf(attacker));
      await vault.deposit(web3.utils.toWei("2"), "10000000", 0, attacker, { from: attacker });
      await vault.withdraw((await vault.balanceOf(attacker)).toString(), 0, 0, { from: attacker });
      const d0 = BN(await t0.balanceOf(attacker)).sub(v0), d1 = BN(await t1.balanceOf(attacker)).sub(v1);

      // Value, not a single leg: convert token1 to token0 terms at spot.
      const sqrtP = BN((await (await IPool.at(POOL)).slot0())[0].toString());
      const Q96 = BN(2).pow(BN(96));
      const t1InT0 = (a) => a.mul(Q96).div(sqrtP).mul(Q96).div(sqrtP);
      const valueDelta = d0.add(d1.isNeg() ? t1InT0(d1.neg()).neg() : t1InT0(d1));
      console.log(`      attacker delta token0=${d0} token1=${d1}; VALUE delta=${valueDelta.toString()}`);
      assert.equal(valueDelta.lte(BN(web3.utils.toWei("0.0001"))), true,
        `round trip extracted ${valueDelta} of value`);
    });
  });

  // ==========================================================================================
  describe("window mechanics under adversarial use", function () {
    it("a griefer cannot reset the stake window with small deposits and withdrawals", async () => {
      const ts0 = await depositTs();
      for (let i = 0; i < 3; i++) {
        await fund(attacker, "0.2", "1000000");
        await vault.deposit(web3.utils.toWei("0.2"), "1000000", 0, attacker, { from: attacker });
        await vault.withdraw((await vault.balanceOf(attacker)).toString(), 0, 0, { from: attacker });
      }
      assert.equal(await depositTs(), ts0, "buffer-served flow must never touch the gauge clock");
      console.log(`      3 deposit/withdraw cycles, clock unmoved at ${ts0}`);
    });

    it("harvest and rebalance stay blocked for the whole window, then open", async () => {
      const end = Number(await vault.stakeWindowEnd());
      assert.equal(await vault.isOutsideStakeWindow(), false, "must start inside the window");
      await expectRevert(() => vault.rebalanceCurrentTick(WIDTH, { from: gov }), "ErrInsideStakeWindow", "rebalance inside");
      assert.equal((await vault.checker())[0], false, "checker must not signal work it cannot do");
      await advance(WINDOW + SAFETY + 60);
      assert.equal(await vault.isOutsideStakeWindow(), true, `must be outside after the window (ends ${end})`);
    });

    it("raising minStakeBlocks upstream is picked up live, not cached", async () => {
      await advance(WINDOW + SAFETY + 60);
      assert.equal(await vault.isOutsideStakeWindow(), true, `outside at ${WINDOW} blocks`);
      // The PENALTY_ADMIN Safe widens the window under a live vault (4h of 2s blocks).
      await V3.setWindow(7200);
      assert.equal(await vault.isOutsideStakeWindow(), false, "a widened window must take effect immediately");
      assert.equal((await vault.checker())[0], false, "checker must follow the widened window");
      console.log(`      minStakeBlocks ${WINDOW} -> 7200; windowEnd now ${(await vault.stakeWindowEnd()).toString()}`);
    });

    it("ratio rebalance is refused while the split is inside the band", async () => {
      await advance(WINDOW + SAFETY + 60);
      await expectRevert(() => vault.rebalanceStakeRatio({ from: gov }), "ErrRatioInBand", "in-band ratio rebalance");
      console.log(`      stakedBps=${(await vault.stakedRatioBps()).toString()} target=${TARGET_BPS} band=${BAND_BPS} -> correctly refused`);
    });
  });

  // ==========================================================================================
  describe("degenerate inputs and states", function () {
    it("zero-value deposits and withdrawals are rejected, not silently accepted", async () => {
      await expectRevert(() => vault.deposit(0, 0, 0, user, { from: user }), "revert", "zero deposit");
      await expectRevert(() => vault.withdraw(0, 0, 0, { from: gov }), "ErrZeroShares", "zero withdraw");
    });

    it("deposit to the zero address is rejected", async () => {
      await fund(user, "1", "5000000");
      await expectRevert(() => vault.deposit(web3.utils.toWei("1"), "5000000", 0, "0x" + "0".repeat(40), { from: user }),
        "ErrZeroAddress", "zero receiver");
    });

    it("minShares slippage bound is enforced on deposit", async () => {
      await fund(user, "1", "5000000");
      const huge = BN(10).pow(BN(30)).toString();
      await expectRevert(() => vault.deposit(web3.utils.toWei("1"), "5000000", huge, user, { from: user }),
        "ErrSlippage", "unreachable minShares");
    });

    it("stake config rejects nonsensical values (100% staked would remove the buffer entirely)", async () => {
      await expectRevert(() => vault.setStakeConfig(10000, 500, 30, { from: gov }), "ErrBadConfig", "100% staked");
      await expectRevert(() => vault.setStakeConfig(0, 500, 30, { from: gov }), "ErrBadConfig", "0% staked");
      await expectRevert(() => vault.setStakeConfig(8000, 10000, 30, { from: gov }), "ErrBadConfig", "band >= 100%");
    });

    it("the buffer position cannot be pointed at the staked position", async () => {
      // Both slots holding one id would double-count the same liquidity in totalLiquidity().
      const staked = (await vault.posId()).toString();
      await expectRevert(() => vault.setBufferPosition(staked, { from: gov }),
        "ErrBadConfig|ErrRangeMismatch", "buffer == staked");
    });

    it("sweepStrayToken refuses the pool tokens", async () => {
      await expectRevert(() => vault.sweepStrayToken(WETH, gov, { from: gov }), "ErrProtectedToken", "sweep token0");
      await expectRevert(() => vault.sweepStrayToken(CBBTC, gov, { from: gov }), "ErrProtectedToken", "sweep token1");
    });

    it("strategy salvage refuses reward and pool tokens", async () => {
      assert.equal(await strategy.unsalvagableTokens(WETH), true, "token0 must not be salvagable");
      assert.equal(await strategy.unsalvagableTokens(CBBTC), true, "token1 must not be salvagable");
      assert.equal(await strategy.unsalvagableTokens(AERO), true, "reward token must not be salvagable");
      await expectRevert(() => strategy.salvage(gov, WETH, 1, { from: gov }), "not salvagable", "salvage token0");
    });
  });

  // ==========================================================================================
  describe("emergency paths", function () {
    it("emergencyExit unstakes immediately and stops harvesting", async () => {
      await strategy.emergencyExit({ from: gov });
      assert.equal((await nft.ownerOf(await vault.posId())).toLowerCase(), strategy.address.toLowerCase(),
        "position must come out of the gauge");
      assert.equal(await strategy.harvestPaused(), true);
      assert.equal(await strategy.withdrawOnlyMode(), true);
      console.log(`      emergencyExit: unstaked, harvestPaused=true, withdrawOnly=true`);
    });

    it("withdrawals still work after an emergency exit — funds are never trapped", async () => {
      await strategy.emergencyExit({ from: gov });
      const before = BN(await vault.balanceOf(gov));
      await vault.withdraw(before.div(BN(50)).toString(), 0, 0, { from: gov });
      assert.equal(BN(await vault.balanceOf(gov)).lt(before), true, "must still be able to exit");
    });

    it("continueInvesting restores normal operation", async () => {
      await strategy.emergencyExit({ from: gov });
      await strategy.continueInvesting({ from: gov });
      assert.equal(await strategy.harvestPaused(), false);
      assert.equal(await strategy.withdrawOnlyMode(), false);
      await vault.restakePosition({ from: gov });
      assert.equal((await nft.ownerOf(await vault.posId())).toLowerCase(), GAUGE.toLowerCase(), "must re-stake");
    });
  });
});

// ============================================================================================
// Regressions for the defects the adversarial audit reproduced on a fork after the first fix
// round. All three sit on the same code path — a liquidity move whose token amounts round to
// zero — and all three failed CLOSED, reverting the caller rather than degrading.
// ============================================================================================
describe("CLVaultV2 — dust and full-exit edge cases", function () {
  this.timeout(3600000);
  let gov, user, vault, strategy, npm, nft, t0, t1, linked2 = false, snap2;
  const evmNow = async () => Number((await web3.eth.getBlock("latest")).timestamp);

  before(async () => {
    const acc = await web3.eth.getAccounts();
    gov = addresses.Governance; user = acc[5];
    await impersonates([gov, WHALE]);
    for (const a of [gov, user, WHALE]) {
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x21E19E0C9BAB2400000"] });
    }
    t0 = await IERC20.at(WETH); t1 = await IERC20.at(CBBTC);
    npm = await IPosManager.at(NPM); nft = await IERC721.at(NPM);
    await V3.setWindow(WINDOW);
    await V3.registerAeroV3Routes();
    await t0.transfer(gov, web3.utils.toWei("40"), { from: WHALE });
    await t1.transfer(gov, "200000000", { from: WHALE });
    await t0.approve(NPM, web3.utils.toWei("40"), { from: gov });
    await t1.approve(NPM, "200000000", { from: gov });
    const tick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
    const lower = (Math.floor(tick / TS) - WIDTH / 2) * TS;
    const mint = async (w0, w1) => {
      const res = await npm.mint({ token0: WETH, token1: CBBTC, tickSpacing: TS, tickLower: lower,
        tickUpper: lower + WIDTH * TS, amount0Desired: w0, amount1Desired: w1, amount0Min: 0,
        amount1Min: 0, recipient: gov, deadline: (await evmNow()) + 1800, sqrtPriceX96: 0 }, { from: gov });
      const evs = await nft.getPastEvents("Transfer", { fromBlock: res.receipt.blockNumber, toBlock: res.receipt.blockNumber });
      return evs.filter(e => e.returnValues.to.toLowerCase() === gov.toLowerCase()).map(e => e.returnValues.tokenId).pop();
    };
    const stakedId = await mint(web3.utils.toWei("8"), "40000000");
    const bufferId = await mint(web3.utils.toWei("2"), "10000000");
    if (!linked2) { try { const lib = await CLRebalanceLibV2.new({ from: gov }); await Strategy.link(lib); } catch (e) {} linked2 = true; }
    const impl = await CLVaultV2.new({ from: gov });
    const proxy = await VaultProxy.new(impl.address, { from: gov });
    vault = await CLVaultV2.at(proxy.address);
    await nft.approve(vault.address, stakedId, { from: gov });
    await nft.approve(vault.address, bufferId, { from: gov });
    await vault.initializeVault(addresses.Storage, stakedId, bufferId, NPM, WIDTH, TARGET_BPS, BAND_BPS, SAFETY, { from: gov });
    await vault.setRebalanceHelper(HELPER, { from: gov });
    await vault.setRebalanceSafetyConfig(10000, 100, 120, 200, { from: gov });
    await vault.setRebalanceConfig(0, 5, gov, { from: gov });
    await vault.setLanePause(false, false, false, false, { from: gov });
    const sImpl = await Strategy.new({ from: gov });
    const sProxy = await StrategyProxy.new(sImpl.address, { from: gov });
    strategy = await Strategy.at(sProxy.address);
    await strategy.initializeBaseStrategy(addresses.Storage, vault.address, GAUGE, AERO, { from: gov });
    await vault.setStrategy(strategy.address, { from: gov });
    await vault.restakePosition({ from: gov });
    snap2 = await hre.network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await hre.network.provider.send("evm_revert", [snap2]);
    snap2 = await hre.network.provider.send("evm_snapshot");
  });

  it("the LAST holder can redeem 100% of supply in one transaction", async () => {
    // Audit P1: the post-payout re-split tried to move residual dust into a now-empty staked
    // position; increaseLiquidity computes zero liquidity and the NPM reverts with 'NP', taking
    // the whole redemption with it. The last holder could never exit.
    const supply = BN(await vault.totalSupply());
    const before0 = BN(await t0.balanceOf(gov)), before1 = BN(await t1.balanceOf(gov));
    await vault.withdraw(supply.toString(), 0, 0, { from: gov });
    const got0 = BN(await t0.balanceOf(gov)).sub(before0), got1 = BN(await t1.balanceOf(gov)).sub(before1);
    console.log(`      full exit paid out ${web3.utils.fromWei(got0)} WETH + ${got1.toString()} cbBTC; supply now ${(await vault.totalSupply()).toString()}`);
    assert.equal(BN(await vault.totalSupply()).isZero(), true, "all shares must be burned");
    assert.equal(got0.gt(BN(0)) || got1.gt(BN(0)), true, "the last holder must actually be paid");
  });

  it("a withdrawal whose shortfall over the buffer is one wei still succeeds", async () => {
    // Audit P2: moveLiquidity(1) releases a non-zero token0 amount but zero token1 (8-decimal
    // cbBTC rounds first), so the paired increase minted zero liquidity and reverted with no
    // reason. The band widens as the two tokens' decimals converge — worse on EURC/USDC (6/6),
    // which is in the launch pipeline.
    const supply = BN(await vault.totalSupply());
    const total = BN(await vault.totalLiquidity());
    const buffered = BN(await vault.bufferLiquidity());
    // shares that redeem exactly one wei of liquidity more than the buffer holds
    const shares = buffered.add(BN(1)).mul(supply).div(total);
    console.log(`      buffer=${buffered} owed=${buffered.add(BN(1))} (1 wei shortfall)`);
    await vault.withdraw(shares.toString(), 0, 0, { from: gov });
    assert.equal((await nft.ownerOf(await vault.posId())).toLowerCase(), GAUGE.toLowerCase(), "must end re-staked");
    console.log(`      succeeded; stakedBps=${(await vault.stakedRatioBps()).toString()}`);
  });

  it("maxSlippageBps cannot brick reward compounding when tightened", async () => {
    // Audit P3: minOut was derived from amountIn (tokenIn units) but passed as amountOutMin
    // (tokenOut units), so any tightening made every reward swap revert — silently, because
    // _swap swallows it. Harvests would keep 'succeeding' while AERO never compounded.
    await V3.mine(WINDOW + SAFETY + 60);
    await strategy.setMaxSlippageBps(9900, { from: gov });
    const aero = await IERC20.at(AERO);
    // A V3 gauge mints on claim and holds no AERO, so take it from an AERO pool instead.
    await V3.fund(AERO_WHALE);
    await aero.transfer(strategy.address, web3.utils.toWei("5"), { from: AERO_WHALE });
    const skippedBefore = BN(await strategy.swapSkippedCount());
    const totalBefore = BN(await vault.totalLiquidity());
    await vault.doHardWork({ from: gov });
    const skippedAfter = BN(await strategy.swapSkippedCount());
    const totalAfter = BN(await vault.totalLiquidity());
    console.log(`      swapSkippedCount ${skippedBefore} -> ${skippedAfter}; totalL ${totalBefore} -> ${totalAfter}`);
    assert.equal(skippedAfter.eq(skippedBefore), true, "a tightened maxSlippageBps must not make every reward swap revert");
    assert.equal(totalAfter.gt(totalBefore), true, "rewards must still compound into the position");
  });

  it("idle token dust reaches NAV even when the reward balance is below the compound gate", async () => {
    // Audit P4: _claimAndCompound returned early below the gate, so collected fees and absorbed
    // move-residue sat in the strategy forever — owned by the vault, counted by nothing, and
    // withdrawable by no one.
    await V3.mine(WINDOW + SAFETY + 60);
    await strategy.setMinRewardToCompound(AERO, web3.utils.toWei("1000000"), { from: gov }); // gate: effectively never
    await t0.transfer(strategy.address, web3.utils.toWei("0.05"), { from: WHALE });
    await t1.transfer(strategy.address, "250000", { from: WHALE });
    const totalBefore = BN(await vault.totalLiquidity());
    await vault.doHardWork({ from: gov });
    const totalAfter = BN(await vault.totalLiquidity());
    console.log(`      below-gate harvest: totalL ${totalBefore} -> ${totalAfter}; strategy idle t0=${(await t0.balanceOf(strategy.address)).toString()}`);
    assert.equal(totalAfter.gt(totalBefore), true, "idle dust must be folded into NAV even below the reward gate");
  });
});
