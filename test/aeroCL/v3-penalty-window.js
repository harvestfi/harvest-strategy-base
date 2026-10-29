// CLVaultV2 + AerodromeCLStrategyV2 on a post-merger Aero V3 CL gauge (WETH/cbBTC ts10).
//
// V3 CL gauges forfeit 100% of a position's accrued emissions on a claim or withdraw inside
// `minStakeBlocks` of its last deposit. The window is block-based, per tokenId, read live from the
// gauge factory, and the PENALTY_ADMIN Safe can raise it retroactively with no timelock. These tests
// pin the port's contract with that gauge:
//   * the harvest gate reads the live block window and skips inside it (and fails closed);
//   * a retroactive raise is honoured by the very next harvest;
//   * a withdrawal larger than the buffer still pays in full inside the window (ForcedUnstake);
//   * emergencyExit never waits for the window;
//   * a tx whose claim failed never goes on to stake.
//
// Needs a post-merger block. `.env` pins a pre-merger FORK_BLOCK, so run with:
//   FORK_BLOCK=53236000 npx hardhat test test/aeroCL/v3-penalty-window.js
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
for (const C of [VaultProxy, StrategyProxy, CLVaultV2, CLRebalanceLibV2, Strategy, IPosManager, IPool, IERC20, IERC721]) {
  C.disableConfirmationListener = true;
}

const NPM3 = "0x4857DB576eE0e45F10525eC59527BfD10beeC60b";
const POOL3 = "0xbB5507DaaE822ba89C4dA61BbfDf4b49a1666BAc";
const GAUGE3 = "0x5b14d6D194E49330647eB4717010aDe1B1B3f8B5";
const GFACTORY = "0xf437f62053ACB121665b8fDBfeA8F214FB8E589d";
const LEAF_VOTER = "0x382409fad8503FbCdbB27A4211551fa03e884078";
const PENALTY_ADMIN = "0x42255e3c2d0b71a0b006243148fdf1a71d054ce0";
const EMERGENCY_ADMIN = "0x15Ad691083b3D31Ee0ad8664E606Febd62CD8892";
const AERO3 = "0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee";
const WHALE = "0x42d4a22CaD0F5a49681a5715cE994Af73A43B76b"; // killed pre-merger F2 pool, still holds both tokens
const WETH = "0x4200000000000000000000000000000000000006";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const HELPER = "0x74a343dECf3b4578B07D0F7b7577aB2f3c4762b2";
const TS = 10, WIDTH = 8;
const TARGET_BPS = 8000, BAND_BPS = 1000, SAFETY = 2; // safety is in BLOCKS now
const MAX = web3.utils.toBN(2).pow(web3.utils.toBN(256)).subn(1);
const BN = web3.utils.toBN;
const PENALTY_TOPIC = web3.utils.keccak256("EarlyWithdrawPenalty(address,uint256,uint256)");

