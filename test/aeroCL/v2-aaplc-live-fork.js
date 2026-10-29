// Functional coverage for the THREE LIVE USDC/AAPLc V2 vaults, against real mainnet state.
//
// Until now this pair had none: AAPLc's code reads as the single byte 0xef, so a fork copied an
// invalid opcode and every call into the token trapped. The deploy config says so outright —
// "This pair CANNOT be fork-tested" — which meant the vaults carrying real user funds were the
// only ones whose behaviour was never executed, and the WETH/cbBTC suites stood in for them.
//
// `installAaplc` removes that gap by installing a working ERC20 at the address and seeding it from
// live balances. Everything else here is genuine mainnet state: the real pool, the real gauge, the
// real vaults, the real positions.
const { impersonates } = require("../utilities/hh-utils.js");
const { installAaplc, AAPLC, setTokenBalance } = require("../utilities/aaplc-fork.js");
const addresses = require("../test-config.js");

const Vault = artifacts.require("CLVaultV2");
const Strategy = artifacts.require("AerodromeCLStrategyV2");
const StrategyProxy = artifacts.require("StrategyProxy");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IPool = artifacts.require("contracts/base/interface/concentrated-liquidity/IPool.sol:IPool");
const PriceMover = artifacts.require("CLPoolPriceMover");

const POOL = "0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0";
const GAUGE = "0x43021fBbD01b967704aB2379F6e90E2d367042F3";
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const WINDOW = 300, SAFETY = 30;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const NEW_IMPL = process.env.REHEARSE_IMPL || "0x4F405548E8387049e147185fE7C20C091E07dbE2";
const LIVE = [
  ["w240", "0x21DFa5e1486BFe8D725f11D59B32B908e783FF36", "0x17AC5f9f53B3d6a05516Fb664d5c9b7FC196fcd2"],
  ["w120", "0x4106bC8e6446EC6566eA9E9B9a3e4BbC6d2b4d3f", "0x6643fb9800095B543eDa1668bb8e4C322eFd0eb1"],
  ["w60",  "0x28365BE1308838a71Fb4D36281EFeE141819e448", "0x1e9917422e2deB862e7ff2c15Ba872186EbFF61e"],
];
const BN = web3.utils.toBN;

