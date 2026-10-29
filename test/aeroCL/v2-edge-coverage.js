// The four coverage gaps left after the audit round: out-of-range positions, the Controller-driven
// harvest path, an actual out-of-band ratio repair, and multi-user interleavings.
//
// These target states the earlier suites never reach. Out-of-range in particular is where the
// `moveLiquidity` catch added for the dust defects is weakest: in range a zero-liquidity move is a
// bug to swallow, but out of range a SINGLE-SIDED move is legitimate and must still work — if the
// catch silently absorbed those, liquidity would quietly stop moving exactly when the vault most
// needs to rebalance.
const { impersonates } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

const VaultProxy = artifacts.require("VaultProxy");
const StrategyProxy = artifacts.require("StrategyProxy");
const CLVaultV2 = artifacts.require("CLVaultV2");
const CLRebalanceLibV2 = artifacts.require("CLRebalanceLibV2");
const Strategy = artifacts.require("AerodromeCLStrategyV2");
const PriceMover = artifacts.require("CLPoolPriceMover");
const MockPartialUL = artifacts.require("MockPartialUL");
const MockCountingUL = artifacts.require("MockCountingUL");
const MockLossyUL = artifacts.require("MockLossyUL");
const ICLRebalanceHelper = artifacts.require("ICLRebalanceHelper");
const MockTickMath = artifacts.require("MockTickMath");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const IPool = artifacts.require("contracts/base/interface/concentrated-liquidity/IPool.sol:IPool");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IERC721 = artifacts.require("IERC721");

const NPM2 = "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53";
const POOL = "0x42d4a22CaD0F5a49681a5715cE994Af73A43B76b";
const GAUGE = "0x61E0B10423a0009C3f83ab4313813d29437d0817";
const FACTORY = "0x385293CaE378C813F16f0C1334d774AdDDf56AbB";
const ADMIN = "0xE6A41fE61E7a1996B59d508661e3f524d6A32075";
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const WETH = "0x4200000000000000000000000000000000000006";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const HELPER = "0x74a343dECf3b4578B07D0F7b7577aB2f3c4762b2";
const TS = 10, WIDTH = 8, WINDOW = 300;
const TARGET_BPS = 8000, BAND_BPS = 1000, SAFETY = 30;
const BN = web3.utils.toBN;
const MIN_SQRT = "4295128740";
const MAX_SQRT = "1461446703485210103287273052203988822378723970341";