const GAUGE_ABI = [
  { name: "depositBlock", type: "function", stateMutability: "view", inputs: [{ name: "t", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "rewardGrowthInside", type: "function", stateMutability: "view", inputs: [{ name: "t", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "earned", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }, { name: "t", type: "uint256[]" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "claimEmissions", type: "function", stateMutability: "nonpayable", inputs: [{ name: "a", type: "address" }, { name: "r", type: "address" }, { name: "t", type: "uint256[]" }], outputs: [] },
];
const FACTORY_ABI = [
  { name: "setMinStakeBlocks", type: "function", stateMutability: "nonpayable", inputs: [{ name: "g", type: "address" }, { name: "v", type: "uint256" }], outputs: [] },
  { name: "setEmergencyWithdrawEnabled", type: "function", stateMutability: "nonpayable", inputs: [{ name: "e", type: "bool" }], outputs: [] },
  { name: "effectivePenaltyConfig", type: "function", stateMutability: "view", inputs: [{ name: "g", type: "address" }], outputs: [{ name: "", type: "tuple", components: [{ name: "minStakeBlocks", type: "uint256" }, { name: "penaltyRate", type: "uint256" }] }] },
];

describe("CLVaultV2 twin-position on an Aero V3 CL gauge (block-based penalty window)", function () {
  this.timeout(1800000);
  let gov, user, vault, strategy, npm, nft, t0, t1, aero, gauge, factory, snap;

  const blockNow = async () => Number(await web3.eth.getBlockNumber());
  const mine = async n => hre.network.provider.send("hardhat_mine", ["0x" + n.toString(16), "0x2"]);
  const posId = async () => (await vault.posId()).toString();
  const stakedOwner = async () => (await nft.ownerOf(await vault.posId())).toLowerCase();
  const growth = async () => (await gauge.methods.rewardGrowthInside(await posId()).call()).toString();
  // Ground truth from the gauge itself, independent of the code under test.
  const gaugeWindowEnd = async () => Number(await gauge.methods.depositBlock(await posId()).call())
    + Number((await factory.methods.effectivePenaltyConfig(GAUGE3).call()).minStakeBlocks);
  const mineClear = async extra => mine(Math.max(0, await gaugeWindowEnd() + SAFETY - await blockNow()) + extra);
  const setWindow = async n => factory.methods.setMinStakeBlocks(GAUGE3, n).send({ from: PENALTY_ADMIN, gas: 300000 });
  const penaltiesIn = async rc => {
    const r = await web3.eth.getTransactionReceipt(rc.tx || rc.transactionHash);
    return r.logs.filter(l => l.address.toLowerCase() === GAUGE3.toLowerCase() && l.topics[0] === PENALTY_TOPIC).length;
  };
  const strategyEvents = async (rc, name) => strategy.getPastEvents(name, { fromBlock: rc.receipt.blockNumber, toBlock: rc.receipt.blockNumber });
  const expectRevert = async (p, name) => {
    try { await p; } catch (e) {
      assert.include(e.message, name, `expected ${name}, got: ${e.message.slice(0, 300)}`);
      return;
    }
    assert.fail(`expected revert ${name}`);
  };

  before(async () => {
    const acc = await web3.eth.getAccounts();
    gov = addresses.Governance; user = acc[5];
    await impersonates([gov, WHALE, PENALTY_ADMIN, EMERGENCY_ADMIN]);
    for (const a of [gov, user, WHALE, PENALTY_ADMIN, EMERGENCY_ADMIN]) {
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x21E19E0C9BAB2400000"] });
    }
    t0 = await IERC20.at(WETH); t1 = await IERC20.at(CBBTC); aero = await IERC20.at(AERO3);
    npm = await IPosManager.at(NPM3); nft = await IERC721.at(NPM3);
    gauge = new web3.eth.Contract(GAUGE_ABI, GAUGE3);
    factory = new web3.eth.Contract(FACTORY_ABI, GFACTORY);

    await t0.transfer(gov, web3.utils.toWei("12"), { from: WHALE });
    await t1.transfer(gov, "60000000", { from: WHALE });
    await t0.approve(NPM3, web3.utils.toWei("12"), { from: gov });
    await t1.approve(NPM3, "60000000", { from: gov });

    const tick = parseInt((await (await IPool.at(POOL3)).slot0())[1].toString(), 10);
    const lower = (Math.floor(tick / TS) - WIDTH / 2) * TS;
    const mint = async (w0, w1) => {
      const res = await npm.mint({
        token0: WETH, token1: CBBTC, tickSpacing: TS, tickLower: lower, tickUpper: lower + WIDTH * TS,
        amount0Desired: w0, amount1Desired: w1, amount0Min: 0, amount1Min: 0,
        recipient: gov, deadline: Number((await web3.eth.getBlock("latest")).timestamp) + 1800, sqrtPriceX96: 0,
      }, { from: gov });
      const evs = await nft.getPastEvents("Transfer", { fromBlock: res.receipt.blockNumber, toBlock: res.receipt.blockNumber });
      return evs.filter(e => e.returnValues.to.toLowerCase() === gov.toLowerCase()).map(e => e.returnValues.tokenId).pop();
    };
    const stakedId = await mint(web3.utils.toWei("8"), "40000000");
    const bufferId = await mint(web3.utils.toWei("2"), "10000000");

    const lib = await CLRebalanceLibV2.new({ from: gov });
    await Strategy.link(lib);
    const impl = await CLVaultV2.new({ from: gov });
    vault = await CLVaultV2.at((await VaultProxy.new(impl.address, { from: gov })).address);
    await nft.approve(vault.address, stakedId, { from: gov });
    await nft.approve(vault.address, bufferId, { from: gov });
    await vault.initializeVault(addresses.Storage, stakedId, bufferId, NPM3, WIDTH, TARGET_BPS, BAND_BPS, SAFETY, { from: gov });
    await vault.setRebalanceHelper(HELPER, { from: gov });
    await vault.setRebalanceSafetyConfig(10000, 100, 120, 200, { from: gov });
    await vault.setRebalanceConfig(0, 5, gov, { from: gov });
    await vault.setLanePause(false, false, false, false, { from: gov });

    const sImpl = await Strategy.new({ from: gov });
    strategy = await Strategy.at((await StrategyProxy.new(sImpl.address, { from: gov })).address);
    await strategy.initializeBaseStrategy(addresses.Storage, vault.address, GAUGE3, AERO3, { from: gov });
    // New AERO has no UL route yet, so keep the reward on the strategy where a claim is measurable.
    await strategy.setSell(false, { from: gov });
    await vault.setStrategy(strategy.address, { from: gov });
    await vault.restakePosition({ from: gov });

    const cfg = await factory.methods.effectivePenaltyConfig(GAUGE3).call();
    console.log(`      staked=${stakedId} buffer=${bufferId} gauge window=${cfg.minStakeBlocks} blocks rate=${cfg.penaltyRate}pips`);
    snap = await hre.network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await hre.network.provider.send("evm_revert", [snap]);
    snap = await hre.network.provider.send("evm_snapshot");
  });

  it("reads the window in BLOCKS: depositBlock(tokenId) + live minStakeBlocks", async () => {
    assert.equal(await stakedOwner(), GAUGE3.toLowerCase(), "staked position must be in the V3 gauge");
    const dep = Number(await gauge.methods.depositBlock(await posId()).call());
    const cfg = await factory.methods.effectivePenaltyConfig(GAUGE3).call();
    assert.isAbove(Number(cfg.minStakeBlocks), 0, "fixture gauge must have a live window");
    const end = Number(await strategy.stakeWindowEnd());
    assert.equal(end, dep + Number(cfg.minStakeBlocks), "strategy window end must be depositBlock + minStakeBlocks");
    assert.equal(Number(await vault.stakeWindowEnd()), end + SAFETY, "vault adds the safety margin in blocks");
    assert.isBelow(await blockNow(), end, "fixture must start inside the window");
    assert.equal(await strategy.isOutsideStakeWindow(), false);
    assert.equal(await vault.isOutsideStakeWindow(), false);
  });

  it("skips an in-window harvest without claiming, then claims the whole accrual once clear", async () => {
    const end = Number(await strategy.stakeWindowEnd());
    // Counterfactual, in a snapshot: a claim made right now forfeits everything.
    const s = await hre.network.provider.send("evm_snapshot");
    await impersonates([strategy.address]);
    await hre.network.provider.request({ method: "hardhat_setBalance", params: [strategy.address, "0x21E19E0C9BAB2400000"] });
    await mine(2);
    const raw = await gauge.methods.claimEmissions(strategy.address, strategy.address, [await posId()]).send({ from: strategy.address, gas: 3000000 });
    assert.equal(await penaltiesIn(raw), 1, "a claim inside the live window must be penalised by the gauge");
    await hre.network.provider.send("evm_revert", [s]);

    const g0 = await growth();
    const a0 = BN(await aero.balanceOf(strategy.address));
    assert.isBelow(await blockNow() + 1, end, "harvest must land inside the window");
    const rc = await strategy.doHardWork({ from: gov });
    const skipped = await strategyEvents(rc, "HarvestSkippedInsideWindow");
    assert.equal(skipped.length, 1, "in-window harvest must be skipped");
    assert.equal(skipped[0].returnValues.windowEndBlock, String(end));
    assert.equal(await penaltiesIn(rc), 0, "no penalty may be incurred");
    assert.equal(await growth(), g0, "the gauge must not have been claimed against");
    assert.isTrue(BN(await aero.balanceOf(strategy.address)).eq(a0));

    await mineClear(300);
    assert.equal(await strategy.isOutsideStakeWindow(), true);
    const ids = [await posId()];
    const earned = BN(await gauge.methods.earned(strategy.address, ids).call());
    const rc2 = await strategy.doHardWork({ from: gov });
    assert.equal((await strategyEvents(rc2, "HarvestSkippedInsideWindow")).length, 0);
    assert.equal(await penaltiesIn(rc2), 0, "an out-of-window claim must not be penalised");
    const got = BN(await aero.balanceOf(strategy.address)).sub(a0);
    assert.isTrue(got.gt(BN(0)), "the claim must pay");
    assert.isTrue(got.gte(earned), "the claim must pay at least what had accrued a block earlier");
    assert.equal(Number(await gauge.methods.depositBlock(ids[0]).call()) + 0 < await blockNow(), true);
    console.log(`      claimed ${web3.utils.fromWei(got)} AERO after the window; gauge.earned one block earlier ${web3.utils.fromWei(earned)}`);
  });

  it("honours a retroactive minStakeBlocks raise by the PENALTY_ADMIN", async () => {
    const dep = Number(await gauge.methods.depositBlock(await posId()).call());
    await mineClear(50);
    assert.equal(await vault.isOutsideStakeWindow(), true, "precondition: clear of today's window");

    const RAISED = 90000;
    await setWindow(RAISED);
    assert.equal(Number(await strategy.stakeWindowEnd()), dep + RAISED, "the raise must be read live");
    assert.equal(await vault.isOutsideStakeWindow(), false, "the vault must see the raise too");

    const g0 = await growth();
    const rc = await strategy.doHardWork({ from: gov });
    assert.equal((await strategyEvents(rc, "HarvestSkippedInsideWindow")).length, 1, "harvest must be skipped after the raise");
    assert.equal(await penaltiesIn(rc), 0);
    assert.equal(await growth(), g0, "no claim after the raise");
    await expectRevert(vault.rebalanceStakeRatio({ from: gov }), "ErrInsideStakeWindow");
    await expectRevert(vault.rebalanceCurrentTick(WIDTH, { from: gov }), "ErrInsideStakeWindow");

    await mineClear(1);
    const a0 = BN(await aero.balanceOf(strategy.address));
    const rc2 = await strategy.doHardWork({ from: gov });
    assert.equal((await strategyEvents(rc2, "HarvestSkippedInsideWindow")).length, 0);
    assert.equal(await penaltiesIn(rc2), 0);
    assert.isTrue(BN(await aero.balanceOf(strategy.address)).gt(a0), "the claim after the raised window must pay");
  });

  it("pays a withdrawal larger than the buffer in full inside the window and emits ForcedUnstake", async () => {
    await setWindow(1000);
    const end = Number(await vault.stakeWindowEnd());
    const supply = BN(await vault.totalSupply());
    const total = BN(await vault.totalLiquidity());
    const buffer = BN(await vault.bufferLiquidity());
    const shares = supply.muln(50).divn(100);
    const owed = total.mul(shares).div(supply);
    assert.isTrue(owed.gt(buffer), "precondition: the withdrawal exceeds the buffer");

    const b0 = BN(await t0.balanceOf(gov)), b1 = BN(await t1.balanceOf(gov));
    const rc = await vault.withdraw(shares.toString(), 0, 0, { from: gov });
    const forced = rc.logs.find(l => l.event === "ForcedUnstake");
    assert.ok(forced, "ForcedUnstake must be emitted inside the window");
    assert.equal(forced.args.stakeWindowEnd.toString(), String(end));
    assert.equal(forced.args.blockNumber.toString(), String(rc.receipt.blockNumber));
    assert.isBelow(rc.receipt.blockNumber, end);

    // Paid in full: the buffer decrease that funds the payout burns the whole owed liquidity (the
    // vault's clamp only forgives round-trip dust), and the caller receives at least what it released.
    // Total liquidity is not the measure: the post-payout re-split loses its own rounding dust.
    const bufferId = (await vault.bufferPosId()).toString();
    const DECREASE_TOPIC = web3.utils.keccak256("DecreaseLiquidity(uint256,uint128,uint256,uint256)");
    const decreases = (await web3.eth.getTransactionReceipt(rc.tx)).logs
      .filter(l => l.address.toLowerCase() === NPM3.toLowerCase() && l.topics[0] === DECREASE_TOPIC
        && BN(l.topics[1]).toString() === bufferId)
      .map(l => web3.eth.abi.decodeParameters(["uint128", "uint256", "uint256"], l.data))
      .map(d => ({ liquidity: d[0], amount0: d[1], amount1: d[2] }))
      .sort((a, b) => BN(a.liquidity).sub(owed).abs().cmp(BN(b.liquidity).sub(owed).abs()));
    const payout = decreases[0];
    const take = BN(payout.liquidity);
    assert.isTrue(take.lte(owed) && owed.sub(take).lte(owed.divn(1e6).addn(1000)), `paid ${take} of owed ${owed}`);
    assert.isTrue(BN(await t0.balanceOf(gov)).sub(b0).gte(BN(payout.amount0)), "token0 paid in full");
    assert.isTrue(BN(await t1.balanceOf(gov)).sub(b1).gte(BN(payout.amount1)), "token1 paid in full");
    assert.isTrue(BN(payout.amount0).gtn(0) && BN(payout.amount1).gtn(0), "both tokens paid out");
    assert.equal(await stakedOwner(), GAUGE3.toLowerCase(), "restaked after the payout");
    console.log(`      owed L=${owed} paid L=${take}; gauge penalty events in tx: ${await penaltiesIn(rc)}`);
  });

  it("emergencyExit does not wait for the window", async () => {
    await setWindow(90000);
    assert.equal(await strategy.isOutsideStakeWindow(), false);
    await strategy.emergencyExit({ from: gov });
    assert.equal(await stakedOwner(), strategy.address.toLowerCase(), "the NFT must leave the gauge immediately");
    assert.equal(await strategy.pausedInvesting(), true);
    // The vault stays fully withdrawable while unstaked.
    await vault.setLanePause(false, false, false, false, { from: gov });
    const rc = await vault.withdraw(BN(await vault.totalSupply()).divn(2).toString(), 0, 0, { from: gov });
    assert.equal(rc.logs.filter(l => l.event === "ForcedUnstake").length, 0, "nothing staked, nothing forced");
  });

  it("emergencyExit falls back to emergencyWithdraw when the gauge's claiming withdraw reverts", async () => {
    // Break the LeafVoter so settle/claim (and so `withdraw`) revert.
    await hre.network.provider.send("hardhat_setCode", [LEAF_VOTER, "0x60006000fd"]);
    await expectRevert(strategy.emergencyExit({ from: gov }), "'NE'");
    await factory.methods.setEmergencyWithdrawEnabled(true).send({ from: EMERGENCY_ADMIN, gas: 300000 });
    await strategy.emergencyExit({ from: gov });
    assert.equal(await stakedOwner(), strategy.address.toLowerCase());
  });

  it("fails CLOSED when the window cannot be read", async () => {
    for (const code of ["0x60006000fd", "0x"]) {
      const s = await hre.network.provider.send("evm_snapshot");
      await mineClear(10);
      assert.equal(await strategy.isOutsideStakeWindow(), true, "precondition: clear of the real window");
      await hre.network.provider.send("hardhat_setCode", [GFACTORY, code]);
      assert.isTrue(BN(await strategy.stakeWindowEnd()).eq(MAX), `unreadable factory (${code}) must read as inside`);
      assert.isTrue(BN(await vault.stakeWindowEnd()).eq(MAX), "the vault must saturate, not overflow");
      const rc = await strategy.doHardWork({ from: gov });
      assert.equal((await strategyEvents(rc, "HarvestSkippedInsideWindow")).length, 1, "harvest must skip");
      await hre.network.provider.send("evm_revert", [s]);
    }
  });

  it("never stakes in a tx whose claim failed; a plain harvest just reports it", async () => {
    await mineClear(10);
    await hre.network.provider.send("hardhat_setCode", [LEAF_VOTER, "0x60006000fd"]);
    // unstake(true) is what the rebalance path uses before it re-stakes: it must refuse.
    await expectRevert(strategy.unstake(true, { from: gov }), "ErrClaimFailed");
    assert.equal(await stakedOwner(), GAUGE3.toLowerCase(), "nothing moved");
    const rc = await strategy.doHardWork({ from: gov });
    assert.equal((await strategyEvents(rc, "ClaimFailed")).length, 1, "a failed harvest claim is reported, not swallowed silently");
    assert.equal(await stakedOwner(), GAUGE3.toLowerCase());
  });

  it("deposits never touch the gauge or its clock", async () => {
    const dep = await gauge.methods.depositBlock(await posId()).call();
    const staked = BN(await vault.stakedLiquidity());
    await t0.transfer(user, web3.utils.toWei("1"), { from: WHALE });
    await t1.transfer(user, "5000000", { from: WHALE });
    await t0.approve(vault.address, web3.utils.toWei("1"), { from: user });
    await t1.approve(vault.address, "5000000", { from: user });
    await vault.deposit(web3.utils.toWei("1"), "5000000", 0, user, { from: user });
    assert.isTrue(BN(await vault.balanceOf(user)).gtn(0));
    assert.isTrue(BN(await vault.stakedLiquidity()).eq(staked), "staked liquidity unchanged");
    assert.equal(await gauge.methods.depositBlock(await posId()).call(), dep, "the stake clock must not move");
  });

  it("reports what a harvest does with sell() on and no new-AERO route (informational)", async () => {
    await mineClear(300);
    await strategy.setSell(true, { from: gov });
    await strategy.setMinRewardToCompound(AERO3, 1, { from: gov });
    let outcome;
    try {
      const rc = await strategy.doHardWork({ from: gov });
      outcome = `ok; AERO left on strategy ${web3.utils.fromWei(await aero.balanceOf(strategy.address))}, swapSkippedCount ${await strategy.swapSkippedCount()}`;
      void rc;
    } catch (e) {
      outcome = `REVERTS: ${e.message.slice(0, 200)}`;
    }
    console.log(`      sell()=true harvest: ${outcome}`);
  });
});