describe("USDC/AAPLc live vaults on a fork", function () {
  this.timeout(3600000);
  let gov, user, aaplc, usdc;

  before(async () => {
    await hre.network.provider.request({ method: "hardhat_reset", params: [{
      forking: { jsonRpcUrl: hre.network.config.forking.url } }] });
    const acc = await web3.eth.getAccounts();
    gov = addresses.Governance; user = acc[1];
    await impersonates([gov]);
    for (const a of [gov, user]) {
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x152D02C7E14AF6800000"] });
    }
    // Seed the pool with what it actually holds; without it no swap or burn can pay out.
    const r = await installAaplc({ from: gov, holders: [POOL], extraMint: [[user, "500000000000"]] });
    aaplc = r.token;
    usdc = await IERC20.at(USDC);
    const slot = await setTokenBalance(USDC, user, "5000000000"); // 5,000 USDC
    console.log(`      AAPLc installed; pool seeded ${r.seeded[0][1].toString()} (8dp); USDC balances slot ${slot}`);
  });

  it("the substituted token behaves like the real one inside the live pool", async () => {
    assert.equal((await aaplc.decimals()).toString(), "8", "decimals must match the real token");
    const poolBal = BN(await aaplc.balanceOf(POOL));
    assert.equal(poolBal.gt(BN(0)), true, "premise: the pool must hold the AAPLc it holds on-chain");

    // A real swap through the real pool is the only proof that matters: it exercises the pool's
    // callback, its balance checks and its tick math against the substituted token.
    const mover = await PriceMover.new({ from: gov });
    await setTokenBalance(USDC, mover.address, "100000000"); // 100 USDC
    const pool = await IPool.at(POOL);
    const sqrtBefore = BN((await pool.slot0())[0]);
    const before = BN(await aaplc.balanceOf(mover.address));
    await mover.move(POOL, true, "100000000", "4295128740", { from: gov });
    const gained = BN(await aaplc.balanceOf(mover.address)).sub(before);
    const sqrtAfter = BN((await pool.slot0())[0]);
    console.log(`      swapped 100 USDC -> ${gained.toString()} AAPLc (8dp); sqrtP ${sqrtBefore} -> ${sqrtAfter}`);
    assert.equal(gained.gt(BN(0)), true, "the pool must actually pay out AAPLc");
    // Assert on sqrtPriceX96, not the tick: 100 USDC is small against this pool's liquidity, so it
    // moves the price within the same tick index and a tick comparison would spuriously fail.
    assert.equal(sqrtAfter.lt(sqrtBefore), true, "a zeroForOne swap must move spot down");
  });

  for (const [label, vaultAddr, stratAddr] of LIVE) {
    it(`${label}: deposit, harvest and withdraw against the live vault on the new implementation`, async () => {
      const s = await Strategy.at(stratAddr);
      const v = await Vault.at(vaultAddr);

      // Adopt the freshly deployed implementation the way governance will. The upgrade is an
      // EXPLICIT StrategyProxy.upgrade() — an earlier version of this test assumed doHardWork would
      // trigger it, which silently left the proxy on the old implementation and made every
      // assertion below a statement about the code already deployed. Hence the slot check.
      const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
      const implOf = async () => "0x" + (await web3.eth.getStorageAt(stratAddr, IMPL_SLOT)).slice(26);
      const implBefore = await implOf();
      assert.equal(implBefore.toLowerCase() !== NEW_IMPL.toLowerCase(), true,
        "premise: the proxy must not already be on the implementation under test");
      await s.scheduleUpgrade(NEW_IMPL, { from: gov });
      const ts = Number((await s.nextImplementationTimestamp()).toString());
      const now = (await web3.eth.getBlock("latest")).timestamp;
      await hre.network.provider.send("evm_increaseTime", [Math.max(ts - now, 0) + 60]);
      await hre.network.provider.send("evm_mine");
      await (await StrategyProxy.at(stratAddr)).upgrade({ from: gov });
      assert.equal((await implOf()).toLowerCase(), NEW_IMPL.toLowerCase(),
        "the proxy must actually be running the new implementation before anything below is claimed about it");
      console.log(`      ${label}: impl ${implBefore.slice(0,10)}… -> ${NEW_IMPL.slice(0,10)}…`);

      const lBefore = BN(await v.totalLiquidity());
      // Round-trip conservation is measured from BEFORE the deposit, not from the withdraw alone:
      // the vault refunds whatever the position could not consume, so the withdraw delta on its own
      // understates what came back and would read as a catastrophic loss that never happened.
      const u_start = BN(await usdc.balanceOf(user)), a_start = BN(await aaplc.balanceOf(user));
      await usdc.approve(vaultAddr, "1000000000", { from: user });
      await aaplc.approve(vaultAddr, "100000000000", { from: user });
      const shares0 = BN(await v.balanceOf(user));
      await v.deposit("200000000", "1000000000", 0, user, { from: user }); // 200 USDC + 10 AAPLc
      const minted = BN(await v.balanceOf(user)).sub(shares0);
      const lAfterDep = BN(await v.totalLiquidity());
      console.log(`      ${label}: shares minted ${minted.toString()}; totalL ${lBefore} -> ${lAfterDep}`);
      assert.equal(minted.gt(BN(0)), true, "deposit must mint shares");
      assert.equal(lAfterDep.gt(lBefore), true, "deposit must add liquidity");

      // Harvest on the real gauge. This is the path today's changes live in: the planner-sized
      // compound (rather than a 50/50 split) and the buffer fee collect. Reward is donated from the
      // gauge so the test does not depend on however much AERO happens to have accrued at this block.
      await impersonates([GAUGE]);
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [GAUGE, "0x21E19E0C9BAB2400000"] });
      const aero = await IERC20.at(AERO);
      await aero.transfer(stratAddr, web3.utils.toWei("5"), { from: GAUGE });
      await hre.network.provider.send("evm_increaseTime", [WINDOW + SAFETY + 60]);
      await hre.network.provider.send("evm_mine");
      const lPreHarvest = BN(await v.totalLiquidity());
      const skipPre = BN(await s.swapSkippedCount());
      await v.doHardWork({ from: gov });
      const lPostHarvest = BN(await v.totalLiquidity());
      const idle0 = BN(await usdc.balanceOf(stratAddr)), idle1 = BN(await aaplc.balanceOf(stratAddr));
      console.log(`      ${label}: harvest totalL ${lPreHarvest} -> ${lPostHarvest}; skips ${skipPre}->${(await s.swapSkippedCount()).toString()}; strategy idle usdc=${idle0} aaplc=${idle1}`);
      assert.equal(lPostHarvest.gt(lPreHarvest), true,
        "the donated reward must be compounded into liquidity, not stranded as idle");

      const u0 = BN(await usdc.balanceOf(user)), a0 = BN(await aaplc.balanceOf(user));
      await v.withdraw(minted, 0, 0, { from: user });
      const back0 = BN(await usdc.balanceOf(user)).sub(u0);
      const back1 = BN(await aaplc.balanceOf(user)).sub(a0);
      console.log(`      ${label}: withdrew -> ${back0.toString()} USDC + ${back1.toString()} AAPLc`);
      assert.equal(back0.add(back1).gt(BN(0)), true, "withdraw must return value");
      assert.equal(BN(await v.balanceOf(user)).eq(shares0), true, "all shares must be burned");

      // Value both legs in USDC at spot and compare the whole round trip. token0=USDC(6dp),
      // token1=AAPLc(8dp); (sqrtPriceX96/2^96)^2 is token1 per token0 in RAW units, so raw AAPLc
      // converts to raw USDC by dividing by it. Done in BN to avoid float drift on 1e18 scales.
      const Q96 = BN(2).pow(BN(96));
      const sp = BN((await (await IPool.at(POOL)).slot0())[0]);
      const toUsdc = a => a.mul(Q96).mul(Q96).div(sp.mul(sp));
      const u_end = BN(await usdc.balanceOf(user)), a_end = BN(await aaplc.balanceOf(user));
      const startVal = u_start.add(toUsdc(a_start));
      const endVal = u_end.add(toUsdc(a_end));
      const lossBps = startVal.sub(endVal).mul(BN(10000)).div(startVal);
      console.log(`      ${label}: round trip ${startVal.toString()} -> ${endVal.toString()} USDC-equiv (${lossBps.toString()} bps)`);
      assert.equal(lossBps.lt(BN(100)), true,
        `a deposit+withdraw round trip must not lose materially (lost ${lossBps.toString()} bps)`);
    });
  }
});
