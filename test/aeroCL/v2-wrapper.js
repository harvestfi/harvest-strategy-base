// CLWrapperV2 — single-asset (ERC4626-style) wrapper around the twin-position CLVaultV2.
//
// The contract is a line-for-line copy of CLWrapper retargeted to ICLVaultV2, so the point of this
// suite is NOT to re-derive the V1 wrapper's maths. It is to prove the two things a copy cannot
// prove on its own: that every V1 case still passes when the vault underneath holds TWO positions,
// and that the wrapper's NAV sees both of them rather than only the staked side.
const { impersonates } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

const VaultProxy = artifacts.require("VaultProxy");
const StrategyProxy = artifacts.require("StrategyProxy");
const CLVaultV2 = artifacts.require("CLVaultV2");
const CLRebalanceLibV2 = artifacts.require("CLRebalanceLibV2");
const Strategy = artifacts.require("AerodromeCLStrategyV2");
const CLWrapperV2 = artifacts.require("CLWrapperV2");
const ICLRebalanceHelper = artifacts.require("ICLRebalanceHelper");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IERC721 = artifacts.require("IERC721");
const PriceMover = artifacts.require("CLPoolPriceMover");
const MockTickMath = artifacts.require("MockTickMath");

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
const FACTORY_ABI = [{ name: "setMinStakeTime", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "p", type: "address" }, { name: "v", type: "uint256" }], outputs: [] }];

let linkedLibAddr = null;