const FACTORY_ABI = [{ name: "setMinStakeTime", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "p", type: "address" }, { name: "v", type: "uint256" }], outputs: [] }];
const CONTROLLER_ABI = [
  { name: "doHardWork", type: "function", stateMutability: "nonpayable", inputs: [{ name: "v", type: "address" }], outputs: [] },
  { name: "addHardWorker", type: "function", stateMutability: "nonpayable", inputs: [{ name: "w", type: "address" }], outputs: [] },
  { name: "hardWorkers", type: "function", stateMutability: "view", inputs: [{ name: "w", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { name: "universalLiquidator", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "setUniversalLiquidator", type: "function", stateMutability: "nonpayable", inputs: [{ name: "u", type: "address" }], outputs: [] },
];

let linkedLibAddr = null;

async function buildVault(gov) {
  const npm = await IPosManager.at(NPM2), nft = await IERC721.at(NPM2);
  const t0 = await IERC20.at(WETH), t1 = await IERC20.at(CBBTC);
  const now = Number((await web3.eth.getBlock("latest")).timestamp);
  const tick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
  const lower = (Math.floor(tick / TS) - WIDTH / 2) * TS;
  const mint = async (w0, w1) => {
    const res = await npm.mint({ token0: WETH, token1: CBBTC, tickSpacing: TS, tickLower: lower,
      tickUpper: lower + WIDTH * TS, amount0Desired: w0, amount1Desired: w1, amount0Min: 0,
      amount1Min: 0, recipient: gov, deadline: now + 1800, sqrtPriceX96: 0 }, { from: gov });
    const evs = await nft.getPastEvents("Transfer", { fromBlock: res.receipt.blockNumber, toBlock: res.receipt.blockNumber });
    return evs.filter(e => e.returnValues.to.toLowerCase() === gov.toLowerCase()).map(e => e.returnValues.tokenId).pop();
  };
  const stakedId = await mint(web3.utils.toWei("8"), "40000000");
  const bufferId = await mint(web3.utils.toWei("2"), "10000000");
  // Truffle bakes the library address into the artifact and refuses a second link, but every test
  // resets the fork, which wipes the deployed library. The redeploy is nonce-deterministic so it
  // lands on the same address -- ASSERT that, because a delegatecall into a codeless address
  // SUCCEEDS silently and would turn every moveLiquidity into an invisible no-op that all of these
  // tests would still pass.
  const lib = await CLRebalanceLibV2.new({ from: gov });
  if (linkedLibAddr === null) { await Strategy.link(lib); linkedLibAddr = lib.address; }
  assert.equal(lib.address, linkedLibAddr, "library must redeploy to the linked address after reset");
  assert.notEqual(await web3.eth.getCode(linkedLibAddr), "0x", "linked library must have code");
  const impl = await CLVaultV2.new({ from: gov });
  const proxy = await VaultProxy.new(impl.address, { from: gov });
  const vault = await CLVaultV2.at(proxy.address);
  await nft.approve(vault.address, stakedId, { from: gov });
  await nft.approve(vault.address, bufferId, { from: gov });
  await vault.initializeVault(addresses.Storage, stakedId, bufferId, NPM2, WIDTH, TARGET_BPS, BAND_BPS, SAFETY, { from: gov });
  await vault.setRebalanceHelper(HELPER, { from: gov });
  await vault.setRebalanceSafetyConfig(10000, 100, 120, 200, { from: gov });
  await vault.setRebalanceConfig(0, 5, gov, { from: gov });
  await vault.setLanePause(false, false, false, false, { from: gov });
  const sImpl = await Strategy.new({ from: gov });
  const sProxy = await StrategyProxy.new(sImpl.address, { from: gov });
  const strategy = await Strategy.at(sProxy.address);
  await strategy.initializeBaseStrategy(addresses.Storage, vault.address, GAUGE, AERO, { from: gov });
  await vault.setStrategy(strategy.address, { from: gov });
  await vault.restakePosition({ from: gov });
  return { vault, strategy, npm, nft, t0, t1, lower, upper: lower + WIDTH * TS };
}

describe("CLVaultV2 — edge coverage", function () {
  this.timeout(3600000);
  let gov, u1, u2, u3, ctx, factory, controller;
  const evmNow = async () => Number((await web3.eth.getBlock("latest")).timestamp);
  const advance = async s => { await hre.network.provider.send("evm_increaseTime", [s]); await hre.network.provider.send("evm_mine"); };
  const poolTick = async () => parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);

  // Push the pool decisively past one edge of the vault's range.
  async function pushOutOfRange(down) {
    const mover = await PriceMover.new({ from: gov });
    const tm = await MockTickMath.new({ from: gov });
    const acc = await web3.eth.getAccounts();
    const funder = acc[8];
    await hre.network.provider.request({ method: "hardhat_setBalance", params: [funder, "0x152D02C7E14AF6800000"] });
    if (down) {
      await web3.eth.sendTransaction({ from: funder, to: WETH, value: web3.utils.toWei("600"), gas: 200000 });
      await ctx.t0.transfer(mover.address, web3.utils.toWei("600"), { from: funder });
      const target = Math.floor((ctx.lower - 30) / TS) * TS;
      await mover.move(POOL, true, web3.utils.toWei("600"), (await tm.getSqrtRatioAtTick(target)).toString(), { from: gov });
    } else {
      await impersonates([POOL]);
      const have = BN(await ctx.t1.balanceOf(POOL));
      const amt = have.div(BN(4)).toString();
      await ctx.t1.transfer(mover.address, amt, { from: POOL });
      const target = Math.ceil((ctx.upper + 30) / TS) * TS;
      await mover.move(POOL, false, amt, (await tm.getSqrtRatioAtTick(target)).toString(), { from: gov });
    }
    return poolTick();
  }

  beforeEach(async () => {
    await hre.network.provider.request({ method: "hardhat_reset", params: [{
      forking: { jsonRpcUrl: hre.network.config.forking.url, blockNumber: hre.network.config.forking.blockNumber },
    }] });
    const acc = await web3.eth.getAccounts();
    gov = addresses.Governance; u1 = acc[5]; u2 = acc[6]; u3 = acc[7];
    await impersonates([gov, POOL, ADMIN]);
    for (const a of [gov, u1, u2, u3, POOL, ADMIN, acc[8]]) {
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x152D02C7E14AF6800000"] });
    }
    factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);
    controller = new web3.eth.Contract(CONTROLLER_ABI, addresses.Controller);
    await factory.methods.setMinStakeTime(POOL, WINDOW).send({ from: ADMIN, gas: 500000 });
    const t0 = await IERC20.at(WETH), t1 = await IERC20.at(CBBTC);
    await t0.transfer(gov, web3.utils.toWei("40"), { from: POOL });
    await t1.transfer(gov, "200000000", { from: POOL });
    await t0.approve(NPM2, web3.utils.toWei("40"), { from: gov });
    await t1.approve(NPM2, "200000000", { from: gov });
    ctx = await buildVault(gov);
  });

  async function fund(who, w, c) {
    await ctx.t0.transfer(who, web3.utils.toWei(w), { from: POOL });
    await ctx.t1.transfer(who, c, { from: POOL });
    await ctx.t0.approve(ctx.vault.address, web3.utils.toWei(w), { from: who });
    await ctx.t1.approve(ctx.vault.address, c, { from: who });
  }

  // A buffer-exhausting withdrawal has to move liquidity from the staked position into the buffer
  // before it can pay. Asserting only that the STAKED side shrank proves nothing: decreaseLiquidity
  // drains it either way, and if the destination increase is dropped the tokens just become idle and
  // the caller is short-paid. So assert what a dropped move actually damages -- the payout.
  async function assertForcedExitPaysOut(pct) {
    const amounts = await ctx.vault.getCurrentTokenAmounts();
    const supply = BN(await ctx.vault.totalSupply());
    const shares = supply.mul(BN(pct)).div(BN(100));
    const stakedBefore = BN(await ctx.vault.stakedLiquidity());
    const before0 = BN(await ctx.t0.balanceOf(gov)), before1 = BN(await ctx.t1.balanceOf(gov));
    await ctx.vault.withdraw(shares.toString(), 0, 0, { from: gov });
    const got0 = BN(await ctx.t0.balanceOf(gov)).sub(before0);
    const got1 = BN(await ctx.t1.balanceOf(gov)).sub(before1);
    const want0 = BN(amounts[0]).mul(shares).div(supply);
    const want1 = BN(amounts[1]).mul(shares).div(supply);
    console.log(`      forced exit ${pct}%: staked ${stakedBefore}->${(await ctx.vault.stakedLiquidity()).toString()}; paid t0=${got0}/${want0} t1=${got1}/${want1}`);
    assert.equal(BN(await ctx.vault.stakedLiquidity()).lt(stakedBefore), true, "must have unstaked to serve the exit");
    assert.equal(got0.gte(want0.mul(BN(99)).div(BN(100))), true, `short-paid token0: ${got0} vs ${want0}`);
    assert.equal(got1.gte(want1.mul(BN(99)).div(BN(100))), true, `short-paid token1: ${got1} vs ${want1}`);
  }

  // ==========================================================================================
  describe("out-of-range / single-sided positions", function () {
    it("spot parked just inside a range boundary cannot short-pay a withdrawal", async () => {
      // The zero-liquidity skip has an attacker-reachable edge. Put spot ONE WEI above the range's
      // lower sqrt price: a decrease then releases amount1 = L*(sqrtP-sqrtA)/2^96, which floors to
      // zero for any realistic L, while amount0 is arbitrarily large. Re-minting is then impossible
      // (min(L0, 0) == 0), so the move is skipped -- for an arbitrarily LARGE amount, not dust.
      // Left unguarded the withdrawal clamps to the buffer and burns the caller's full shares.
      const tm = await MockTickMath.new({ from: gov });
      const mover = await PriceMover.new({ from: gov });
      const acc = await web3.eth.getAccounts();
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [acc[8], "0x152D02C7E14AF6800000"] });
      await web3.eth.sendTransaction({ from: acc[8], to: WETH, value: web3.utils.toWei("600"), gas: 200000 });
      await ctx.t0.transfer(mover.address, web3.utils.toWei("600"), { from: acc[8] });
      const target = BN((await tm.getSqrtRatioAtTick(ctx.lower)).toString()).add(BN(1));
      await mover.move(POOL, true, web3.utils.toWei("600"), target.toString(), { from: gov });

      const slot0 = await (await IPool.at(POOL)).slot0();
      const sqrtNow = BN(slot0[0].toString());
      console.log(`      sqrtP=${sqrtNow} target=${target} (tickLower=${ctx.lower})`);
      assert.equal(sqrtNow.eq(target), true, "test premise: spot must sit exactly one wei inside the boundary");

      const supply = BN(await ctx.vault.totalSupply());
      const govBefore = BN(await ctx.vault.balanceOf(gov));
      let threw = false, msg = "";
      try {
        await ctx.vault.withdraw(supply.mul(BN(60)).div(BN(100)).toString(), 0, 0, { from: gov });
      } catch (e) { threw = true; msg = e.message; }
      console.log(`      withdraw reverted=${threw} ${threw ? msg.slice(0, 90) : ""}`);
      assert.equal(threw, true, "a withdrawal whose cover cannot land must revert, not silently short-pay");
      assert.equal(/ErrShortfallNotCovered/.test(msg), true, `expected ErrShortfallNotCovered, got: ${msg.slice(0, 200)}`);
      // The caller must keep their shares -- a reverted withdrawal may not burn anything.
      assert.equal(BN(await ctx.vault.balanceOf(gov)).eq(govBefore), true, "a reverted withdrawal must not burn the caller's shares");
      assert.equal(BN(await ctx.vault.totalSupply()).eq(supply), true, "reverted withdrawal must not burn shares");
    });

    it("BELOW range: deposit and withdraw still work, and liquidity still moves", async () => {
      const t = await pushOutOfRange(true);
      console.log(`      pool tick ${t}, vault range [${ctx.lower},${ctx.upper}] -> position is single-sided (all token0)`);
      assert.equal(t < ctx.lower, true, "test premise: pool must be below the range");

      const amounts = await ctx.vault.getCurrentTokenAmounts();
      console.log(`      position holds token0=${web3.utils.fromWei(amounts[0])} token1=${amounts[1].toString()}`);
      assert.equal(BN(amounts[1]).isZero(), true, "below range the position must hold only token0");

      // Deposit single-sided: only token0 can be consumed here.
      await fund(u1, "1", "5000000");
      const bufBefore = BN(await ctx.vault.bufferLiquidity());
      await ctx.vault.deposit(web3.utils.toWei("1"), "5000000", 0, u1, { from: u1 });
      assert.equal(BN(await ctx.vault.bufferLiquidity()).gt(bufBefore), true, "single-sided deposit must still mint liquidity");
      assert.equal(BN(await ctx.vault.balanceOf(u1)).gt(BN(0)), true, "must mint shares");

      // A buffer-exhausting withdraw exercises moveLiquidity single-sided — the case the dust
      // catch must NOT swallow.
      await assertForcedExitPaysOut(40);
      assert.equal((await ctx.nft.ownerOf(await ctx.vault.posId())).toLowerCase(), GAUGE.toLowerCase(), "must end re-staked");
    });

    it("ABOVE range: deposit and withdraw still work, and liquidity still moves", async () => {
      const t = await pushOutOfRange(false);
      console.log(`      pool tick ${t}, vault range [${ctx.lower},${ctx.upper}] -> position is single-sided (all token1)`);
      assert.equal(t >= ctx.upper, true, "test premise: pool must be above the range");
      const amounts = await ctx.vault.getCurrentTokenAmounts();
      assert.equal(BN(amounts[0]).isZero(), true, "above range the position must hold only token1");

      await fund(u1, "1", "5000000");
      const bufBefore = BN(await ctx.vault.bufferLiquidity());
      await ctx.vault.deposit(web3.utils.toWei("1"), "5000000", 0, u1, { from: u1 });
      assert.equal(BN(await ctx.vault.bufferLiquidity()).gt(bufBefore), true, "single-sided deposit must still mint liquidity");

      await assertForcedExitPaysOut(40);
    });

    it("a harvest whose swap leg fails does not brick while out of range", async () => {
      // The reachable shape of the bug. `_swap` deliberately swallows a failed reward swap ("must
      // never brick a harvest"), which can leave idle on ONE side only. Out of range only ONE token
      // contributes liquidity — so if the surviving side is the one the position cannot use, the
      // fold mints zero and an unguarded increaseLiquidity reverts, bricking every future harvest.
      //
      // Simply pushing out of range is NOT enough to reproduce this: the compound splits the reward
      // across both tokens, so the usable side is never empty. The failing leg is the whole point.
      await pushOutOfRange(false); // above range -> only token1 (cbBTC) contributes
      assert.equal(BN((await ctx.vault.getCurrentTokenAmounts())[0]).isZero(), true, "premise: above range");

      const realUL = await controller.methods.universalLiquidator().call();
      const mock = await MockPartialUL.new(realUL, CBBTC, { from: gov }); // block AERO->cbBTC only
      await controller.methods.setUniversalLiquidator(mock.address).send({ from: gov, gas: 500000 });

      const aero = await IERC20.at(AERO);
      await impersonates([GAUGE]);
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [GAUGE, "0x21E19E0C9BAB2400000"] });
      await aero.transfer(ctx.strategy.address, web3.utils.toWei("5"), { from: GAUGE }); // above the 0.01 gate
      await advance(WINDOW + SAFETY + 60);

      const skippedBefore = BN(await ctx.strategy.swapSkippedCount());
      await ctx.vault.doHardWork({ from: gov }); // must not revert
      const skippedAfter = BN(await ctx.strategy.swapSkippedCount());
      const idle0 = BN(await ctx.t0.balanceOf(ctx.strategy.address));
      const idle1 = BN(await ctx.t1.balanceOf(ctx.strategy.address));
      console.log(`      swapSkipped ${skippedBefore}->${skippedAfter}; idle token0=${idle0} token1=${idle1}`);
      // Without a skipped leg this test would be exercising the ordinary happy path and proving
      // nothing, so assert the premise rather than trusting the setup.
      assert.equal(skippedAfter.gt(skippedBefore), true, "test premise: a swap leg must have failed");
      assert.equal(idle0.gt(BN(0)) && idle1.isZero(), true,
        "test premise: idle must sit only on the side an above-range position cannot use");

      // And it must stay harvestable — a one-shot survival is not enough, since the dust that caused
      // the revert would otherwise still be there next cycle.
      await aero.transfer(ctx.strategy.address, web3.utils.toWei("5"), { from: GAUGE });
      await advance(WINDOW + SAFETY + 60);
      await ctx.vault.doHardWork({ from: gov });

      // Restore the real UL AND bring spot back inside the range before asserting recovery.
      // Both matter: while spot is pushed far from the price the UL routes at, the fold leg's
      // 100bps bound legitimately refuses the swap (measured 111bps off in the pushed state, so
      // minOut 5812 vs a 5806 delivery). That refusal is the bound working, not a failure — but it
      // means "idle is recovered" is only a fair expectation once the price is normal again.
      await controller.methods.setUniversalLiquidator(realUL).send({ from: gov, gas: 500000 });
      {
        const tm2 = await MockTickMath.new({ from: gov });
        const back = await PriceMover.new({ from: gov });
        const a2 = await web3.eth.getAccounts();
        await hre.network.provider.request({ method: "hardhat_setBalance", params: [a2[8], "0x152D02C7E14AF6800000"] });
        await web3.eth.sendTransaction({ from: a2[8], to: WETH, value: web3.utils.toWei("400"), gas: 200000 });
        await ctx.t0.transfer(back.address, web3.utils.toWei("400"), { from: a2[8] });
        const mid = Math.floor((ctx.lower + ctx.upper) / 2 / TS) * TS;
        await back.move(POOL, true, web3.utils.toWei("400"), (await tm2.getSqrtRatioAtTick(mid)).toString(), { from: gov });
        const t2 = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
        assert.equal(t2 >= ctx.lower && t2 < ctx.upper, true, `premise: spot must be back in range (tick ${t2})`);
      }
      const totalBefore = BN(await ctx.vault.totalLiquidity());
      await aero.transfer(ctx.strategy.address, web3.utils.toWei("5"), { from: GAUGE });
      await advance(WINDOW + SAFETY + 60);
      await ctx.vault.doHardWork({ from: gov });
      console.log(`      after route repair: totalL ${totalBefore} -> ${(await ctx.vault.totalLiquidity()).toString()}`);
      assert.equal(BN(await ctx.vault.totalLiquidity()).gt(totalBefore), true,
        "idle accumulated during the outage must be folded back in once the route works");
    });

    it("a ratio repair out of range moves liquidity instead of leaking it to idle", async () => {
      // The regression risk from the zero-liquidity skip: a move that legitimately CAN mint (a
      // single-sided out-of-range move) gets skipped anyway, so liquidity silently stops moving and
      // the released tokens pile up as unaccounted idle.
      //
      // The first version of this test called rebalanceStakeRatio inside a .catch() with no drift
      // manufactured, so it took the in-band revert path and asserted nothing at all. Force a real
      // repair and assert it happened.
      await pushOutOfRange(true);
      assert.equal(BN((await ctx.vault.getCurrentTokenAmounts())[1]).isZero(), true, "premise: below range");

      await fund(u1, "6", "30000000");
      await ctx.vault.deposit(web3.utils.toWei("6"), "30000000", 0, u1, { from: u1 });
      const drifted = Number((await ctx.vault.stakedRatioBps()).toString());
      assert.equal(Math.abs(drifted - TARGET_BPS) > BAND_BPS, true,
        `test premise: drift must exceed the band, got ${drifted}`);

      const idle0Before = BN(await ctx.t0.balanceOf(ctx.strategy.address));
      const stakedBefore = BN(await ctx.vault.stakedLiquidity());
      const totalBefore = BN(await ctx.vault.totalLiquidity());

      await advance(WINDOW + SAFETY + 60);
      await ctx.vault.rebalanceStakeRatio({ from: gov }); // must NOT revert, and must do real work

      const repaired = Number((await ctx.vault.stakedRatioBps()).toString());
      const stakedAfter = BN(await ctx.vault.stakedLiquidity());
      const totalAfter = BN(await ctx.vault.totalLiquidity());
      const idleDelta = BN(await ctx.t0.balanceOf(ctx.strategy.address)).sub(idle0Before);
      console.log(`      out of range: stakedBps ${drifted}->${repaired}, stakedL ${stakedBefore}->${stakedAfter}, idle0 +${idleDelta}`);

      assert.equal(stakedAfter.gt(stakedBefore), true, "single-sided liquidity must actually move into the staked side");
      assert.equal(Math.abs(repaired - TARGET_BPS) <= 100, true, `ratio must reach target, got ${repaired}`);
      // Idle is NOT the right leak detector here: a move collects fees and re-deposits principal
      // only, so idle grows by the fees the position earned (the price push itself generates them).
      // totalLiquidity() counts NFT liquidity alone, so principal diverted to idle shows up there.
      assert.equal(totalAfter.gte(totalBefore.mul(BN(9999)).div(BN(10000))), true,
        `principal leaked out of the positions: ${totalBefore} -> ${totalAfter}`);
    });

  });

  // ==========================================================================================
  describe("Controller-driven harvest", function () {
    it("Controller.doHardWork(vault) works end to end via a hardWorker", async () => {
      // Production harvests do NOT come from governance. The Controller reads the vault through
      // IVault -- getPricePerFullShare(), doHardWork(), strategy() -- so a shape mismatch there
      // reverts INSIDE the Controller and no governance-driven test would ever show it.
      const acc = await web3.eth.getAccounts();
      const worker = acc[4];
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [worker, "0x21E19E0C9BAB2400000"] });
      if (!(await controller.methods.hardWorkers(worker).call())) {
        await controller.methods.addHardWorker(worker).send({ from: gov, gas: 500000 });
      }
      assert.equal(await controller.methods.hardWorkers(worker).call(), true, "worker must be registered");

      await advance(WINDOW + SAFETY + 60);
      const aero = await IERC20.at(AERO);
      await impersonates([GAUGE]);
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [GAUGE, "0x21E19E0C9BAB2400000"] });
      await aero.transfer(ctx.strategy.address, web3.utils.toWei("5"), { from: GAUGE });

      const totalBefore = BN(await ctx.vault.totalLiquidity());
      await controller.methods.doHardWork(ctx.vault.address).send({ from: worker, gas: 8000000 });
      const totalAfter = BN(await ctx.vault.totalLiquidity());
      console.log(`      Controller harvest by hardWorker: totalL ${totalBefore} -> ${totalAfter}`);
      assert.equal(totalAfter.gt(totalBefore), true, "the Controller path must actually compound");
      assert.equal((await ctx.nft.ownerOf(await ctx.vault.posId())).toLowerCase(), GAUGE.toLowerCase(), "must stay staked");
    });

    it("a non-hardWorker cannot drive the Controller harvest", async () => {
      let threw = false;
      try { await controller.methods.doHardWork(ctx.vault.address).send({ from: u3, gas: 8000000 }); }
      catch (e) { threw = true; }
      assert.equal(threw, true, "Controller must reject an unregistered caller");
    });

    it("the vault refuses a direct doHardWork from an address that is neither governance nor controller", async () => {
      let threw = false;
      try { await ctx.vault.doHardWork({ from: u3 }); } catch (e) { threw = true; }
      assert.equal(threw, true, "direct doHardWork must stay gated");
    });
  });

  // ==========================================================================================
  describe("ratio repair actually executing", function () {
    it("drift beyond the band is repaired back to target", async () => {
      // Only the in-band REFUSAL was covered before. Manufacture real drift: deposits land wholly
      // in the buffer, so a deposit above total/7 (at 8000/1000) drags the staked share under the
      // band. If the premise does not hold the test would silently assert nothing, so check it.
      const totalBefore = BN(await ctx.vault.totalLiquidity());
      const need = totalBefore.div(BN(4)); // comfortably past the band
      await fund(u1, "6", "30000000");
      await ctx.vault.deposit(web3.utils.toWei("6"), "30000000", 0, u1, { from: u1 });

      const drifted = Number((await ctx.vault.stakedRatioBps()).toString());
      console.log(`      after deposit: stakedBps=${drifted} (target ${TARGET_BPS}, band ${BAND_BPS})`);
      assert.equal(Math.abs(drifted - TARGET_BPS) > BAND_BPS, true,
        `test premise: drift must exceed the band, got ${drifted}`);

      await advance(WINDOW + SAFETY + 60);
      const totalPre = BN(await ctx.vault.totalLiquidity());
      await ctx.vault.rebalanceStakeRatio({ from: gov });
      const repaired = Number((await ctx.vault.stakedRatioBps()).toString());
      const totalPost = BN(await ctx.vault.totalLiquidity());
      console.log(`      after repair: stakedBps=${repaired}; totalL ${totalPre} -> ${totalPost}`);
      assert.equal(Math.abs(repaired - TARGET_BPS) <= 100, true, `ratio must be restored to target, got ${repaired}`);
      assert.equal((await ctx.nft.ownerOf(await ctx.vault.posId())).toLowerCase(), GAUGE.toLowerCase(), "must end re-staked");
      // A repair moves liquidity between two identical-range positions; it must not destroy value.
      assert.equal(totalPost.gte(totalPre.mul(BN(9999)).div(BN(10000))), true, "repair must not lose value");
    });

    it("a repair inside the window is refused even when drift is large", async () => {
      await fund(u1, "6", "30000000");
      await ctx.vault.deposit(web3.utils.toWei("6"), "30000000", 0, u1, { from: u1 });
      assert.equal(Math.abs(Number((await ctx.vault.stakedRatioBps()).toString()) - TARGET_BPS) > BAND_BPS, true, "premise: drifted");
      let threw = false;
      try { await ctx.vault.rebalanceStakeRatio({ from: gov }); } catch (e) { threw = /ErrInsideStakeWindow|revert/i.test(e.message); }
      assert.equal(threw, true, "drift must not override the window gate");
    });
  });

  // ==========================================================================================
  describe("multi-user interleavings", function () {
    it("no user operation ever moves value away from the other holders", async () => {
      // The first cut of this test asserted "nobody ends ahead on BOTH legs". That was wrong in both
      // directions: a holder who earns fees SHOULD end ahead on both legs (it failed on correct
      // behaviour), and a price shift makes one leg fall regardless (it passes for free). Neither
      // outcome says anything about fairness.
      //
      // The invariant that does: price per share must not DROP across a user operation. pps is
      // totalLiquidity/totalSupply, so if someone's deposit or withdrawal leaves it lower than they
      // found it, the difference came out of everyone else's pocket. That is exactly the thing an
      // exploit has to do, and it is checked around EVERY operation, not just at the end.
      const aero = await IERC20.at(AERO);
      await impersonates([GAUGE]);
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [GAUGE, "0x21E19E0C9BAB2400000"] });

      const drops = [];
      let checked = 0;
      const DUST = BN(web3.utils.toWei("0.000000001"));
      // Guard on wei-level rounding only: 1e-7 relative is far below any extraction worth doing,
      // and far above decrease/increase rounding (measured at ~1e-8 on a ratio repair).
      const step = async (label, fn) => {
        const supplyBefore = BN(await ctx.vault.totalSupply());
        const before = BN(await ctx.vault.getPricePerFullShare());
        await fn();
        const supplyAfter = BN(await ctx.vault.totalSupply());
        // pps is meaningless when the vault is empty on either side of the op.
        if (supplyBefore.lt(DUST) || supplyAfter.lt(DUST)) return;
        const after = BN(await ctx.vault.getPricePerFullShare());
        checked++;
        const floor = before.mul(BN(9999999)).div(BN(10000000));
        if (after.lt(floor)) drops.push(`${label}: pps ${before} -> ${after}`);
      };

      const users = [u1, u2, u3];
      const amounts = [["2", "10000000"], ["1", "5000000"], ["3", "15000000"]];
      let harvested = false, forced = false;
      for (let i = 0; i < users.length; i++) {
        await fund(users[i], amounts[i][0], amounts[i][1]);
        await step(`deposit ${i}`, () =>
          ctx.vault.deposit(web3.utils.toWei(amounts[i][0]), amounts[i][1], 0, users[i], { from: users[i] }));
        if (i === 1) {
          await advance(WINDOW + SAFETY + 60);
          await aero.transfer(ctx.strategy.address, web3.utils.toWei("3"), { from: GAUGE });
          const tl = BN(await ctx.vault.totalLiquidity());
          await step("harvest", () => ctx.vault.doHardWork({ from: gov }));
          harvested = BN(await ctx.vault.totalLiquidity()).gt(tl);
          const staked = BN(await ctx.vault.stakedLiquidity());
          const supply = BN(await ctx.vault.totalSupply());
          // Shares are proportional to liquidity, so withdrawing X% of supply burns X% of total
          // liquidity. To actually FORCE an unstake it has to exceed the buffer's share -- a fixed
          // 25% did not, because three deposits had already grown the buffer past that.
          const bufBps = BN(await ctx.vault.bufferLiquidity()).mul(BN(10000))
            .div(BN(await ctx.vault.totalLiquidity()));
          const pct = BN(Math.min(9000, Number(bufBps.toString()) + 1500));
          await step("forced unstake", () =>
            ctx.vault.withdraw(supply.mul(pct).div(BN(10000)).toString(), 0, 0, { from: gov }));
          forced = BN(await ctx.vault.stakedLiquidity()).lt(staked);
          console.log(`      buffer was ${bufBps}bps of total; withdrew ${pct}bps of supply -> forced=${forced}`);
        }
      }
      // Exit in a different order than entry -- ordering must not be exploitable.
      for (const u of [u2, u3, u1]) {
        await step(`exit ${u.slice(0, 8)}`, async () =>
          ctx.vault.withdraw((await ctx.vault.balanceOf(u)).toString(), 0, 0, { from: u }));
      }

      // If the interleaving never actually harvested or never actually forced an unstake, the test
      // exercised a plain deposit/withdraw sequence and proves much less than it appears to.
      assert.equal(harvested, true, "test premise: the interleaved harvest must have compounded");
      assert.equal(forced, true, "test premise: the interleaved withdrawal must have forced an unstake");
      // An empty `drops` proves nothing if the guard skipped every operation, so pin the count.
      console.log(`      ${checked} operations pps-checked, ${drops.length} drops`);
      assert.equal(checked >= 7, true, `test premise: every op must be pps-checked, only ${checked} were`);
      assert.deepEqual(drops, [], "no operation may reduce price per share for the remaining holders");
    });

    it("a deposit landing between a forced unstake and the re-split is priced correctly", async () => {
      // The forced-unstake path unstakes, pays out, re-splits, re-stakes. A deposit arriving right
      // after must not mint against a momentarily understated NAV.
      await fund(u1, "2", "10000000");
      const supply = BN(await ctx.vault.totalSupply());
      await ctx.vault.withdraw(supply.mul(BN(35)).div(BN(100)).toString(), 0, 0, { from: gov });
      const ppsAfterForced = BN(await ctx.vault.getPricePerFullShare());
      await ctx.vault.deposit(web3.utils.toWei("2"), "10000000", 0, u1, { from: u1 });
      const ppsAfterDeposit = BN(await ctx.vault.getPricePerFullShare());
      console.log(`      pps after forced unstake=${ppsAfterForced} after deposit=${ppsAfterDeposit}`);
      assert.equal(ppsAfterDeposit.gte(ppsAfterForced.mul(BN(9999)).div(BN(10000))), true,
        "a deposit must not dilute existing holders");
    });
  });
  // ==========================================================================================
  describe("checker multiplexing", function () {
    const SEL_RANGE = web3.eth.abi.encodeFunctionSignature("rebalanceCurrentTick(uint256)");
    const SEL_RATIO = web3.eth.abi.encodeFunctionSignature("rebalanceStakeRatio()");

    // Deposits land in the buffer, which drags the staked share below the band.
    async function driftRatio() {
      await fund(u1, "6", "30000000");
      await ctx.vault.deposit(web3.utils.toWei("6"), "30000000", 0, u1, { from: u1 });
      const d = Number((await ctx.vault.stakedRatioBps()).toString());
      assert.equal(Math.abs(d - TARGET_BPS) > BAND_BPS, true, `test premise: drift must exceed the band, got ${d}`);
      return d;
    }

    it("offers the ratio repair when only the ratio has drifted", async () => {
      const drifted = await driftRatio();
      await advance(WINDOW + SAFETY + 60);
      const r = await ctx.vault.checker();
      console.log(`      drift=${drifted} -> canExec=${r.canExec} selector=${r.execPayload.slice(0, 10)}`);
      assert.equal(r.canExec, true, "outstanding ratio work must be reported");
      assert.equal(r.execPayload.slice(0, 10), SEL_RATIO, "payload must be rebalanceStakeRatio()");
    });

    it("the advertised payload actually executes from the configured executor", async () => {
      // The whole point of a checker is that the payload it hands back can be sent as-is. Decoding
      // the selector proves nothing if the call would revert, so send it.
      await ctx.vault.setRebalanceConfig(0, 5, u3, { from: gov }); // a dedicated executor, not governance
      await driftRatio();
      await advance(WINDOW + SAFETY + 60);
      const r = await ctx.vault.checker();
      assert.equal(r.canExec, true, "premise: work must be outstanding");

      await web3.eth.sendTransaction({ from: u3, to: ctx.vault.address, data: r.execPayload, gas: 8000000 });
      const after = Number((await ctx.vault.stakedRatioBps()).toString());
      console.log(`      executed checker payload as executor -> stakedBps=${after}`);
      assert.equal(Math.abs(after - TARGET_BPS) <= 100, true, `payload must have repaired the ratio, got ${after}`);
      const done = await ctx.vault.checker();
      assert.equal(done.canExec, false, "checker must go quiet once the work is done");
    });

    it("stays quiet inside the stake window even with work outstanding", async () => {
      const drifted = await driftRatio();
      const r = await ctx.vault.checker(); // still inside the window from the seed stake
      console.log(`      inside window: drift=${drifted} canExec=${r.canExec}`);
      assert.equal(await ctx.vault.isOutsideStakeWindow(), false, "test premise: must be inside the window");
      assert.equal(r.canExec, false, "a call that would revert must not be advertised");
    });

    it("stays quiet while rebalancing is paused, with work outstanding", async () => {
      await driftRatio();
      await advance(WINDOW + SAFETY + 60);
      assert.equal((await ctx.vault.checker()).canExec, true, "test premise: work must be outstanding first");
      await ctx.vault.setLanePause(false, false, true, false, { from: gov }); // pauseRebalance
      const r = await ctx.vault.checker();
      console.log(`      paused: canExec=${r.canExec}`);
      assert.equal(r.canExec, false, "paused rebalancing must not be advertised — it would revert and burn funds");
    });

    it("prefers the range rebalance when both are due", async () => {
      await pushOutOfRange(true);
      const drifted = await driftRatio();
      await advance(WINDOW + SAFETY + 60);
      const r = await ctx.vault.checker();
      console.log(`      both due (drift=${drifted}, out of range): selector=${r.execPayload.slice(0, 10)}`);
      assert.equal(r.canExec, true, "work is outstanding");
      // Assert the premise that the RANGE is genuinely due, or "prefers range" proves nothing.
      const helper = await ICLRebalanceHelper.at(await ctx.vault.rebalanceHelper());
      const rangeDue = await helper.shouldRebalance(
        POOL, await ctx.vault.tickLower(), await ctx.vault.tickUpper(), TS,
        (await ctx.vault.posWidth()).toString(), (await ctx.vault.targetWidth()).toString(),
        "0", "5", "0", (await evmNow()).toString()
      );
      assert.equal(rangeDue, true, "test premise: the range must actually be due");
      assert.equal(r.execPayload.slice(0, 10), SEL_RANGE, "range must win — it re-splits to target anyway");
    });
  });
  // ==========================================================================================
  describe("mint/redeem basis symmetry", function () {
    it("idle stranded on the strategy is swept to where withdrawals can reach it", async () => {
      // The critical case. underlyingBalanceWithInvestment() counts the STRATEGY's balance and every
      // mint is priced on it, but withdraw() can only pay out the VAULT's balance. A one-sided
      // remainder on the strategy is the normal state after a range rebalance re-mints at the range's
      // ratio — so without a sweep, depositors are charged for value payable to nobody, and it
      // survives even a 100%-of-supply redemption (salvage and sweepStrayToken both refuse the pool
      // tokens). Measured at 599bps of silent loss per round trip before the fix.
      await pushOutOfRange(true); // below range -> token1 cannot be folded into the position
      await ctx.t1.transfer(ctx.strategy.address, "20000000", { from: POOL });
      const navBefore = BN(await ctx.vault.underlyingBalanceWithInvestment());
      const totalBefore = BN(await ctx.vault.totalLiquidity());
      const inflation = navBefore.sub(totalBefore).mul(BN(10000)).div(totalBefore);
      console.log(`      strategy holds unfoldable token1; NAV inflated by ${inflation}bps over totalLiquidity`);
      assert.equal(navBefore.gt(totalBefore), true, "test premise: NAV must be inflated by strategy idle");
      assert.equal(inflation.gt(BN(50)), true, `test premise: inflation must be material, got ${inflation}bps`);

      await fund(u1, "1", "5000000");
      const in0 = BN(await ctx.t0.balanceOf(u1)), in1 = BN(await ctx.t1.balanceOf(u1));
      await ctx.vault.deposit(web3.utils.toWei("1"), "5000000", 0, u1, { from: u1 });
      // The sweep runs inside deposit; the strategy must not still be holding it.
      const strandedAfter = BN(await ctx.t1.balanceOf(ctx.strategy.address));
      console.log(`      strategy token1 after deposit: ${strandedAfter.toString()} (was 20000000)`);
      assert.equal(strandedAfter.isZero(), true, "the sweep must move strategy idle to the vault");

      await ctx.vault.withdraw((await ctx.vault.balanceOf(u1)).toString(), 0, 0, { from: u1 });
      const d0 = BN(await ctx.t0.balanceOf(u1)).sub(in0), d1 = BN(await ctx.t1.balanceOf(u1)).sub(in1);
      const sqrtP = BN((await (await IPool.at(POOL)).slot0())[0].toString());
      const Q96 = BN(2).pow(BN(96));
      const t1InT0 = (a) => a.mul(Q96).div(sqrtP).mul(Q96).div(sqrtP);
      const valueDelta = d0.add(d1.isNeg() ? t1InT0(d1.neg()).neg() : t1InT0(d1));
      const lostBps = valueDelta.isNeg() ? valueDelta.neg().mul(BN(10000)).div(BN(web3.utils.toWei("1"))) : BN(0);
      console.log(`      round trip: token0=${d0} token1=${d1}; VALUE delta=${valueDelta} (${lostBps}bps of the deposit)`);
      assert.equal(lostBps.lt(BN(50)), true, `round trip lost ${lostBps}bps to unreachable strategy idle`);
    });

    it("a deposit cannot buy a claim on idle it was never charged for", async () => {
      // NAV and the withdrawal payout both count idle. If the MINT is priced on a basis that
      // excludes it, a fresh depositor buys a share of that idle for free: deposit many times the
      // vault, withdraw in the same transaction, and walk away with most of it. Permissionless,
      // flash-loanable, and it scales with TVL rather than with the seed.
      const donation = BN(web3.utils.toWei("1"));
      await ctx.t0.transfer(ctx.vault.address, donation.toString(), { from: POOL });
      const idleOnVault = BN(await ctx.t0.balanceOf(ctx.vault.address));
      assert.equal(idleOnVault.gte(donation), true, "test premise: the vault must hold idle");

      // Attacker deposits several times the vault's size to capture most of the donation.
      await fund(u1, "40", "200000000");
      const in0 = BN(await ctx.t0.balanceOf(u1)), in1 = BN(await ctx.t1.balanceOf(u1));
      await ctx.vault.deposit(web3.utils.toWei("40"), "200000000", 0, u1, { from: u1 });
      const shares = BN(await ctx.vault.balanceOf(u1));
      assert.equal(shares.gt(BN(0)), true, "premise: attacker must hold shares");
      await ctx.vault.withdraw(shares.toString(), 0, 0, { from: u1 });

      const out0 = BN(await ctx.t0.balanceOf(u1)), out1 = BN(await ctx.t1.balanceOf(u1));
      const d0 = out0.sub(in0), d1 = out1.sub(in1);
      // Value, not a single leg. A round trip legitimately changes the token MIX (the range consumes
      // a specific ratio and refunds the rest), so d0 alone says nothing — measuring it was the same
      // mistake as the first multi-user invariant. Price both legs at spot instead.
      const sqrtP = BN((await (await IPool.at(POOL)).slot0())[0].toString());
      const Q96 = BN(2).pow(BN(96));
      // token0-equivalent of a raw token1 amount: a1 * 2^192 / sqrtP^2
      const t1InT0 = (a1) => a1.mul(Q96).div(sqrtP).mul(Q96).div(sqrtP);
      const valueDelta = d0.add(d1.isNeg() ? t1InT0(d1.neg()).neg() : t1InT0(d1));
      console.log(`      donated ${donation}; delta token0=${d0} token1=${d1}; VALUE delta (token0 terms)=${valueDelta.toString()}`);
      const cap = donation.div(BN(100)); // 1% of the donation
      assert.equal(valueDelta.lt(cap), true,
        `attacker extracted ${valueDelta} of value against a ${donation} donation`);
    });
  });
  // ==========================================================================================
  describe("compound efficiency", function () {
    it("compounds at the position's actual ratio, not a fixed 50/50 split", async () => {
      // Observed on-chain: a compound approved 67,883 USDC and 21,092 AAPLc but the position took
      // only 23,356 / 21,092 — 66% of the USDC stranded. Cause: the reward was split 50/50 across
      // the two tokens, but the ratio a range consumes depends on where spot sits inside it and is
      // rarely half. V1 avoided this by sizing the second leg with planSwapForMint; V2 had dropped
      // that. Push spot well off centre so the required ratio is clearly lopsided.
      const mover = await PriceMover.new({ from: gov });
      const tm = await MockTickMath.new({ from: gov });
      const acc = await web3.eth.getAccounts();
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [acc[8], "0x152D02C7E14AF6800000"] });
      await web3.eth.sendTransaction({ from: acc[8], to: WETH, value: web3.utils.toWei("400"), gas: 200000 });
      await ctx.t0.transfer(mover.address, web3.utils.toWei("400"), { from: acc[8] });
      // Aim just inside the lower edge: the position then wants mostly token0.
      const target = ctx.lower + 8;
      await mover.move(POOL, true, web3.utils.toWei("400"), (await tm.getSqrtRatioAtTick(target)).toString(), { from: gov });
      const tick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
      assert.equal(tick > ctx.lower && tick < ctx.upper, true, `premise: spot must be inside but off-centre (tick ${tick})`);
      const w = await ctx.vault.getCurrentTokenWeights();
      const w0bps = BN(w[0]).mul(BN(10000)).div(BN(w[0]).add(BN(w[1])));
      console.log(`      tick ${tick} in [${ctx.lower},${ctx.upper}]; token0 weight ${w0bps}bps`);
      assert.equal(w0bps.gt(BN(6000)) || w0bps.lt(BN(4000)), true,
        `premise: the required ratio must be lopsided, got ${w0bps}bps`);

      const aero = await IERC20.at(AERO);
      await impersonates([GAUGE]);
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [GAUGE, "0x21E19E0C9BAB2400000"] });
      await aero.transfer(ctx.strategy.address, web3.utils.toWei("30"), { from: GAUGE });
      await advance(WINDOW + SAFETY + 60);

      const liqBefore = BN(await ctx.vault.totalLiquidity());
      const rc = await ctx.vault.doHardWork({ from: gov });
      const liqAfter = BN(await ctx.vault.totalLiquidity());
      const left0 = BN(await ctx.t0.balanceOf(ctx.strategy.address));
      const left1 = BN(await ctx.t1.balanceOf(ctx.strategy.address));
      // What the position actually accepted, from the IncreaseLiquidity event.
      const incTopic = web3.utils.keccak256("IncreaseLiquidity(uint256,uint128,uint256,uint256)");
      const incLogs = (await web3.eth.getPastLogs({
        fromBlock: rc.receipt.blockNumber, toBlock: rc.receipt.blockNumber, address: NPM2,
      })).filter(l => l.topics[0] === incTopic);
      let dep0 = BN(0), dep1 = BN(0);
      for (const l of incLogs) {
        const d = web3.eth.abi.decodeParameters(["uint128", "uint256", "uint256"], l.data);
        dep0 = dep0.add(BN(d[1])); dep1 = dep1.add(BN(d[2]));
      }

      // Value the leftovers against the value actually compounded, in token0 terms.
      const sqrtP = BN((await (await IPool.at(POOL)).slot0())[0].toString());
      const Q96 = BN(2).pow(BN(96));
      const t1InT0 = (a) => a.mul(Q96).div(sqrtP).mul(Q96).div(sqrtP);
      const leftValue = left0.add(t1InT0(left1));
      const depValue = dep0.add(t1InT0(dep1));
      const gained = liqAfter.sub(liqBefore);
      // The symptom is a FRACTION stranded, not an absolute amount: measure leftover against what
      // the position actually accepted. An earlier version of this test used a loose absolute
      // threshold and passed against the broken 50/50 code, proving nothing.
      const strandedBps = leftValue.mul(BN(10000)).div(depValue.add(leftValue));
      console.log(`      totalLiquidity +${gained}; deposited ${dep0}/${dep1}; leftover ${left0}/${left1}`);
      console.log(`      stranded ${strandedBps}bps of the value the compound had available`);
      assert.equal(gained.gt(BN(0)), true, "the compound must actually add liquidity");
      assert.equal(strandedBps.lt(BN(500)), true,
        `compound stranded ${strandedBps}bps of its input instead of depositing it`);
    });

    it("refuses the fold swap when the route price is bad", async () => {
      // The fold leg swaps up to 100% of idle through the UL. planSwapForMint returns a minOut
      // priced off the pool; an earlier version of this fix discarded it and swapped at
      // amountOutMin = 1, which is unbounded against route quality and silent because a bad-price
      // swap still succeeds. Point the controller at a UL that delivers 40% less than fair and
      // assert the harvest REFUSES the swap rather than executing it.
      const realUL = await controller.methods.universalLiquidator().call();
      const lossy = await MockLossyUL.new(realUL, 4000, { from: gov }); // withhold 40%
      await controller.methods.setUniversalLiquidator(lossy.address).send({ from: gov, gas: 500000 });

      // Idle that needs a fold: one-sided token0 the position cannot take alone at this price.
      await ctx.t0.transfer(ctx.strategy.address, web3.utils.toWei("0.4"), { from: POOL });
      const idleBefore = BN(await ctx.t0.balanceOf(ctx.strategy.address));
      const skipsBefore = BN(await ctx.strategy.swapSkippedCount());
      assert.equal(idleBefore.gt(BN(0)), true, "test premise: there must be idle to fold");

      await advance(WINDOW + SAFETY + 60);
      await ctx.vault.doHardWork({ from: gov }); // must not revert
      const skipsAfter = BN(await ctx.strategy.swapSkippedCount());
      const idleAfter = BN(await ctx.t0.balanceOf(ctx.strategy.address));
      console.log(`      lossy route: swapSkipped ${skipsBefore}->${skipsAfter}; idle ${idleBefore}->${idleAfter}`);
      assert.equal(skipsAfter.gt(skipsBefore), true,
        "a route paying 40% below the pool quote must be refused, not executed");
      // Refusing must degrade to leaving the idle, never to bricking the harvest.
      assert.equal(idleAfter.gt(BN(0)), true, "the un-swapped idle must remain for the next cycle");
      await controller.methods.setUniversalLiquidator(realUL).send({ from: gov, gas: 500000 });
    });

    it("collects and compounds the buffer's swap fees", async () => {
      // Only the buffer earns swap fees (the staked side's go to voters via the gauge). Left
      // uncollected they accrue in feeGrowthInside and are realised only when the position is
      // touched — so reading tokensOwed straight after a swap shows 0 even though fees are owed.
      // The direct evidence is therefore the Collect event the harvest emits for the buffer.
      const bufferId = (await ctx.vault.bufferPosId()).toString();
      // Establish a baseline BEFORE any fee-generating trade: flush, then gate the reward leg out
      // and harvest again with nothing new to fold. That second harvest gives any leftover dust its
      // chance, so it cannot later be mistaken for fee income. Asserting the Collect event alone is
      // not enough — fees can be collected and then sit in the strategy forever, which is precisely
      // the P4 bug's shape — so the real claim is that liquidity RISES because of them.
      await advance(WINDOW + SAFETY + 60);
      await ctx.vault.doHardWork({ from: gov });
      await ctx.strategy.setMinRewardToCompound(AERO, web3.utils.toWei("1000000"), { from: gov });
      await advance(WINDOW + SAFETY + 60);
      const totalLIdle = BN(await ctx.vault.totalLiquidity());
      await ctx.vault.doHardWork({ from: gov });
      const totalLPre = BN(await ctx.vault.totalLiquidity());
      assert.equal(totalLPre.eq(totalLIdle), true,
        `test premise: with the reward leg gated and no new fees, a harvest must not move liquidity (${totalLIdle} -> ${totalLPre})`);

      const mover = await PriceMover.new({ from: gov });
      const tm = await MockTickMath.new({ from: gov });
      const acc = await web3.eth.getAccounts();
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [acc[8], "0x152D02C7E14AF6800000"] });
      await web3.eth.sendTransaction({ from: acc[8], to: WETH, value: web3.utils.toWei("60"), gas: 200000 });
      await ctx.t0.transfer(mover.address, web3.utils.toWei("60"), { from: acc[8] });
      // Trade through the range so the buffer earns fees, then back so it stays in range.
      await mover.move(POOL, true, web3.utils.toWei("60"), (await tm.getSqrtRatioAtTick(ctx.lower + 5)).toString(), { from: gov });
      // Target relative to where the first push actually landed: a hardcoded tick can end up on
      // the wrong side of spot and the pool rejects the limit with 'SPL'.
      const midTick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
      await ctx.t1.transfer(mover.address, "40000000", { from: POOL });
      await mover.move(POOL, false, "40000000", (await tm.getSqrtRatioAtTick(midTick + 25)).toString(), { from: gov });

      await advance(WINDOW + SAFETY + 60);
      const rc = await ctx.vault.doHardWork({ from: gov });
      // Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)
      const topic = web3.utils.keccak256("Collect(uint256,address,uint256,uint256)");
      const logs = await web3.eth.getPastLogs({
        fromBlock: rc.receipt.blockNumber, toBlock: rc.receipt.blockNumber, address: NPM2,
      });
      const collects = logs.filter(
        l => l.topics[0] === topic && BN(l.topics[1]).eq(BN(bufferId)),
      );
      let a0 = BN(0), a1 = BN(0);
      for (const l of collects) {
        const d = web3.eth.abi.decodeParameters(["address", "uint256", "uint256"], l.data);
        a0 = a0.add(BN(d[1])); a1 = a1.add(BN(d[2]));
      }
      console.log(`      Collect events for buffer ${bufferId}: ${collects.length}, fees a0=${a0} a1=${a1}`);
      assert.equal(collects.length > 0, true, "the harvest must collect the buffer position's fees");
      assert.equal(a0.gt(BN(0)) || a1.gt(BN(0)), true,
        "test premise: trading must have generated fees for the buffer, and the collect must return them");
      const totalLPost = BN(await ctx.vault.totalLiquidity());
      console.log(`      totalL ${totalLPre} -> ${totalLPost} (reward leg gated off)`);
      assert.equal(totalLPost.gt(totalLPre), true,
        "collected buffer fees must be compounded into liquidity, not left idle in the strategy");
    });
  });

    it("setSell(false) stops the strategy touching the liquidator, and selling on proves it would have", async () => {
      // V1's `sell()` gate returned before ANY liquidator interaction — it is the rapid-exit switch,
      // the thing governance flips when a UL route is broken or being manipulated. V2 added a fold to
      // that branch so collected buffer fees still compound, and the fold's planner can swap, which
      // silently took the switch away.
      //
      // Counting UL calls is the only unambiguous check: a swap never attempted and a swap that
      // returns nothing are indistinguishable by balances, and `swapSkippedCount` moves only when a
      // swap is attempted AND fails.
      //
      // This lives in THIS suite, not the security suite, because that one shares one fork across
      // all its tests: running last there meant harvesting at the largest accumulated
      // evm_increaseTime, and the gauge's reward accounting then read enough forked storage to
      // exhaust a 12GB heap. This suite resets the fork per test, so the harvest stays cheap.
      const realUL = await controller.methods.universalLiquidator().call();
      const counter = await MockCountingUL.new(realUL, { from: gov });
      await controller.methods.setUniversalLiquidator(counter.address).send({ from: gov, gas: 500000 });

      const makeIdle = async () => { await ctx.t0.transfer(ctx.strategy.address, web3.utils.toWei("0.05"), { from: POOL }); };

      await ctx.strategy.setSell(false, { from: gov });
      await makeIdle();
      await advance(WINDOW + SAFETY + 60);
      await ctx.vault.doHardWork({ from: gov });
      const offCount = BN(await counter.swapCount());

      // Premise: with selling ON and the same lopsided idle the planner DOES swap. Without this the
      // assertion above would hold for a strategy that simply never swaps, proving nothing.
      await ctx.strategy.setSell(true, { from: gov });
      await makeIdle();
      await advance(WINDOW + SAFETY + 60);
      await ctx.vault.doHardWork({ from: gov });
      const onCount = BN(await counter.swapCount());

      console.log(`      UL swaps: sell=false -> ${offCount}; then sell=true -> ${onCount}`);
      await controller.methods.setUniversalLiquidator(realUL).send({ from: gov, gas: 500000 });

      assert.equal(offCount.isZero(), true, "setSell(false) must not reach the universal liquidator at all");
      assert.equal(onCount.gt(offCount), true, "test premise: with selling on, this idle must actually be swapped");
    });
});
