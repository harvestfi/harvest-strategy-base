// Full lifecycle of the twin-position (V2) vault against the live F2 WETH/cbBTC gauge, which
// forfeits 100% of accrued AERO on any unstake inside minStakeTime.
//
// The design claim under test is narrow and checkable: user deposits and withdrawals must never
// touch the gauge, so they can neither forfeit rewards nor restart the stake window. Everything
// else follows from that.
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
const PriceMover = artifacts.require("CLPoolPriceMover");

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

const GAUGE_ABI = [
  { name: "depositTimestamp", type: "function", stateMutability: "view", inputs: [{ name: "t", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "earned", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }, { name: "t", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
];
const FACTORY_ABI = [
  { name: "setMinStakeTime", type: "function", stateMutability: "nonpayable", inputs: [{ name: "p", type: "address" }, { name: "v", type: "uint256" }], outputs: [] },
];

describe("CLVaultV2 twin-position lifecycle (F2 WETH/cbBTC)", function () {
  this.timeout(3600000);
  let gov, user, vault, strategy, npm, nft, t0, t1, gauge, factory, stakedId, bufferId;

  const evmNow = async () => Number((await web3.eth.getBlock("latest")).timestamp);
  const advance = async s => { await hre.network.provider.send("evm_increaseTime", [s]); await hre.network.provider.send("evm_mine"); };
  const stakedOwner = async () => (await nft.ownerOf(await vault.posId())).toLowerCase();
  const depositTs = async () => Number(await gauge.methods.depositTimestamp(await vault.posId()).call());

  before(async () => {
    const acc = await web3.eth.getAccounts();
    gov = addresses.Governance; user = acc[5];
    await impersonates([gov, POOL, ADMIN]);
    for (const a of [gov, user, POOL, ADMIN, acc[6]]) {
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x21E19E0C9BAB2400000"] });
    }
    t0 = await IERC20.at(WETH); t1 = await IERC20.at(CBBTC);
    npm = await IPosManager.at(NPM2); nft = await IERC721.at(NPM2);
    gauge = new web3.eth.Contract(GAUGE_ABI, GAUGE);
    factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);
    await factory.methods.setMinStakeTime(POOL, WINDOW).send({ from: ADMIN, gas: 500000 });

    await t0.transfer(gov, web3.utils.toWei("40"), { from: POOL });
    await t1.transfer(gov, "200000000", { from: POOL });
    await t0.approve(NPM2, web3.utils.toWei("40"), { from: gov });
    await t1.approve(NPM2, "200000000", { from: gov });

    // Two seeds at the SAME range: 80% of the liquidity destined for the gauge, 20% for the buffer.
    const tick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
    const lower = (Math.floor(tick / TS) - WIDTH / 2) * TS;
    const mint = async (w0, w1) => {
      const res = await npm.mint({
        token0: WETH, token1: CBBTC, tickSpacing: TS, tickLower: lower, tickUpper: lower + WIDTH * TS,
        amount0Desired: w0, amount1Desired: w1, amount0Min: 0, amount1Min: 0,
        recipient: gov, deadline: (await evmNow()) + 1800, sqrtPriceX96: 0,
      }, { from: gov });
      const evs = await nft.getPastEvents("Transfer", { fromBlock: res.receipt.blockNumber, toBlock: res.receipt.blockNumber });
      return evs.filter(e => e.returnValues.to.toLowerCase() === gov.toLowerCase()).map(e => e.returnValues.tokenId).pop();
    };
    stakedId = await mint(web3.utils.toWei("8"), "40000000");
    bufferId = await mint(web3.utils.toWei("2"), "10000000");

    // The rebalance library is delegatecalled by the STRATEGY (which owns both NFTs), so it links
    // there rather than to the vault.
    const lib = await CLRebalanceLibV2.new({ from: gov });
    await Strategy.link(lib);
    const impl = await CLVaultV2.new({ from: gov });
    const proxy = await VaultProxy.new(impl.address, { from: gov });
    vault = await CLVaultV2.at(proxy.address);
    await nft.approve(vault.address, stakedId, { from: gov });
    await nft.approve(vault.address, bufferId, { from: gov });
    await vault.initializeVault(addresses.Storage, stakedId, bufferId, NPM2, WIDTH, TARGET_BPS, BAND_BPS, SAFETY, { from: gov });
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

    console.log(`      staked=${stakedId} buffer=${bufferId}  vault=${vault.address}`);
    console.log(`      totalL=${(await vault.totalLiquidity()).toString()}  stakedBps=${(await vault.stakedRatioBps()).toString()}`);
  });

  it("wires up: both positions share a range and one owner, staked is in the gauge", async () => {
    assert.equal(await stakedOwner(), GAUGE.toLowerCase(), "staked position must be in the gauge");
    assert.equal((await nft.ownerOf(await vault.bufferPosId())).toLowerCase(), strategy.address.toLowerCase(), "buffer must be held by the strategy");
    const a = await npm.positions(await vault.posId());
    const b = await npm.positions(await vault.bufferPosId());
    assert.equal(a.tickLower.toString(), b.tickLower.toString(), "ranges must match");
    assert.equal(a.tickUpper.toString(), b.tickUpper.toString(), "ranges must match");
    const total = BN(await vault.totalLiquidity());
    assert.equal(total.eq(BN(await vault.stakedLiquidity()).add(BN(await vault.bufferLiquidity()))), true);
    console.log(`      stakedRatio=${(await vault.stakedRatioBps()).toString()}bps  target=${TARGET_BPS}bps  windowEnds=${(await vault.stakeWindowEnd()).toString()}`);
  });

  it("deposit goes to the buffer only — gauge untouched, stake clock unmoved", async () => {
    const tsBefore = await depositTs();
    const stakedBefore = BN(await vault.stakedLiquidity());
    const bufferBefore = BN(await vault.bufferLiquidity());

    await t0.transfer(user, web3.utils.toWei("1"), { from: POOL });
    await t1.transfer(user, "5000000", { from: POOL });
    await t0.approve(vault.address, web3.utils.toWei("1"), { from: user });
    await t1.approve(vault.address, "5000000", { from: user });
    await vault.deposit(web3.utils.toWei("1"), "5000000", 0, user, { from: user });

    const shares = BN(await vault.balanceOf(user));
    assert.equal(shares.gt(BN(0)), true, "deposit must mint shares");
    assert.equal(BN(await vault.stakedLiquidity()).eq(stakedBefore), true, "staked liquidity must not change");
    assert.equal(BN(await vault.bufferLiquidity()).gt(bufferBefore), true, "buffer must absorb the deposit");
    assert.equal(await stakedOwner(), GAUGE.toLowerCase(), "must never leave the gauge");
    assert.equal(await depositTs(), tsBefore, "stake clock must not restart on deposit");
    console.log(`      buffer ${bufferBefore} -> ${(await vault.bufferLiquidity()).toString()}, staked unchanged, clock unmoved`);
  });

  it("small withdraw is served from the buffer — still no gauge interaction", async () => {
    const tsBefore = await depositTs();
    const stakedBefore = BN(await vault.stakedLiquidity());
    const shares = BN(await vault.balanceOf(user)).div(BN(2));
    await vault.withdraw(shares.toString(), 0, 0, { from: user });
    assert.equal(BN(await vault.stakedLiquidity()).eq(stakedBefore), true, "staked liquidity must not change");
    assert.equal(await stakedOwner(), GAUGE.toLowerCase());
    assert.equal(await depositTs(), tsBefore, "stake clock must not restart on withdraw");
    console.log(`      withdrew ${shares} shares from buffer; staked untouched, clock unmoved`);
  });

  it("a withdraw larger than the buffer unstakes, pays out, then re-splits and re-stakes", async () => {
    // Governance holds the seed shares; redeeming a big slice forces the buffer short.
    const supply = BN(await vault.totalSupply());
    const big = supply.mul(BN(40)).div(BN(100));
    const bufferBefore = BN(await vault.bufferLiquidity());
    const tsBefore = await depositTs();
    console.log(`      redeeming ${big} of ${supply} shares; buffer holds ${bufferBefore}`);

    const rc = await vault.withdraw(big.toString(), 0, 0, { from: gov });
    const forced = rc.logs.find(l => l.event === "ForcedUnstake");
    console.log(`      ForcedUnstake emitted: ${forced ? "yes, L=" + forced.args.liquidityFromStaked.toString() : "no"}`);
    // Assert the premise: if the redemption never exceeded the buffer there was no unstake, and
    // everything below would be testing an ordinary buffer-served withdrawal instead.
    assert.notEqual(forced, undefined, "test premise: the withdrawal must have forced an unstake");
    const bufferAfter = BN(await vault.bufferLiquidity());
    console.log(`      buffer ${bufferBefore} -> ${bufferAfter} (refilled from the staked side after payout)`);
    assert.equal(bufferAfter.gt(BN(0)), true, "buffer must be refilled, not left empty, after a forced exit");

    assert.equal(await stakedOwner(), GAUGE.toLowerCase(), "must end re-staked");
    assert.notEqual(await depositTs(), tsBefore, "an unstake must restart the clock");
    const ratio = Number((await vault.stakedRatioBps()).toString());
    console.log(`      after: stakedBps=${ratio} (target ${TARGET_BPS})  totalL=${(await vault.totalLiquidity()).toString()}`);
    assert.equal(Math.abs(ratio - TARGET_BPS) <= 200, true, `ratio should be restored to target, got ${ratio}`);
  });

  it("harvest inside the window is skipped; outside it compounds into the buffer", async () => {
    const tsBefore = await depositTs();
    const rcIn = await vault.doHardWork({ from: gov });
    const skipped = (await strategy.getPastEvents("HarvestSkippedInsideWindow", { fromBlock: rcIn.receipt.blockNumber, toBlock: rcIn.receipt.blockNumber })).length > 0;
    console.log(`      inside window: skipped=${skipped}, clock unmoved=${(await depositTs()) === tsBefore}`);
    assert.equal(skipped, true, "harvest inside the window must be skipped, not attempted");
    assert.equal(await depositTs(), tsBefore, "a skipped harvest must not touch the gauge");

    await advance(WINDOW + SAFETY + 60);
    const bufferBefore = BN(await vault.bufferLiquidity());
    await vault.doHardWork({ from: gov });
    console.log(`      outside window: buffer ${bufferBefore} -> ${(await vault.bufferLiquidity()).toString()}, staked still in gauge=${(await stakedOwner()) === GAUGE.toLowerCase()}`);
    assert.equal(await stakedOwner(), GAUGE.toLowerCase(), "harvest must never unstake");
    assert.equal(await depositTs(), tsBefore, "harvest must never restart the clock");
  });

  it("range rebalance is refused inside the window and moves BOTH positions outside it", async () => {
    // Force a fresh window. It has to be a withdrawal LARGER than the buffer (~20% of total),
    // because anything the buffer can absorb deliberately never touches the gauge and so leaves
    // the stake clock untouched — which is the whole point of the design.
    const supply = BN(await vault.totalSupply());
    await vault.withdraw(supply.mul(BN(30)).div(BN(100)).toString(), 0, 0, { from: gov });
    console.log(`      forced a fresh window; windowEnds=${(await vault.stakeWindowEnd()).toString()} now=${await evmNow()}`);
    let refused = false;
    try { await vault.rebalanceCurrentTick(WIDTH, { from: gov }); } catch (e) { refused = /ErrInsideStakeWindow|revert/i.test(e.message); }
    console.log(`      inside window: rebalance refused = ${refused}`);
    assert.equal(refused, true, "rebalance must not unstake inside the window");
    assert.equal((await vault.checker())[0], false, "checker must report false inside the window");

    // Push the pool so the recentred range is genuinely DIFFERENT. Without this the helper
    // recentres onto the range we already hold and `rebalanceCurrentTick` takes its no-op path —
    // which would make every assertion below trivially true and test nothing.
    const mover = await PriceMover.new({ from: gov });
    const acc2 = await web3.eth.getAccounts();
    await web3.eth.sendTransaction({ from: acc2[6], to: WETH, value: web3.utils.toWei("400"), gas: 200000 });
    await t0.transfer(mover.address, web3.utils.toWei("400"), { from: acc2[6] });
    const tickNow = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
    const MockTickMath = artifacts.require("MockTickMath");
    const tm = await MockTickMath.new({ from: gov });
    const targetTick = Math.floor((tickNow - 60) / TS) * TS;
    await mover.move(POOL, true, web3.utils.toWei("400"), (await tm.getSqrtRatioAtTick(targetTick)).toString(), { from: gov });
    const movedTick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
    console.log(`      pushed pool tick ${tickNow} -> ${movedTick}`);

    // Let the 120s TWAP catch up so the deviation guard does not (correctly) block the rebalance.
    await advance(WINDOW + SAFETY + 400);
    const oldStaked = (await vault.posId()).toString();
    const oldBuffer = (await vault.bufferPosId()).toString();
    const totalBefore = BN(await vault.totalLiquidity());
    const rangeBefore = (await npm.positions(oldStaked)).tickLower.toString();

    await vault.rebalanceCurrentTick(WIDTH, { from: gov });

    const newStaked = (await vault.posId()).toString();
    const newBuffer = (await vault.bufferPosId()).toString();
    const a = await npm.positions(newStaked);
    const b = await npm.positions(newBuffer);
    console.log(`      staked ${oldStaked}->${newStaked}  buffer ${oldBuffer}->${newBuffer}`);
    console.log(`      new range [${a.tickLower},${a.tickUpper}]  both match=${a.tickLower.toString() === b.tickLower.toString() && a.tickUpper.toString() === b.tickUpper.toString()}`);
    console.log(`      totalL ${totalBefore} -> ${(await vault.totalLiquidity()).toString()}  stakedBps=${(await vault.stakedRatioBps()).toString()}`);
    assert.notEqual(newStaked, oldStaked, "a real rebalance must mint a NEW staked position");
    assert.notEqual(newBuffer, oldBuffer, "a real rebalance must mint a NEW buffer position");
    assert.notEqual(a.tickLower.toString(), String(rangeBefore), "the range must actually have moved");
    assert.equal(a.tickLower.toString(), b.tickLower.toString(), "both positions must share the new range");
    assert.equal(a.tickUpper.toString(), b.tickUpper.toString(), "both positions must share the new range");
    assert.equal(await stakedOwner(), GAUGE.toLowerCase(), "must be re-staked after rebalance");
    assert.equal(BN(await vault.bufferLiquidity()).gt(BN(0)), true, "buffer must be re-seeded after a rebalance");
    // A range rebalance re-mints BOTH positions with the freed tokens split by targetStakedBps, so
    // it restores the stake ratio as a side effect. The keeper ordering depends on that being true
    // (range before ratio, so one window restart clears both), so assert it rather than assume it.
    const ratioAfter = Number((await vault.stakedRatioBps()).toString());
    console.log(`      stake ratio after range rebalance: ${ratioAfter}bps (target ${TARGET_BPS})`);
    assert.equal(Math.abs(ratioAfter - TARGET_BPS) <= 100, true,
      `range rebalance must also restore the stake ratio, got ${ratioAfter}`);
  });

  it("share value is never diluted by a deposit/withdraw round trip", async () => {
    const ppsBefore = BN(await vault.getPricePerFullShare());
    await t0.transfer(user, web3.utils.toWei("1"), { from: POOL });
    await t1.transfer(user, "5000000", { from: POOL });
    await t0.approve(vault.address, web3.utils.toWei("1"), { from: user });
    await t1.approve(vault.address, "5000000", { from: user });
    await vault.deposit(web3.utils.toWei("1"), "5000000", 0, user, { from: user });
    const ppsMid = BN(await vault.getPricePerFullShare());
    await vault.withdraw((await vault.balanceOf(user)).toString(), 0, 0, { from: user });
    const ppsAfter = BN(await vault.getPricePerFullShare());
    console.log(`      pps ${ppsBefore} -> ${ppsMid} -> ${ppsAfter}`);
    // A round trip must not move value away from existing holders.
    assert.equal(ppsAfter.gte(ppsBefore.mul(BN(9999)).div(BN(10000))), true, "round trip must not dilute existing holders");
  });
});