describe("CLWrapperV2 (twin-position WETH/cbBTC)", function () {
  this.timeout(3600000);
  let gov, u1, u2, vault, strategy, npm, nft, t0, t1, w0, w1;

  beforeEach(async () => {
    await hre.network.provider.request({ method: "hardhat_reset", params: [{
      forking: { jsonRpcUrl: hre.network.config.forking.url, blockNumber: hre.network.config.forking.blockNumber },
    }] });
    const acc = await web3.eth.getAccounts();
    gov = addresses.Governance; u1 = acc[5]; u2 = acc[6];
    await impersonates([gov, POOL, ADMIN]);
    for (const a of [gov, u1, u2, POOL, ADMIN]) {
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x152D02C7E14AF6800000"] });
    }
    await new web3.eth.Contract(FACTORY_ABI, FACTORY).methods.setMinStakeTime(POOL, WINDOW).send({ from: ADMIN, gas: 500000 });

    t0 = await IERC20.at(WETH); t1 = await IERC20.at(CBBTC);
    npm = await IPosManager.at(NPM2); nft = await IERC721.at(NPM2);
    await t0.transfer(gov, web3.utils.toWei("40"), { from: POOL });
    await t1.transfer(gov, "200000000", { from: POOL });
    await t0.approve(NPM2, web3.utils.toWei("40"), { from: gov });
    await t1.approve(NPM2, "200000000", { from: gov });

    const now = Number((await web3.eth.getBlock("latest")).timestamp);
    const IPool = artifacts.require("contracts/base/interface/concentrated-liquidity/IPool.sol:IPool");
    const tick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
    const lower = (Math.floor(tick / TS) - WIDTH / 2) * TS;
    const mint = async (a0, a1) => {
      const res = await npm.mint({ token0: WETH, token1: CBBTC, tickSpacing: TS, tickLower: lower,
        tickUpper: lower + WIDTH * TS, amount0Desired: a0, amount1Desired: a1, amount0Min: 0,
        amount1Min: 0, recipient: gov, deadline: now + 1800, sqrtPriceX96: 0 }, { from: gov });
      const evs = await nft.getPastEvents("Transfer", { fromBlock: res.receipt.blockNumber, toBlock: res.receipt.blockNumber });
      return evs.filter(e => e.returnValues.to.toLowerCase() === gov.toLowerCase()).map(e => e.returnValues.tokenId).pop();
    };
    const stakedId = await mint(web3.utils.toWei("8"), "40000000");
    const bufferId = await mint(web3.utils.toWei("2"), "10000000");

    const lib = await CLRebalanceLibV2.new({ from: gov });
    if (linkedLibAddr === null) { await Strategy.link(lib); linkedLibAddr = lib.address; }
    assert.equal(lib.address, linkedLibAddr, "library must redeploy to the linked address");
    assert.notEqual(await web3.eth.getCode(linkedLibAddr), "0x", "linked library must have code");

    const impl = await CLVaultV2.new({ from: gov });
    vault = await CLVaultV2.at((await VaultProxy.new(impl.address, { from: gov })).address);
    await nft.approve(vault.address, stakedId, { from: gov });
    await nft.approve(vault.address, bufferId, { from: gov });
    await vault.initializeVault(addresses.Storage, stakedId, bufferId, NPM2, WIDTH, TARGET_BPS, BAND_BPS, SAFETY, { from: gov });
    await vault.setRebalanceHelper(HELPER, { from: gov });
    await vault.setRebalanceSafetyConfig(10000, 100, 120, 200, { from: gov });
    await vault.setRebalanceConfig(0, 5, gov, { from: gov });
    await vault.setLanePause(false, false, false, false, { from: gov });

    const sImpl = await Strategy.new({ from: gov });
    strategy = await Strategy.at((await StrategyProxy.new(sImpl.address, { from: gov })).address);
    await strategy.initializeBaseStrategy(addresses.Storage, vault.address, GAUGE, AERO, { from: gov });
    await vault.setStrategy(strategy.address, { from: gov });
    await vault.restakePosition({ from: gov });

    // The wrapper reads token0/token1/rebalanceHelper/posManager/tickSpacing in its constructor, so
    // it can only be built after the vault is fully configured.
    w0 = await CLWrapperV2.new(addresses.Storage, vault.address, true, { from: gov });   // asset = token0
    w1 = await CLWrapperV2.new(addresses.Storage, vault.address, false, { from: gov });  // asset = token1
  });

  // NOTE: these tests deliberately run at the UNTOUCHED previewSafetyBps default of 25. The 2-arg
  // deposit/redeem no longer pass the preview as their minimum -- the floor is derived from state
  // after the swap -- so no per-pair tuning is needed for execution any more.
  // A few wei on each side of the strategy: below what a mint can consume, so the flush cannot
  // fully absorb it, which is exactly the state that exposes a basis mismatch.
  // Donate idle the flush CANNOT fold. Pushing the pool below the range makes the position purely
  // token0, so token1 sitting on the strategy can never be minted into it — which is exactly the
  // state that exposes a mint/floor basis mismatch. A plain in-range dust donation does NOT
  // reproduce it: the flush simply absorbs it.
  async function donateUnfoldable() {
    const mover = await PriceMover.new({ from: gov });
    const tm = await MockTickMath.new({ from: gov });
    const acc = await web3.eth.getAccounts();
    await hre.network.provider.request({ method: "hardhat_setBalance", params: [acc[8], "0x152D02C7E14AF6800000"] });
    await web3.eth.sendTransaction({ from: acc[8], to: WETH, value: web3.utils.toWei("600"), gas: 200000 });
    await t0.transfer(mover.address, web3.utils.toWei("600"), { from: acc[8] });
    const lower = parseInt((await vault.tickLower()).toString(), 10);
    const target = Math.floor((lower - 30) / TS) * TS;
    await mover.move(POOL, true, web3.utils.toWei("600"), (await tm.getSqrtRatioAtTick(target)).toString(), { from: gov });
    const IPool = artifacts.require("contracts/base/interface/concentrated-liquidity/IPool.sol:IPool");
    const tick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
    assert.equal(tick < lower, true, `test premise: pool must be below the range (tick ${tick}, lower ${lower})`);
    await t1.transfer(strategy.address, "250000", { from: POOL }); // unusable side
    return tick;
  }

  async function fundAsset(who, wrapper) {
    const asset = await wrapper.asset();
    if (asset.toLowerCase() === WETH.toLowerCase()) {
      await t0.transfer(who, web3.utils.toWei("2"), { from: POOL });
      await t0.approve(wrapper.address, web3.utils.toWei("2"), { from: who });
      return { tok: t0, amt: web3.utils.toWei("1") };
    }
    await t1.transfer(who, "20000000", { from: POOL });
    await t1.approve(wrapper.address, "20000000", { from: who });
    return { tok: t1, amt: "5000000" };
  }

  describe("[asset = token0]", function () {
    it("constructor wires asset/vault/pool correctly", async () => {
      assert.equal((await w0.asset()).toLowerCase(), WETH.toLowerCase());
      assert.equal((await w0.vault()).toLowerCase(), vault.address.toLowerCase());
      assert.equal((await w0.pool()).toLowerCase(), POOL.toLowerCase());
      assert.equal((await w0.previewSafetyBps()).toString(), "25", "V1 default must be preserved");
      assert.equal((await w0.maxSwapSlippageBps()).toString(), "100", "V1 default must be preserved");
    });

    it("totalAssets covers BOTH positions, not just the staked one", async () => {
      // The V2-specific risk: a wrapper that only saw the staked NFT would under-report NAV by the
      // buffer's share (2000bps here) and mint every depositor ~25% too many shares.
      const helper = await ICLRebalanceHelper.at(HELPER);
      const lower = await vault.tickLower(), upper = await vault.tickUpper();
      const st = await helper.getCurrentTokenAmounts(POOL, NPM2, await vault.posId(), lower, upper);
      const bf = await helper.getCurrentTokenAmounts(POOL, NPM2, await vault.bufferPosId(), lower, upper);
      const both = await vault.getCurrentTokenAmounts();
      assert.equal(BN(bf[0]).gt(BN(0)) || BN(bf[1]).gt(BN(0)), true, "test premise: the buffer must hold something");
      assert.equal(BN(both[0]).eq(BN(st[0]).add(BN(bf[0]))), true, "vault NAV must sum both positions");

      const total = BN(await w0.totalAssets());
      const stakedOnly = BN(st[0]).add(BN(st[1]).mul(BN(0))); // token0 leg alone, lower bound
      console.log(`      totalAssets=${total} staked token0=${st[0]} buffer token0=${bf[0]}`);
      assert.equal(total.gt(BN(st[0])), true, "NAV must exceed the staked position's token0 alone");
      assert.equal(total.gt(BN(0)), true, "totalAssets must be positive");
    });

    it("NAV counts idle held by the strategy, matching V1 — previews depend on it", async () => {
      // V2 originally returned bare totalLiquidity() here, which ignores idle. The wrapper prices
      // previewDeposit against this figure, so understating it makes every preview overstate the
      // shares a deposit will mint and the vault then rejects its own wrapper's minimum.
      const before = BN(await vault.underlyingBalanceWithInvestment());
      const totalL = BN(await vault.totalLiquidity());
      assert.equal(before.gte(totalL), true, "NAV must be at least the NFT liquidity");
      await t0.transfer(strategy.address, web3.utils.toWei("1"), { from: POOL });
      const after = BN(await vault.underlyingBalanceWithInvestment());
      console.log(`      NAV ${before} -> ${after} after 1 WETH idle (totalLiquidity stayed ${(await vault.totalLiquidity()).toString()})`);
      assert.equal(after.gt(before), true, "idle on the strategy must raise NAV");
      assert.equal(BN(await vault.totalLiquidity()).eq(totalL), true, "totalLiquidity must NOT count idle");
    });

    it("weights are identical from either position, which is what the empty-side fallback relies on", async () => {
      // getCurrentTokenWeights drives the wrapper's deposit split, and quoting an EMPTY position
      // returns (0,0) — which _computeSwapPortion rejects, blocking the deposit. The vault therefore
      // falls back to the buffer when the staked side is empty. That fallback is only sound because
      // a weight depends on price and range, not on size, so either position reports the same split.
      //
      // Note: that fallback BRANCH is not exercised here. I could not construct a resting state with
      // stakedLiquidity() == 0 (emergencyExit only unstakes; it leaves the liquidity in place), so it
      // stays defensive. What is tested is the property that makes it correct.
      const helper = await ICLRebalanceHelper.at(HELPER);
      const lower = await vault.tickLower(), upper = await vault.tickUpper();
      const fromStaked = await helper.getCurrentTokenWeights(POOL, NPM2, await vault.posId(), lower, upper);
      const fromBuffer = await helper.getCurrentTokenWeights(POOL, NPM2, await vault.bufferPosId(), lower, upper);
      const viaVault = await vault.getCurrentTokenWeights();
      console.log(`      staked=(${fromStaked[0]}, ${fromStaked[1]})  buffer=(${fromBuffer[0]}, ${fromBuffer[1]})`);
      assert.equal(BN(fromStaked[0]).gt(BN(0)) && BN(fromBuffer[0]).gt(BN(0)), true, "premise: both positions hold value");
      // Not bit-exact: the two positions differ in size, so the amounts they quote round slightly
      // differently. What matters is that the SPLIT is the same to well under any level a swap
      // decision could notice — measured at ~3e-9 relative here.
      const rel = (a, b) => {
        const [x, y] = [BN(a), BN(b)];
        const diff = x.gt(y) ? x.sub(y) : y.sub(x);
        return diff.mul(BN(1e12)).div(x.isZero() ? BN(1) : x);
      };
      const d0 = rel(fromStaked[0], fromBuffer[0]);
      console.log(`      weight delta staked vs buffer: ${d0.toString()} parts per 1e12`);
      assert.equal(d0.lt(BN(1e6)), true, `weights must match to within 1e-6 relative, got ${d0} ppt`);
      assert.equal(rel(viaVault[0], fromStaked[0]).lt(BN(1e6)), true, "the vault must report the same split");
    });

    it("two-sided fee idle left by a withdrawal does not block wrapper deposits", async () => {
      // The routine trigger the audit identified: decreaseBuffer collects the buffer's whole
      // uncollected fee balance to the strategy and pays out only principal, so FOLDABLE two-sided
      // idle sits there after every withdrawal. Any deposit guard that has to predict the vault's
      // post-fold NAV differs from it by integer rounding in that state and reverts for everyone.
      // Put the state there deterministically rather than hoping fees accrued: on a freshly minted
      // position with no trading, a withdrawal collects ZERO fees and the test would assert nothing.
      // In range, both sides are foldable — which is exactly the case that made the NAV read differ
      // across the fold by integer rounding.
      await t0.transfer(strategy.address, web3.utils.toWei("0.03"), { from: POOL });
      await t1.transfer(strategy.address, "150000", { from: POOL });
      const s0 = BN(await t0.balanceOf(strategy.address)), s1 = BN(await t1.balanceOf(strategy.address));
      console.log(`      foldable two-sided idle on the strategy: token0=${s0} token1=${s1}`);
      assert.equal(s0.gt(BN(0)) && s1.gt(BN(0)), true, "test premise: both sides must be present and foldable");
      const { amt } = await fundAsset(u1, w0);
      await w0.methods["deposit(uint256,address)"](amt, u1, { from: u1 });
      const minted = BN(await vault.balanceOf(u1));
      console.log(`      wrapper deposit in that state -> ${minted} shares`);
      assert.equal(minted.gt(BN(0)), true, "fee idle must not block wrapper deposits");
    });

    it("idle the flush cannot fold does not block wrapper deposits", async () => {
      // The wrapper's deposit floor and the vault's mint must be computed on the SAME basis; both now
      // use underlyingBalanceWithInvestment(). This asserts the property holds in the state that
      // stresses it hardest — idle stranded on the strategy that the flush provably cannot absorb.
      //
      // Scope note: an audit raised a related case where the floor could EXCEED the mint and brick
      // deposits, requiring the helper's idle quote to undervalue what the fold actually mints. That
      // case is NOT reproduced here — on this pool the pre-fix error ran the safe direction (a larger
      // denominator gives a smaller floor). Treat that one as argued, not verified.
      const tick = await donateUnfoldable();
      const stranded = BN(await t1.balanceOf(strategy.address));
      const navL = BN(await vault.underlyingBalanceWithInvestment());
      const totalL = BN(await vault.totalLiquidity());
      console.log(`      tick ${tick} (below range); strategy holds ${stranded} unfoldable token1; navL-totalL = ${navL.sub(totalL).toString()}`);
      assert.equal(navL.gt(totalL), true, "test premise: NAV must exceed NFT liquidity by the unfoldable idle");
      const { amt } = await fundAsset(u1, w0);
      await w0.methods["deposit(uint256,address)"](amt, u1, { from: u1 });
      const minted = BN(await vault.balanceOf(u1));
      console.log(`      deposit succeeded -> ${minted} shares`);
      assert.equal(minted.gt(BN(0)), true, "unfoldable idle must not block wrapper deposits");
    });

    it("a donation to the vault is paid out pro-rata and does not brick wrapper redeems", async () => {
      // previewRedeem credits the caller's pro-rata slice of the VAULT's token0/token1 and passes
      // itself as minAssetsOut. If withdraw does not actually pay that slice, a donation above
      // ~25bps of NAV (the default preview buffer) makes the preview unreachable and every wrapper
      // redeem reverts WrapperSlippage — permanently, since sweepStrayToken refuses the pool tokens.
      const { amt } = await fundAsset(u1, w0);
      await w0.methods["deposit(uint256,address)"](amt, u1, { from: u1 });
      const shares = BN(await vault.balanceOf(u1));

      await t0.transfer(vault.address, web3.utils.toWei("1"), { from: POOL });
      const idle = BN(await t0.balanceOf(vault.address));
      const nav = BN(await w0.totalAssets());
      const bps = idle.mul(BN(10000)).div(nav);
      console.log(`      donated ${idle} to the vault = ${bps}bps of NAV (default preview buffer is 25bps)`);
      assert.equal(bps.gt(BN(25)), true, "test premise: the donation must exceed the preview buffer");

      await vault.approve(w0.address, shares.toString(), { from: u1 });
      const before = BN(await t0.balanceOf(u1));
      await w0.methods["redeem(uint256,address,address)"](shares.toString(), u1, u1, { from: u1 });
      const got = BN(await t0.balanceOf(u1)).sub(before);
      const supply = BN(await vault.totalSupply()).add(shares);
      const expectedSlice = idle.mul(shares).div(supply);
      console.log(`      redeem paid ${got}; holder's slice of the donation was ${expectedSlice}`);
      assert.equal(got.gt(BN(0)), true, "redeem must still work with a donation present");
      // The slice was computed and then never checked. Assert the donation actually reached the
      // holder, which is the property the sweep/idleShare path exists to provide.
      assert.equal(got.gt(expectedSlice), true,
        `payout ${got} must exceed the donation slice ${expectedSlice} (principal + slice)`);
      assert.equal(BN(await t0.balanceOf(vault.address)).lt(idle), true,
        "the donation must be distributed, not stranded on the vault");
    });

    it("the 2-arg deposit works at the untouched 25bps default — the forecast no longer gates it", async () => {
      // Before, this reverted: previewDeposit assumes zero price impact, the actual mint landed at
      // ~9985bps of it, and the 2-arg deposit passed that forecast as its own minimum. The 2-arg path
      // now passes no minimum at all — the swap is bounded where it happens by maxSwapSlippageBps
      // against live pool spot, and the vault's mint is fair by construction — so previewSafetyBps is
      // a display setting only and no longer gates execution. (An earlier revision derived a
      // NAV-based floor here; that was removed because it read pre-flush NAV while the vault reads
      // post-flush, which is not integer-invariant and bricked deposits.)
      assert.equal((await w0.previewSafetyBps()).toString(), "25", "premise: still at the V1 default");
      const { amt } = await fundAsset(u1, w0);
      const preview = BN(await w0.previewDeposit(amt));
      await w0.methods["deposit(uint256,address)"](amt, u1, { from: u1 });
      const minted = BN(await vault.balanceOf(u1));
      const ratio = minted.mul(BN(10000)).div(preview);
      console.log(`      minted ${minted} vs preview ${preview} = ${ratio}bps (would have reverted below 10000 before)`);
      assert.equal(minted.gt(BN(0)), true, "deposit must succeed at the default buffer");
      assert.equal(ratio.lt(BN(10000)), true,
        "premise: actual is still BELOW the optimistic preview — so the old design really would have reverted");
      // Limitation worth stating: that the derived floor is TIGHT (rather than trivially small) is
      // argued from construction — same formula, same state, same transaction as the vault's own
      // mint — not demonstrated here. Showing it bind would need a vault that mints less than its
      // state implies, which no reachable state produces.
    });

    it("deposit mints vault shares to the receiver and leaves the wrapper empty", async () => {
      const { amt } = await fundAsset(u1, w0);
      const before = BN(await vault.balanceOf(u1));
      await w0.methods["deposit(uint256,address)"](amt, u1, { from: u1 });
      const minted = BN(await vault.balanceOf(u1)).sub(before);
      console.log(`      deposited ${amt} token0 -> ${minted} shares`);
      assert.equal(minted.gt(BN(0)), true, "must mint vault shares to the receiver");
      // The wrapper must never hold value between calls.
      assert.equal(BN(await t0.balanceOf(w0.address)).isZero(), true, "wrapper kept token0");
      assert.equal(BN(await t1.balanceOf(w0.address)).isZero(), true, "wrapper kept token1");
      assert.equal(BN(await vault.balanceOf(w0.address)).isZero(), true, "wrapper kept shares");
    });

    it("redeem returns asset to the receiver", async () => {
      const { amt } = await fundAsset(u1, w0);
      await w0.methods["deposit(uint256,address)"](amt, u1, { from: u1 });
      const shares = BN(await vault.balanceOf(u1));
      await vault.approve(w0.address, shares.toString(), { from: u1 });
      const before = BN(await t0.balanceOf(u1));
      await w0.methods["redeem(uint256,address,address)"](shares.toString(), u1, u1, { from: u1 });
      const got = BN(await t0.balanceOf(u1)).sub(before);
      console.log(`      redeemed ${shares} shares -> ${got} token0 (deposited ${amt})`);
      assert.equal(got.gt(BN(0)), true, "must return asset to the receiver");
      assert.equal(BN(await vault.balanceOf(u1)).isZero(), true, "shares must be burned");
      assert.equal(BN(await vault.balanceOf(w0.address)).isZero(), true, "wrapper kept shares");
    });

    it("deposit honours minSharesOut", async () => {
      const { amt } = await fundAsset(u1, w0);
      const preview = BN(await w0.previewDeposit(amt));
      let threw = false;
      try {
        await w0.methods["deposit(uint256,address,uint256)"](amt, u1, preview.mul(BN(3)).toString(), { from: u1 });
      } catch (e) { threw = true; }
      assert.equal(threw, true, "an unreachable minSharesOut must revert");
      await w0.methods["deposit(uint256,address,uint256)"](amt, u1, preview.div(BN(2)).toString(), { from: u1 });
      assert.equal(BN(await vault.balanceOf(u1)).gt(BN(0)), true, "a reachable minSharesOut must succeed");
    });

    it("redeem honours minAssetsOut", async () => {
      const { amt } = await fundAsset(u1, w0);
      await w0.methods["deposit(uint256,address)"](amt, u1, { from: u1 });
      const shares = BN(await vault.balanceOf(u1));
      await vault.approve(w0.address, shares.toString(), { from: u1 });
      const preview = BN(await w0.previewRedeem(shares.toString()));
      let threw = false;
      try {
        await w0.methods["redeem(uint256,address,address,uint256)"](shares.toString(), u1, u1, preview.mul(BN(3)).toString(), { from: u1 });
      } catch (e) { threw = true; }
      assert.equal(threw, true, "an unreachable minAssetsOut must revert");
      await w0.methods["redeem(uint256,address,address,uint256)"](shares.toString(), u1, u1, preview.div(BN(2)).toString(), { from: u1 });
      assert.equal(BN(await vault.balanceOf(u1)).isZero(), true, "a reachable minAssetsOut must succeed");
    });

    it("a redeem larger than the buffer forces an unstake and still pays out", async () => {
      // V2-specific: the wrapper passes mins of 0 and relies on its own asset check, so it must
      // tolerate the vault unstaking mid-withdrawal, re-splitting and re-staking.
      const shares = BN(await vault.balanceOf(gov));
      const bufBps = BN(await vault.bufferLiquidity()).mul(BN(10000)).div(BN(await vault.totalLiquidity()));
      const pct = BN(Math.min(9000, Number(bufBps.toString()) + 1500));
      const redeem = shares.mul(pct).div(BN(10000));
      await vault.approve(w0.address, redeem.toString(), { from: gov });
      const stakedBefore = BN(await vault.stakedLiquidity());
      const before = BN(await t0.balanceOf(gov));
      await w0.methods["redeem(uint256,address,address)"](redeem.toString(), gov, gov, { from: gov });
      const got = BN(await t0.balanceOf(gov)).sub(before);
      const ratio = Number((await vault.stakedRatioBps()).toString());
      console.log(`      buffer=${bufBps}bps, redeemed ${pct}bps -> ${got} token0; staked ${stakedBefore}->${(await vault.stakedLiquidity()).toString()}, ratio=${ratio}`);
      assert.equal(BN(await vault.stakedLiquidity()).lt(stakedBefore), true, "test premise: must have forced an unstake");
      assert.equal(got.gt(BN(0)), true, "must still pay the redeemer");
      assert.equal((await nft.ownerOf(await vault.posId())).toLowerCase(), GAUGE.toLowerCase(), "must end re-staked");
      assert.equal(Math.abs(ratio - TARGET_BPS) <= 200, true, `ratio must be restored, got ${ratio}`);
    });
  });

  // The V1 suite asserted "a non-owner CAN redeem" as intended and this suite never used a second
  // actor at all -- every redeem here was (u1, u1, from u1). Both stayed green while anyone could
  // redeem an approved holder's shares to themselves.
  describe("[redeem authorisation]", function () {
    const MAX = BN(2).pow(BN(256)).sub(BN(1));

    async function expectCustomError(fn, name) {
      let msg = null;
      try { await fn(); } catch (e) { msg = String(e.message || e); }
      assert.notEqual(msg, null, `expected ${name}, but the call succeeded`);
      assert.equal(msg.includes(name), true, `expected ${name}, got: ${msg}`);
    }

    async function holderWithStandingApproval(wrapper) {
      const { amt } = await fundAsset(u1, wrapper);
      await wrapper.methods["deposit(uint256,address)"](amt, u1, { from: u1 });
      const shares = BN(await vault.balanceOf(u1));
      assert.equal(shares.gt(BN(0)), true, "test prereq: victim must hold shares");
      await vault.approve(wrapper.address, MAX.toString(), { from: u1 });
      return shares;
    }

    for (const [label, pick] of [["token0 wrapper", () => w0], ["token1 wrapper", () => w1]]) {
      it(`THEFT via the ${label}: a third party cannot redeem an approved holder's shares to themselves`, async () => {
        const w = pick();
        const shares = await holderWithStandingApproval(w);
        const thief0 = BN(await t0.balanceOf(u2)), thief1 = BN(await t1.balanceOf(u2));

        await expectCustomError(
          () => w.methods["redeem(uint256,address,address)"](shares.toString(), u2, u1, { from: u2 }), "WrapperNotOwner");
        await expectCustomError(
          () => w.methods["redeem(uint256,address,address,uint256)"](shares.toString(), u2, u1, "0", { from: u2 }), "WrapperNotOwner");
        await expectCustomError(
          () => w.methods["redeem(uint256,address,address,uint256)"]("1", u2, u1, "0", { from: u2 }), "WrapperNotOwner");

        assert.equal(BN(await vault.balanceOf(u1)).toString(), shares.toString(), "victim's shares moved");
        assert.equal(BN(await t0.balanceOf(u2)).toString(), thief0.toString(), "attacker gained token0");
        assert.equal(BN(await t1.balanceOf(u2)).toString(), thief1.toString(), "attacker gained token1");
        assert.equal(BN(await vault.balanceOf(w.address)).isZero(), true, "wrapper kept shares");
      });
    }

    it("a third party cannot force an approved holder out, even with the holder as receiver", async () => {
      const shares = await holderWithStandingApproval(w0);
      await expectCustomError(
        () => w0.methods["redeem(uint256,address,address)"](shares.toString(), u1, u1, { from: u2 }), "WrapperNotOwner");
      assert.equal(BN(await vault.balanceOf(u1)).toString(), shares.toString(), "holder was forced out");
    });

    it("the owner can still redeem to a different receiver", async () => {
      const shares = await holderWithStandingApproval(w0);
      const before = BN(await t0.balanceOf(u2));
      await w0.methods["redeem(uint256,address,address)"](shares.toString(), u2, u1, { from: u1 });
      assert.equal(BN(await t0.balanceOf(u2)).sub(before).gt(BN(0)), true, "receiver should get the proceeds");
      assert.equal(BN(await vault.balanceOf(u1)).isZero(), true, "shares must be burned");
      assert.equal(BN(await vault.balanceOf(w0.address)).isZero(), true, "wrapper kept shares");
    });
  });

  describe("[asset = token1]", function () {
    it("constructor wires asset correctly", async () => {
      assert.equal((await w1.asset()).toLowerCase(), CBBTC.toLowerCase());
      assert.equal((await w1.pool()).toLowerCase(), POOL.toLowerCase());
    });

    it("deposit + redeem round-trip works for a token1 asset", async () => {
      const { amt } = await fundAsset(u2, w1);
      await w1.methods["deposit(uint256,address)"](amt, u2, { from: u2 });
      const shares = BN(await vault.balanceOf(u2));
      assert.equal(shares.gt(BN(0)), true, "must mint shares");
      await vault.approve(w1.address, shares.toString(), { from: u2 });
      const before = BN(await t1.balanceOf(u2));
      await w1.methods["redeem(uint256,address,address)"](shares.toString(), u2, u2, { from: u2 });
      const got = BN(await t1.balanceOf(u2)).sub(before);
      console.log(`      token1 round trip: in=${amt} out=${got}`);
      assert.equal(got.gt(BN(0)), true, "must return token1");
      assert.equal(BN(await t0.balanceOf(w1.address)).isZero(), true, "wrapper kept token0");
      assert.equal(BN(await t1.balanceOf(w1.address)).isZero(), true, "wrapper kept token1");
    });
  });
});
