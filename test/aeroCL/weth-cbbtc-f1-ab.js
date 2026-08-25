// End-to-end rehearsal of the WETH/cbBTC (F1) three-arm deployment: three vaults on the SAME pool
// and gauge, identical settings except posWidth (4 / 8 / 16). Proves the arms can be deployed,
// staked, used and rebalanced side by side before any mainnet transaction is sent.
//
// This is the tickSpacing-100 pool on the FIRST Slipstream deployment. Its gauge has no early-exit
// penalty, unlike the tickSpacing-10 F2 pool covered by test/aeroCL/f2-lifecycle.js.
const { impersonates } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

const VaultProxy = artifacts.require("VaultProxy");
const CLVault = artifacts.require("CLVault");
const CLRebalanceHelper = artifacts.require("CLRebalanceHelper");
const StrategyProxy = artifacts.require("StrategyProxy");
const Strategy = artifacts.require("AerodromeCLStrategyMainnet_WETH_cbBTC_F1");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const IPool = artifacts.require("contracts/base/interface/concentrated-liquidity/IPool.sol:IPool");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IERC721 = artifacts.require("IERC721");
const MockTickMath = artifacts.require("MockTickMath");
const PriceMover = artifacts.require("CLPoolPriceMover");

const POOL  = "0x70aCDF2Ad0bf2402C957154f944c19Ef4e1cbAE1"; // WETH/cbBTC ts=100 (F1)
const GAUGE = "0x41b2126661C673C2beDd208cC72E85DC51a5320a";
const NPM   = "0x827922686190790b37229fd06084350E74485b72";
const WETH  = "0x4200000000000000000000000000000000000006"; // token0, 18 dec
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"; // token1,  8 dec
const TS = 100;
const WIDTHS = [4, 8, 16];

const E18 = (n) => web3.utils.toBN(10).pow(web3.utils.toBN(18)).muln(n).toString();
const E8  = (n) => web3.utils.toBN(10).pow(web3.utils.toBN(8)).muln(n).toString();
const BN = web3.utils.toBN;

