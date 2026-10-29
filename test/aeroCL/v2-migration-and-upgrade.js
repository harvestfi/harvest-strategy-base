// Migration and upgrade paths for CLVaultV2.
//
// Both are places where the identical-range twin-position invariant can be silently broken: a
// strategy swap moves two NFTs that must travel together, and a proxy upgrade must carry the V2-only
// storage slots (buffer id, target ratio, band, window safety) alongside the V1 ones it was appended
// to. A failure in either corrupts share accounting rather than reverting, so these assert on state
// surviving intact, not merely on the calls succeeding.
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
const TIMELOCK = 43200; // Controller.nextImplementationDelay(), 12h
const BN = web3.utils.toBN;

const FACTORY_ABI = [{ name: "setMinStakeTime", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "p", type: "address" }, { name: "v", type: "uint256" }], outputs: [] }];

async function expectRevert(fn, needle, label) {
  let threw = false, msg = "";
  try { await fn(); } catch (e) { threw = true; msg = e.message; }
  assert.equal(threw, true, `${label}: expected revert, call succeeded`);
  if (needle) assert.equal(new RegExp(needle, "i").test(msg), true,
    `${label}: expected /${needle}/, got: ${msg.split("\n")[0]}`);
}

describe("CLVaultV2 — migration and upgrade paths", function () {
  this.timeout(3600000);
  let gov, user, vault, strategy, npm, nft, t0, t1, factory, linked = false;

  const evmNow = async () => Number((await web3.eth.getBlock("latest")).timestamp);
  const advance = async s => { await hre.network.provider.send("evm_increaseTime", [s]); await hre.network.provider.send("evm_mine"); };

  async function newStrategy() {
    const sImpl = await Strategy.new({ from: gov });
    const sProxy = await StrategyProxy.new(sImpl.address, { from: gov });
    const s = await Strategy.at(sProxy.address);
    await s.initializeBaseStrategy(addresses.Storage, vault.address, GAUGE, AERO, { from: gov });
    return s;
  }

  beforeEach(async () => {
    const acc = await web3.eth.getAccounts();
    gov = addresses.Governance; user = acc[5];
    await impersonates([gov, POOL, ADMIN]);
    for (const a of [gov, user, POOL, ADMIN]) {
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x21E19E0C9BAB2400000"] });
    }
    t0 = await IERC20.at(WETH); t1 = await IERC20.at(CBBTC);
    npm = await IPosManager.at(NPM2); nft = await IERC721.at(NPM2);
    factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);
    await factory.methods.setMinStakeTime(POOL, WINDOW).send({ from: ADMIN, gas: 500000 });

    await t0.transfer(gov, web3.utils.toWei("40"), { from: POOL });
    await t1.transfer(gov, "200000000", { from: POOL });
    await t0.approve(NPM2, web3.utils.toWei("40"), { from: gov });
    await t1.approve(NPM2, "200000000", { from: gov });

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

    if (!linked) { const lib = await CLRebalanceLibV2.new({ from: gov }); await Strategy.link(lib); linked = true; }
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
    strategy = await newStrategy();
    await vault.setStrategy(strategy.address, { from: gov });   // first set is free
    await vault.restakePosition({ from: gov });
  });

  // ==========================================================================================
  describe("strategy migration", function () {
    it("a second setStrategy is refused without an announcement", async () => {
      const next = await newStrategy();
      await expectRevert(() => vault.setStrategy(next.address, { from: gov }), "ErrTimelock|revert", "unannounced swap");
    });

    it("setStrategy is refused before the timelock elapses", async () => {
      const next = await newStrategy();
      await vault.announceStrategyUpdate(next.address, { from: gov });
      await expectRevert(() => vault.setStrategy(next.address, { from: gov }), "ErrTimelock|revert", "swap before delay");
      await advance(TIMELOCK - 600);
      await expectRevert(() => vault.setStrategy(next.address, { from: gov }), "ErrTimelock|revert", "swap just before delay");
    });

    it("a strategy announced for A cannot be swapped for B", async () => {
      const a = await newStrategy(), b = await newStrategy();
      await vault.announceStrategyUpdate(a.address, { from: gov });
      await advance(TIMELOCK + 60);
      await expectRevert(() => vault.setStrategy(b.address, { from: gov }), "ErrTimelock|revert", "bait and switch");
    });

    it("a strategy pointing at a different vault is rejected", async () => {
      // Guards against wiring a strategy whose vault() backlink is wrong, which would let it be
      // driven by one vault while accounting to another.
      const foreign = await Strategy.new({ from: gov });
      const fProxy = await StrategyProxy.new(foreign.address, { from: gov });
      const f = await Strategy.at(fProxy.address);
      await f.initializeBaseStrategy(addresses.Storage, addresses.Governance, GAUGE, AERO, { from: gov });
      await vault.announceStrategyUpdate(f.address, { from: gov });
      await advance(TIMELOCK + 60);
      await expectRevert(() => vault.setStrategy(f.address, { from: gov }), "ErrVault|revert", "foreign vault backlink");
    });

    it("migration moves BOTH positions together and preserves all accounting", async () => {
      const stakedId = (await vault.posId()).toString();
      const bufferId = (await vault.bufferPosId()).toString();
      const totalBefore = BN(await vault.totalLiquidity());
      const ppsBefore = BN(await vault.getPricePerFullShare());
      const supplyBefore = BN(await vault.totalSupply());

      const next = await newStrategy();
      await vault.announceStrategyUpdate(next.address, { from: gov });
      await advance(TIMELOCK + 60);
      await vault.setStrategy(next.address, { from: gov });

      assert.equal((await nft.ownerOf(stakedId)).toLowerCase(), next.address.toLowerCase(), "staked NFT must move");
      assert.equal((await nft.ownerOf(bufferId)).toLowerCase(), next.address.toLowerCase(), "buffer NFT must move");
      // Was `.isZero() || true`, which asserts nothing. Migration must not leave pool tokens behind
      // on the old strategy: they are unsalvagable there, so anything left is stranded permanently.
      assert.equal(BN(await t0.balanceOf(strategy.address)).isZero(), true, "old strategy must retain no token0");
      assert.equal(BN(await t1.balanceOf(strategy.address)).isZero(), true, "old strategy must retain no token1");
      assert.equal((await vault.strategy()).toLowerCase(), next.address.toLowerCase(), "vault must point at the new strategy");

      const totalAfter = BN(await vault.totalLiquidity());
      console.log(`      totalL ${totalBefore} -> ${totalAfter}   pps ${ppsBefore} -> ${(await vault.getPricePerFullShare()).toString()}`);
      assert.equal(totalAfter.eq(totalBefore), true, "migration must not change liquidity");
      assert.equal(BN(await vault.getPricePerFullShare()).eq(ppsBefore), true, "migration must not move price per share");
      assert.equal(BN(await vault.totalSupply()).eq(supplyBefore), true, "migration must not change supply");
      // The old strategy must be left holding nothing.
      assert.equal(BN(await nft.balanceOf(strategy.address)).isZero(), true, "old strategy must retain no positions");
    });

    it("the vault is fully operational on the new strategy: stake, deposit, withdraw", async () => {
      const next = await newStrategy();
      await vault.announceStrategyUpdate(next.address, { from: gov });
      await advance(TIMELOCK + 60);
      await vault.setStrategy(next.address, { from: gov });

      await vault.restakePosition({ from: gov });
      assert.equal((await nft.ownerOf(await vault.posId())).toLowerCase(), GAUGE.toLowerCase(), "new strategy must be able to stake");

      await t0.transfer(user, web3.utils.toWei("1"), { from: POOL });
      await t1.transfer(user, "5000000", { from: POOL });
      await t0.approve(vault.address, web3.utils.toWei("1"), { from: user });
      await t1.approve(vault.address, "5000000", { from: user });
      const bufBefore = BN(await vault.bufferLiquidity());
      await vault.deposit(web3.utils.toWei("1"), "5000000", 0, user, { from: user });
      assert.equal(BN(await vault.bufferLiquidity()).gt(bufBefore), true, "deposits must work post-migration");
      await vault.withdraw((await vault.balanceOf(user)).toString(), 0, 0, { from: user });
      assert.equal(BN(await vault.balanceOf(user)).isZero(), true, "withdrawals must work post-migration");
      console.log(`      post-migration deposit+withdraw round trip OK on ${next.address}`);
    });

    it("migrating inside the forfeit window does not attempt a claim", async () => {
      // unstake(compound) is called with isOutsideStakeWindow(); inside the window a claim pays
      // nothing and would simply burn the accrued AERO, so it must be skipped.
      const next = await newStrategy();
      await vault.announceStrategyUpdate(next.address, { from: gov });
      await advance(TIMELOCK + 60);
      // Reset the window right before the swap so we are demonstrably inside it. It has to be a
      // withdrawal LARGER than the buffer: anything the buffer absorbs deliberately never touches
      // the gauge and so leaves the clock alone.
      const supply = BN(await vault.totalSupply());
      await vault.withdraw(supply.mul(BN(30)).div(BN(100)).toString(), 0, 0, { from: gov });
      const inside = !(await vault.isOutsideStakeWindow());
      assert.equal(inside, true, "test premise: must actually be inside the window before migrating");
      await vault.setStrategy(next.address, { from: gov });
      const leftAero = BN(await (await IERC20.at(AERO)).balanceOf(strategy.address));
      const movedAero = BN(await (await IERC20.at(AERO)).balanceOf(next.address));
      console.log(`      migrated while inside window=${inside}; AERO left behind=${leftAero.toString()} moved=${movedAero.toString()}`);
      assert.equal((await nft.ownerOf(await vault.posId())).toLowerCase(), next.address.toLowerCase(), "positions must still migrate");
      // Claimed rewards and token dust must travel with the positions: the reward token and both
      // pool tokens are unsalvagable, so anything left here is stranded forever.
      assert.equal(leftAero.isZero(), true, "no reward token may be stranded on the old strategy");
      assert.equal(BN(await t0.balanceOf(strategy.address)).isZero(), true, "no token0 dust stranded");
      assert.equal(BN(await t1.balanceOf(strategy.address)).isZero(), true, "no token1 dust stranded");
    });
  });

    it("migration sweeps claimed rewards and token dust to the new strategy", async () => {
      // Seed the old strategy with balances directly rather than waiting on emissions: this is the
      // state after any unstake-with-claim or a compound that left dust, and it must not be left
      // behind. AERO and both pool tokens are all unsalvagable, so anything stranded here is lost
      // for good — governance has no recovery path.
      const aero = await IERC20.at(AERO);
      await impersonates([GAUGE]);
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [GAUGE, "0x21E19E0C9BAB2400000"] });
      await aero.transfer(strategy.address, web3.utils.toWei("5"), { from: GAUGE });
      await t0.transfer(strategy.address, web3.utils.toWei("0.05"), { from: POOL });
      await t1.transfer(strategy.address, "250000", { from: POOL });
      const seededAero = BN(await aero.balanceOf(strategy.address));
      assert.equal(seededAero.gt(BN(0)), true, "test premise: old strategy must hold rewards");

      const totalBefore = BN(await vault.totalLiquidity());
      const next = await newStrategy();
      await vault.announceStrategyUpdate(next.address, { from: gov });
      await advance(TIMELOCK + 60);
      await vault.setStrategy(next.address, { from: gov });

      const leftAero = BN(await aero.balanceOf(strategy.address));
      const movedAero = BN(await aero.balanceOf(next.address));
      const totalAfter = BN(await vault.totalLiquidity());
      console.log(`      AERO: seeded ${web3.utils.fromWei(seededAero)} -> left ${web3.utils.fromWei(leftAero)} / moved ${web3.utils.fromWei(movedAero)}`);
      console.log(`      dust: token0 left=${(await t0.balanceOf(strategy.address)).toString()} token1 left=${(await t1.balanceOf(strategy.address)).toString()}`);
      console.log(`      totalL ${totalBefore} -> ${totalAfter} (rewards compounded into the position)`);

      // The invariant that matters is that NOTHING is left behind on the decommissioned strategy.
      // Where it goes is either acceptable: outside the window setStrategy claims and compounds
      // first, so the value lands in the position; anything not compounded is swept to the new
      // strategy. Both keep it inside the vault; only stranding it would be a loss.
      assert.equal(leftAero.isZero(), true, "reward token must not be stranded on the decommissioned strategy");
      assert.equal(BN(await t0.balanceOf(strategy.address)).isZero(), true, "token0 dust must not be stranded");
      assert.equal(BN(await t1.balanceOf(strategy.address)).isZero(), true, "token1 dust must not be stranded");
      assert.equal(totalAfter.gt(totalBefore) || movedAero.gt(BN(0)), true,
        "the seeded value must end up either compounded into the position or on the new strategy");
    });

  // ==========================================================================================
  describe("vault proxy upgrade", function () {
    it("shouldUpgrade is false until the timelock elapses, then true", async () => {
      const nextImpl = await CLVaultV2.new({ from: gov });
      assert.equal((await vault.shouldUpgrade())[0], false, "nothing scheduled yet");
      await vault.scheduleUpgrade(nextImpl.address, { from: gov });
      assert.equal((await vault.shouldUpgrade())[0], false, "must not be upgradeable immediately");
      await advance(TIMELOCK + 60);
      const s = await vault.shouldUpgrade();
      assert.equal(s[0], true, "must be upgradeable after the delay");
      assert.equal(s[1].toLowerCase(), nextImpl.address.toLowerCase(), "must point at the scheduled impl");
    });

    it("proxy.upgrade() is refused before the delay", async () => {
      const nextImpl = await CLVaultV2.new({ from: gov });
      const proxy = await VaultProxy.at(vault.address);
      await expectRevert(() => proxy.upgrade({ from: gov }), "Upgrade not scheduled", "upgrade with nothing scheduled");
      await vault.scheduleUpgrade(nextImpl.address, { from: gov });
      await expectRevert(() => proxy.upgrade({ from: gov }), "Upgrade not scheduled", "upgrade before delay");
    });

    it("upgrade preserves EVERY V2 storage field and all user balances", async () => {
      // The V2 slots are appended after V1's; an upgrade that mis-lays them would not revert, it
      // would silently corrupt the buffer id or the target ratio and mis-price every share.
      await t0.transfer(user, web3.utils.toWei("1"), { from: POOL });
      await t1.transfer(user, "5000000", { from: POOL });
      await t0.approve(vault.address, web3.utils.toWei("1"), { from: user });
      await t1.approve(vault.address, "5000000", { from: user });
      await vault.deposit(web3.utils.toWei("1"), "5000000", 0, user, { from: user });

      const before = {
        posId: (await vault.posId()).toString(),
        bufferPosId: (await vault.bufferPosId()).toString(),
        target: (await vault.targetStakedBps()).toString(),
        band: (await vault.stakeRatioBandBps()).toString(),
        tickLower: (await vault.tickLower()).toString(),
        tickUpper: (await vault.tickUpper()).toString(),
        targetWidth: (await vault.targetWidth()).toString(),
        strategy: (await vault.strategy()).toLowerCase(),
        helper: (await vault.rebalanceHelper()).toLowerCase(),
        supply: (await vault.totalSupply()).toString(),
        userBal: (await vault.balanceOf(user)).toString(),
        totalL: (await vault.totalLiquidity()).toString(),
        pps: (await vault.getPricePerFullShare()).toString(),
      };

      const nextImpl = await CLVaultV2.new({ from: gov });
      await vault.scheduleUpgrade(nextImpl.address, { from: gov });
      await advance(TIMELOCK + 60);
      const proxy = await VaultProxy.at(vault.address);
      await proxy.upgrade({ from: gov });
      assert.equal((await proxy.implementation()).toLowerCase(), nextImpl.address.toLowerCase(), "implementation must change");

      const after = {
        posId: (await vault.posId()).toString(),
        bufferPosId: (await vault.bufferPosId()).toString(),
        target: (await vault.targetStakedBps()).toString(),
        band: (await vault.stakeRatioBandBps()).toString(),
        tickLower: (await vault.tickLower()).toString(),
        tickUpper: (await vault.tickUpper()).toString(),
        targetWidth: (await vault.targetWidth()).toString(),
        strategy: (await vault.strategy()).toLowerCase(),
        helper: (await vault.rebalanceHelper()).toLowerCase(),
        supply: (await vault.totalSupply()).toString(),
        userBal: (await vault.balanceOf(user)).toString(),
        totalL: (await vault.totalLiquidity()).toString(),
        pps: (await vault.getPricePerFullShare()).toString(),
      };
      for (const k of Object.keys(before)) {
        assert.equal(after[k], before[k], `${k} must survive the upgrade (was ${before[k]}, now ${after[k]})`);
      }
      console.log(`      all ${Object.keys(before).length} fields intact across upgrade; bufferPosId=${after.bufferPosId} target=${after.target}bps`);

      // And the pending-upgrade state must be cleared by finalizeUpgrade.
      assert.equal((await vault.shouldUpgrade())[0], false, "pending upgrade must be cleared");
    });

    it("the vault still works after an upgrade", async () => {
      const nextImpl = await CLVaultV2.new({ from: gov });
      await vault.scheduleUpgrade(nextImpl.address, { from: gov });
      await advance(TIMELOCK + 60);
      await (await VaultProxy.at(vault.address)).upgrade({ from: gov });

      await t0.transfer(user, web3.utils.toWei("1"), { from: POOL });
      await t1.transfer(user, "5000000", { from: POOL });
      await t0.approve(vault.address, web3.utils.toWei("1"), { from: user });
      await t1.approve(vault.address, "5000000", { from: user });
      await vault.deposit(web3.utils.toWei("1"), "5000000", 0, user, { from: user });
      await vault.withdraw((await vault.balanceOf(user)).toString(), 0, 0, { from: user });
      assert.equal((await nft.ownerOf(await vault.posId())).toLowerCase(), GAUGE.toLowerCase(), "must remain staked across an upgrade");
      console.log(`      post-upgrade deposit/withdraw OK, still staked`);
    });

    it("scheduleUpgrade is governance-only", async () => {
      const acc = await web3.eth.getAccounts();
      const nextImpl = await CLVaultV2.new({ from: gov });
      await expectRevert(() => vault.scheduleUpgrade(nextImpl.address, { from: acc[7] }), "revert", "outsider scheduleUpgrade");
    });
  });

  // ==========================================================================================
  describe("strategy proxy upgrade", function () {
    it("upgrading the strategy keeps both positions and the staked state", async () => {
      const stakedId = (await vault.posId()).toString();
      const bufferId = (await vault.bufferPosId()).toString();
      const totalBefore = BN(await vault.totalLiquidity());

      const nextImpl = await Strategy.new({ from: gov });
      await strategy.scheduleUpgrade(nextImpl.address, { from: gov });
      await advance(TIMELOCK + 60);
      await (await StrategyProxy.at(strategy.address)).upgrade({ from: gov });

      // The proxy address is unchanged, so the gauge's staked record and NFT ownership hold.
      assert.equal((await nft.ownerOf(stakedId)).toLowerCase(), GAUGE.toLowerCase(), "staked position must stay in the gauge");
      assert.equal((await nft.ownerOf(bufferId)).toLowerCase(), strategy.address.toLowerCase(), "buffer must stay with the strategy");
      assert.equal(BN(await vault.totalLiquidity()).eq(totalBefore), true, "liquidity must be unchanged");
      assert.equal((await strategy.bufferPosId()).toString(), bufferId, "strategy must still resolve the buffer id");
      console.log(`      strategy impl upgraded in place; staked+buffer intact, totalL=${totalBefore}`);
    });
  });
});