describe("WETH/cbBTC F1 three-arm deployment rehearsal (posWidth 4 / 8 / 16)", function () {
  this.timeout(1800000);
  let governance, user, helper, npm, t0, t1, tick;
  const arms = {};

  before(async () => {
    const accounts = await web3.eth.getAccounts();
    governance = addresses.Governance;
    user = accounts[4];
    await impersonates([governance, POOL]);
    for (const a of [governance, user, POOL]) {
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x21E19E0C9BAB2400000"] });
    }
    t0 = await IERC20.at(WETH);
    t1 = await IERC20.at(CBBTC);
    npm = await IPosManager.at(NPM);
    // fund from the pool's own reserves (fork-only convenience)
    await t0.transfer(governance, E18(300), { from: POOL });
    await t1.transfer(governance, E8(12), { from: POOL });
    tick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
    helper = await CLRebalanceHelper.new();
    console.log(`      pool tick=${tick}  helper=${helper.address}`);
  });

  // Same centring the deploy script and prepareRebalance use
  function rangeFor(width) {
    const mid = Math.floor(tick / TS);
    const lower = (width === 1 ? mid : mid - Math.floor(width / 2)) * TS;
    return [lower, lower + width * TS];
  }

  for (const width of WIDTHS) {
    it(`mints a ${width * TS}-tick seed and deploys the posWidth=${width} vault`, async () => {
      const [tickLower, tickUpper] = rangeFor(width);
      assert.equal(tickLower < tick && tick < tickUpper, true, "seed range must straddle spot");
      await t0.approve(NPM, E18(60), { from: governance });
      await t1.approve(NPM, E8(3), { from: governance });
      const res = await npm.mint({
        token0: WETH, token1: CBBTC, tickSpacing: TS, tickLower, tickUpper,
        amount0Desired: E18(50), amount1Desired: E8(2),
        amount0Min: 0, amount1Min: 0, recipient: governance,
        deadline: Math.floor(Date.now() / 1000) + 1800, sqrtPriceX96: 0,
      }, { from: governance });
      const nft = await IERC721.at(NPM);
      const evs = await nft.getPastEvents("Transfer", { fromBlock: res.receipt.blockNumber, toBlock: res.receipt.blockNumber });
      const posId = evs.filter(e => e.returnValues.to.toLowerCase() === governance.toLowerCase())
                       .map(e => e.returnValues.tokenId).pop();

      const impl = await CLVault.new();
      const proxy = await VaultProxy.new(impl.address);
      const vault = await CLVault.at(proxy.address);
      await nft.approve(vault.address, posId, { from: governance });
      await vault.initializeVault(addresses.Storage, posId, NPM, width, { from: governance });
      await vault.setRebalanceHelper(helper.address, { from: governance });
      // identical to scripts/config/weth-cbbtc-f1-w*.json (copied from the live tBTC/cbBTC vault)
      await vault.setRebalanceSafetyConfig(10000, 100, 120, 200, { from: governance });
      await vault.setRebalanceConfig(0, 5, "0xaba4ba582E04B729ABCd2Bae0d7c14fe21C9F510", { from: governance });
      await vault.setLanePause(false, false, false, false, { from: governance });

      const sImpl = await Strategy.new();
      const sProxy = await StrategyProxy.new(sImpl.address);
      const strategy = await Strategy.at(sProxy.address);
      await strategy.initializeStrategy(addresses.Storage, vault.address, { from: governance });
      await vault.setStrategy(strategy.address, { from: governance });

      arms[width] = { vault, strategy, posId, tickLower, tickUpper };
      const onchainWidth = (parseInt((await vault.tickUpper()).toString()) - parseInt((await vault.tickLower()).toString())) / TS;
      console.log(`      w${width}: posId=${posId} range=[${tickLower},${tickUpper}] posWidth=${onchainWidth} vault=${vault.address}`);
      assert.equal(onchainWidth, width, "seed width must equal targetWidth");
      assert.equal((await vault.targetWidth()).toString(), String(width));
      assert.equal((await strategy.rewardPool()).toLowerCase(), GAUGE.toLowerCase());
      assert.equal((await vault.token0()).toLowerCase(), WETH.toLowerCase());
      assert.equal((await vault.token1()).toLowerCase(), CBBTC.toLowerCase());
    });
  }

  it("all three vaults stake into the same gauge and coexist", async () => {
    const nft = await IERC721.at(NPM);
    const g = new web3.eth.Contract([{ name: "stakedContains", type: "function", stateMutability: "view",
      inputs: [{ name: "d", type: "address" }, { name: "t", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }], GAUGE);
    for (const w of WIDTHS) {
      await arms[w].vault.doHardWork({ from: governance });
      const owner = await nft.ownerOf(arms[w].posId);
      assert.equal(owner.toLowerCase(), GAUGE.toLowerCase(), `w${w} must be staked`);
      const mine = await g.methods.stakedContains(arms[w].strategy.address, arms[w].posId).call();
      const others = [];
      for (const o of WIDTHS.filter(x => x !== w)) {
        others.push(await g.methods.stakedContains(arms[o].strategy.address, arms[w].posId).call());
      }
      console.log(`      w${w}: staked=true  stakedContains(own)=${mine}  (others)=[${others.join(",")}]`);
      assert.equal(mine, true);
      assert.equal(others.every(x => x === false), true, `w${w} must not be attributed to another arm`);
    }
  });

  it("deposit + withdraw work on every arm and leave them staked", async () => {
    const nft = await IERC721.at(NPM);
    for (const w of WIDTHS) {
      const { vault } = arms[w];
      await t0.transfer(user, E18(2), { from: POOL });
      await t1.transfer(user, "10000000", { from: POOL }); // 0.1 cbBTC
      await t0.approve(vault.address, E18(2), { from: user });
      await t1.approve(vault.address, "10000000", { from: user });
      const before0 = BN(await t0.balanceOf(user)), before1 = BN(await t1.balanceOf(user));
      await vault.deposit(E18(2), "10000000", 0, user, { from: user });
      const shares = BN(await vault.balanceOf(user));
      assert.equal(shares.gt(BN("0")), true, `w${w} deposit must mint shares`);
      await vault.withdraw(shares.toString(), 0, 0, { from: user });
      const d0 = before0.sub(BN(await t0.balanceOf(user))), d1 = before1.sub(BN(await t1.balanceOf(user)));
      const owner = await nft.ownerOf(await vault.posId());
      console.log(`      w${w}: round-trip cost WETH=${web3.utils.fromWei(d0.toString())} cbBTC=${(Number(d1.toString()) / 1e8).toFixed(8)}  staked-after=${owner.toLowerCase() === GAUGE.toLowerCase()}`);
      assert.equal(owner.toLowerCase(), GAUGE.toLowerCase(), `w${w} must be re-staked after withdraw`);
    }
  });

  it("rebalance works on every arm, preserves posWidth and stays staked", async () => {
    const nft = await IERC721.at(NPM);
    for (const w of WIDTHS) {
      const { vault } = arms[w];
      const before = (await vault.posId()).toString();
      await vault.rebalanceCurrentTick(w, { from: governance });
      const after = (await vault.posId()).toString();
      const lo = parseInt((await vault.tickLower()).toString()), hi = parseInt((await vault.tickUpper()).toString());
      const owner = await nft.ownerOf(after);
      // leftover idle after the rebalance is the number the 50%-stranding bug used to blow up
      const idle0 = BN(await t0.balanceOf(vault.address)), idle1 = BN(await t1.balanceOf(vault.address));
      console.log(`      w${w}: posId ${before} -> ${after}  range=[${lo},${hi}] width=${(hi - lo) / TS}  staked=${owner.toLowerCase() === GAUGE.toLowerCase()}  idle WETH=${web3.utils.fromWei(idle0.toString())} cbBTC=${(Number(idle1.toString()) / 1e8).toFixed(8)}`);
      assert.equal((hi - lo) / TS, w, `w${w} width must be preserved`);
      assert.equal(owner.toLowerCase(), GAUGE.toLowerCase(), `w${w} must stay staked (no-op rebalance included)`);
    }
  });

  it("reports the value-per-share metric to compare the arms on", async () => {
    for (const w of WIDTHS) {
      const { vault, strategy } = arms[w];
      const sqrt = BN(await vault.getSqrtPriceX96());
      const amts = await vault.getCurrentTokenAmounts();
      const idle0 = BN(await t0.balanceOf(vault.address)).add(BN(await t0.balanceOf(strategy.address)));
      const idle1 = BN(await t1.balanceOf(vault.address)).add(BN(await t1.balanceOf(strategy.address)));
      const a0 = BN(amts[0]).add(idle0), a1 = BN(amts[1]).add(idle1);
      const Q96 = BN(2).pow(BN(96));
      const v = a0.mul(sqrt).div(Q96).mul(sqrt).div(Q96).add(a1); // cbBTC-denominated
      const supply = BN(await vault.totalSupply());
      console.log(`      w${w}: value=${(Number(v.toString()) / 1e8).toFixed(8)} cbBTC  supply=${supply.toString()}  PPS=${(await vault.getPricePerFullShare()).toString()}`);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // A real rebalance needs a position that is NOT centred on spot. Rather than moving the pool to
  // create that (which distorts the very venue the UniversalLiquidator routes through, and so
  // measures the test's own damage instead of the strategy), mint seeds deliberately off-centre:
  // a range entirely above spot holds only token0, a range entirely below spot holds only token1.
  // Recentring either one forces a genuine burn -> swap -> mint at undisturbed market prices.
  // ---------------------------------------------------------------------------------------------
  const skews = {};

  for (const side of ["above", "below"]) {
    it(`rebalances a one-sided position seeded ${side} spot, with no stranded funds`, async () => {
      const nft = await IERC721.at(NPM);
      const W = 8;
      // 600 ticks clear of spot so the seed is unambiguously single-sided
      const lowerUnits = side === "above" ? Math.ceil((tick + 600) / TS) : Math.floor((tick - 600) / TS) - W;
      const tickLower = lowerUnits * TS, tickUpper = tickLower + W * TS;
      const oneSided = side === "above" ? "WETH (token0)" : "cbBTC (token1)";
      assert.equal(side === "above" ? tickLower > tick : tickUpper < tick, true, "seed must not straddle spot");

      await t0.approve(NPM, E18(20), { from: governance });
      await t1.approve(NPM, E8(1), { from: governance });
      const res = await npm.mint({
        token0: WETH, token1: CBBTC, tickSpacing: TS, tickLower, tickUpper,
        amount0Desired: side === "above" ? E18(5) : "0",
        amount1Desired: side === "below" ? "15000000" : "0", // 0.15 cbBTC
        amount0Min: 0, amount1Min: 0, recipient: governance,
        deadline: Math.floor(Date.now() / 1000) + 1800, sqrtPriceX96: 0,
      }, { from: governance });
      const evs = await nft.getPastEvents("Transfer", { fromBlock: res.receipt.blockNumber, toBlock: res.receipt.blockNumber });
      const posId = evs.filter(e => e.returnValues.to.toLowerCase() === governance.toLowerCase())
                       .map(e => e.returnValues.tokenId).pop();

      const impl = await CLVault.new();
      const proxy = await VaultProxy.new(impl.address);
      const vault = await CLVault.at(proxy.address);
      await nft.approve(vault.address, posId, { from: governance });
      await vault.initializeVault(addresses.Storage, posId, NPM, W, { from: governance });
      await vault.setRebalanceHelper(helper.address, { from: governance });
      await vault.setRebalanceSafetyConfig(10000, 100, 120, 200, { from: governance });
      await vault.setRebalanceConfig(0, 5, "0xaba4ba582E04B729ABCd2Bae0d7c14fe21C9F510", { from: governance });
      await vault.setLanePause(false, false, false, false, { from: governance });
      const sImpl = await Strategy.new();
      const sProxy = await StrategyProxy.new(sImpl.address);
      const strategy = await Strategy.at(sProxy.address);
      await strategy.initializeStrategy(addresses.Storage, vault.address, { from: governance });
      await vault.setStrategy(strategy.address, { from: governance });
      await vault.doHardWork({ from: governance });

      const Q96 = BN(2).pow(BN(96));
      const sqrt0 = BN(await vault.getSqrtPriceX96());
      const val = (a0, a1, sq) => a0.mul(sq).div(Q96).mul(sq).div(Q96).add(a1);
      const pre = await vault.getCurrentTokenAmounts();
      const preVal = val(BN(pre[0]), BN(pre[1]), sqrt0);
      console.log(`      ${side}: seed range=[${tickLower},${tickUpper}] spot tick=${tick} -> holds only ${oneSided}, ` +
        `value=${(Number(preVal.toString()) / 1e8).toFixed(8)} cbBTC`);

      // 0x42301c23 = InsufficientOutputAmount() from the Aerodrome v2 router the UniversalLiquidator
      // currently routes WETH<->cbBTC through. Until governance re-registers this pair on the
      // aeroCL adapter it is a launch blocker, asserted in test/aeroCL/ul-execution-quality.js.
      let blocked = false;
      try {
        await vault.rebalanceCurrentTick(W, { from: governance });
      } catch (e) {
        if (!e.message.includes("0x42301c23")) throw e;
        blocked = true;
      }
      if (blocked) {
        const idleV0 = BN(await t0.balanceOf(vault.address)).add(BN(await t0.balanceOf(strategy.address)));
        const idleV1 = BN(await t1.balanceOf(vault.address)).add(BN(await t1.balanceOf(strategy.address)));
        console.log(`      ${side}: BLOCKED - UniversalLiquidator cannot fill within maxSlippageBps=100. ` +
          `Position untouched, idle WETH=${idleV0.toString()} cbBTC=${idleV1.toString()}. ` +
          `See test/aeroCL/ul-execution-quality.js for the required registry fix.`);
        assert.equal(idleV0.isZero() && idleV1.isZero(), true, "a refused rebalance must not strand funds");
        assert.equal((await nft.ownerOf(await vault.posId())).toLowerCase(), GAUGE.toLowerCase(), "must stay staked");
        return;
      }

      const lo = parseInt((await vault.tickLower()).toString()), hi = parseInt((await vault.tickUpper()).toString());
      const sqrt1 = BN(await vault.getSqrtPriceX96());
      const amts = await vault.getCurrentTokenAmounts();
      const idle0 = BN(await t0.balanceOf(vault.address)).add(BN(await t0.balanceOf(strategy.address)));
      const idle1 = BN(await t1.balanceOf(vault.address)).add(BN(await t1.balanceOf(strategy.address)));
      const inPos = val(BN(amts[0]), BN(amts[1]), sqrt1);
      const stranded = val(idle0, idle1, sqrt1);
      const total = inPos.add(stranded);
      const bps = total.isZero() ? 0 : Number(stranded.mul(BN(10000)).div(total).toString());
      const kept = Number(total.toString()) / Number(preVal.toString());
      const owner = await nft.ownerOf(await vault.posId());

      console.log(`      ${side}: new range=[${lo},${hi}] width=${(hi - lo) / TS}  staked=${owner.toLowerCase() === GAUGE.toLowerCase()}  ` +
        `in-position=${(Number(inPos.toString()) / 1e8).toFixed(8)} cbBTC  stranded=${bps} bps  ` +
        `value kept through burn+swap+mint=${(kept * 100).toFixed(2)}%`);

      skews[side] = { bps, kept };
      assert.equal((hi - lo) / TS, W, "width must be preserved");
      assert.equal(lo < tick && tick < hi, true, "new range must straddle spot");
      assert.equal(owner.toLowerCase(), GAUGE.toLowerCase(), "must be re-staked after rebalance");
      assert.equal(bps < 100, true, `stranded ${bps} bps - the 50%-stranding regression is back`);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Everything above rebalances at the seed centre, so `rebalanceCurrentTick` short-circuits on the
  // no-op path. The bug that stranded ~50% of funds on mainnet only shows up when the position has
  // gone one-sided, so push the real pool and rebalance again for real.
  // ---------------------------------------------------------------------------------------------
  let movedTick;

  it("pushes the pool price down so the arms go out of range", async () => {
    const accounts = await web3.eth.getAccounts();
    const whale = accounts[6];
    await hre.network.provider.request({ method: "hardhat_setBalance", params: [whale, "0x54B40B1F852BDA000000"] }); // 400k ETH
    const mover = await PriceMover.new();
    const tm = await MockTickMath.new();

    // wrap ETH -> WETH and hand it to the mover; taking it from the pool instead would make the
    // pool insolvent for the very swap we are about to route through it
    await web3.eth.sendTransaction({ from: whale, to: WETH, value: E18(100000), gas: 200000 });
    await t0.transfer(mover.address, E18(100000), { from: whale });

    const target = movedTickTarget();
    const limit = (await tm.getSqrtRatioAtTick(target)).toString();
    await mover.move(POOL, true /* zeroForOne: WETH in, price down */, E18(100000), limit);

    movedTick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
    console.log(`      tick ${tick} -> ${movedTick}  (moved ${movedTick - tick} ticks, target was ${target})`);
    assert.equal(movedTick < tick - 200, true, "price must have moved far enough to matter");
    for (const w of WIDTHS) {
      const inRange = arms[w].tickLower < movedTick && movedTick < arms[w].tickUpper;
      console.log(`      w${w}: range=[${arms[w].tickLower},${arms[w].tickUpper}] now ${inRange ? "IN range (skewed)" : "OUT of range (one-sided)"}`);
    }
  });

  function movedTickTarget() {
    // A 3.5% move: enough to take w4 fully out of range (one-sided) and leave w8/w16 skewed, while
    // staying well inside the pool's own 14d p1-p99 band of 11.5%. Moving further (we tried 600
    // ticks) drains so much cbBTC from the pool that the rebalance swap itself can no longer clear
    // any sane slippage bound - that is an artefact of the test, not of the strategy.
    return Math.floor((tick - 350) / TS) * TS;
  }

  it("rejects the rebalance while spot is still outside the TWAP band", async () => {
    // maxTwapDeviationBps=200: a 6% instantaneous move must not be rebalanceable, otherwise the
    // executor could be induced to rebalance into a manipulated price
    let reverted = false;
    try {
      await arms[4].vault.rebalanceCurrentTick(4, { from: governance });
    } catch (e) {
      reverted = true;
      console.log(`      w4 rebalance correctly reverted: ${e.message.split("\n")[0].slice(0, 120)}`);
    }
    assert.equal(reverted, true, "TWAP deviation guard must block a rebalance right after a large move");
  });

  it("after a large move, a rebalance either completes cleanly or refuses - never strands funds", async () => {
    // By this point the test has itself pushed ~100k WETH through the pool, so the venue the
    // UniversalLiquidator routes through is depleted and a large swap may legitimately fail the
    // slippage guard. Both outcomes are acceptable; the invariant under test is that a refused
    // rebalance is a no-op and a completed one leaves nothing behind.
    const nft = await IERC721.at(NPM);
    const Q96 = BN(2).pow(BN(96));
    await hre.network.provider.send("evm_increaseTime", [1800]);
    await hre.network.provider.send("evm_mine");
    const mover = await PriceMover.new();
    await t0.transfer(mover.address, E18(1), { from: POOL });
    const tm = await MockTickMath.new();
    await mover.move(POOL, true, E18(1), (await tm.getSqrtRatioAtTick(Math.floor((movedTick - 200) / TS) * TS)).toString());
    await hre.network.provider.send("evm_increaseTime", [60]);
    await hre.network.provider.send("evm_mine");
    const nowTick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
    console.log(`      TWAP settled; spot tick=${nowTick}`);

    for (const w of WIDTHS) {
      const { vault, strategy } = arms[w];
      await hre.network.provider.send("evm_increaseTime", [3700]); // clear the 3600s cooldown
      await hre.network.provider.send("evm_mine");
      const before = (await vault.posId()).toString();
      let refused = null;
      try {
        await vault.rebalanceCurrentTick(w, { from: governance });
      } catch (e) {
        refused = e.message.split("\n")[0];
      }
      const after = (await vault.posId()).toString();
      const owner = await nft.ownerOf(after);
      const sqrt = BN(await vault.getSqrtPriceX96());
      const amts = await vault.getCurrentTokenAmounts();
      const idle0 = BN(await t0.balanceOf(vault.address)).add(BN(await t0.balanceOf(strategy.address)));
      const idle1 = BN(await t1.balanceOf(vault.address)).add(BN(await t1.balanceOf(strategy.address)));
      const val = (a0, a1) => a0.mul(sqrt).div(Q96).mul(sqrt).div(Q96).add(a1);
      const inPos = val(BN(amts[0]), BN(amts[1]));
      const stranded = val(idle0, idle1);
      const total = inPos.add(stranded);
      const bps = total.isZero() ? 0 : Number(stranded.mul(BN(10000)).div(total).toString());

      if (refused) {
        console.log(`      w${w}: refused (${refused.slice(0, 72)}) - position untouched, stranded=${bps} bps`);
        assert.equal(after, before, `w${w} a refused rebalance must not change the position`);
      } else {
        const lo = parseInt((await vault.tickLower()).toString()), hi = parseInt((await vault.tickUpper()).toString());
        console.log(`      w${w}: completed -> range=[${lo},${hi}] width=${(hi - lo) / TS}  stranded=${bps} bps`);
        assert.equal((hi - lo) / TS, w, `w${w} width must be preserved`);
      }
      assert.equal(owner.toLowerCase(), GAUGE.toLowerCase(), `w${w} must be staked either way`);
      assert.equal(bps < 100, true, `w${w} stranded ${bps} bps`);
    }
  });
});
