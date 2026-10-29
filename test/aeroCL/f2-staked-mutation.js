// Can a staked F2 position be modified in place?
//
// The F2 gauge forfeits 100% of accrued AERO on any withdraw inside minStakeTime, so the whole
// design question is how much of deposit/withdraw can be served WITHOUT pulling the NFT out.
// UniV3's NonfungiblePositionManager leaves `increaseLiquidity` permissionless (only decrease/
// collect/burn check ownership), so if Slipstream kept that, deposits could go straight into the
// staked position and only withdrawals would need a buffer. This checks whether that holds, and
// crucially whether the gauge's reward accounting credits liquidity added behind its back.
const { impersonates } = require("../utilities/hh-utils.js");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const IPool = artifacts.require("contracts/base/interface/concentrated-liquidity/IPool.sol:IPool");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IERC721 = artifacts.require("IERC721");

const NPM2  = "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53";
const POOL  = "0x42d4a22CaD0F5a49681a5715cE994Af73A43B76b";
const GAUGE = "0x61E0B10423a0009C3f83ab4313813d29437d0817";
const WETH  = "0x4200000000000000000000000000000000000006";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const TS = 10, WIDTH = 8;
const BN = web3.utils.toBN;

const GAUGE_ABI = [
  { name: "deposit", type: "function", stateMutability: "nonpayable", inputs: [{ name: "t", type: "uint256" }], outputs: [] },
  { name: "withdraw", type: "function", stateMutability: "nonpayable", inputs: [{ name: "t", type: "uint256" }], outputs: [] },
  { name: "earned", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }, { name: "t", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "depositTimestamp", type: "function", stateMutability: "view", inputs: [{ name: "t", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "stakedContains", type: "function", stateMutability: "view", inputs: [{ name: "d", type: "address" }, { name: "t", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
];

describe("F2: can a staked position be modified in place?", function () {
  this.timeout(1800000);
  let me, npm, nft, t0, t1, gauge, posId, tickLower, tickUpper;

  before(async () => {
    const acc = await web3.eth.getAccounts();
    me = acc[3];
    await impersonates([POOL]);
    for (const a of [me, POOL]) {
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x21E19E0C9BAB2400000"] });
    }
    t0 = await IERC20.at(WETH); t1 = await IERC20.at(CBBTC);
    npm = await IPosManager.at(NPM2); nft = await IERC721.at(NPM2);
    gauge = new web3.eth.Contract(GAUGE_ABI, GAUGE);
    await t0.transfer(me, web3.utils.toWei("6"), { from: POOL });
    await t1.transfer(me, "30000000", { from: POOL });

    const tick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
    const mid = Math.floor(tick / TS), lower = (mid - WIDTH / 2) * TS;
    tickLower = lower; tickUpper = lower + WIDTH * TS;
    await t0.approve(NPM2, web3.utils.toWei("6"), { from: me });
    await t1.approve(NPM2, "30000000", { from: me });
    const res = await npm.mint({
      token0: WETH, token1: CBBTC, tickSpacing: TS, tickLower, tickUpper,
      amount0Desired: web3.utils.toWei("2"), amount1Desired: "10000000",
      amount0Min: 0, amount1Min: 0, recipient: me,
      deadline: Math.floor(Date.now() / 1000) + 1800, sqrtPriceX96: 0,
    }, { from: me });
    const evs = await nft.getPastEvents("Transfer", { fromBlock: res.receipt.blockNumber, toBlock: res.receipt.blockNumber });
    posId = evs.filter(e => e.returnValues.to.toLowerCase() === me.toLowerCase()).map(e => e.returnValues.tokenId).pop();
    console.log(`      minted posId=${posId} range=[${tickLower},${tickUpper}] liquidity=${(await npm.positions(posId)).liquidity.toString()}`);
  });

  it("stakes, then tries increaseLiquidity / decreaseLiquidity while the gauge owns the NFT", async () => {
    await nft.approve(GAUGE, posId, { from: me });
    await gauge.methods.deposit(posId).send({ from: me, gas: 3000000 });
    assert.equal((await nft.ownerOf(posId)).toLowerCase(), GAUGE.toLowerCase(), "gauge must own the NFT");
    const liqStaked = BN((await npm.positions(posId)).liquidity);
    console.log(`      staked. gauge owns NFT. liquidity=${liqStaked}  depositTimestamp=${await gauge.methods.depositTimestamp(posId).call()}`);

    // let some rewards accrue
    await hre.network.provider.send("evm_increaseTime", [86400]);
    await hre.network.provider.send("evm_mine");
    const earnedBefore = BN(await gauge.methods.earned(me, posId).call());
    console.log(`      after 1 day: earned=${web3.utils.fromWei(earnedBefore)} AERO`);

    // (a) increaseLiquidity on a gauge-owned NFT
    let incOk = false, incErr = "";
    try {
      await npm.increaseLiquidity({
        tokenId: posId, amount0Desired: web3.utils.toWei("1"), amount1Desired: "5000000",
        amount0Min: 0, amount1Min: 0, deadline: Math.floor(Date.now() / 1000) + 1800,
      }, { from: me });
      incOk = true;
    } catch (e) { incErr = e.message.split("\n")[0].slice(0, 80); }
    const liqAfterInc = BN((await npm.positions(posId)).liquidity);
    console.log(`      increaseLiquidity while staked: ${incOk ? "ALLOWED" : "REVERTED (" + incErr + ")"}`);
    console.log(`        position liquidity ${liqStaked} -> ${liqAfterInc}`);

    if (incOk && liqAfterInc.gt(liqStaked)) {
      // does the gauge credit the extra liquidity in reward accrual?
      const e1 = BN(await gauge.methods.earned(me, posId).call());
      await hre.network.provider.send("evm_increaseTime", [86400]);
      await hre.network.provider.send("evm_mine");
      const e2 = BN(await gauge.methods.earned(me, posId).call());
      const dayRateAfter = e2.sub(e1);
      const ratio = liqStaked.isZero() ? 0 : Number(liqAfterInc.mul(BN(1000)).div(liqStaked).toString()) / 1000;
      const rewardRatio = earnedBefore.isZero() ? 0 : Number(dayRateAfter.mul(BN(1000)).div(earnedBefore).toString()) / 1000;
      console.log(`        liquidity grew ${ratio}x; daily reward grew ${rewardRatio}x  -> gauge ${Math.abs(ratio - rewardRatio) < 0.15 ? "DOES credit it" : "does NOT credit it proportionally"}`);
    }

    // (b) decreaseLiquidity on a gauge-owned NFT
    let decOk = false, decErr = "";
    try {
      await npm.decreaseLiquidity({
        tokenId: posId, liquidity: liqAfterInc.div(BN(10)).toString(),
        amount0Min: 0, amount1Min: 0, deadline: Math.floor(Date.now() / 1000) + 1800,
      }, { from: me });
      decOk = true;
    } catch (e) { decErr = e.message.split("\n")[0].slice(0, 80); }
    console.log(`      decreaseLiquidity while staked: ${decOk ? "ALLOWED" : "REVERTED (" + decErr + ")"}`);

    // (c) what the penalty actually costs on withdraw inside the window
    const earnedPre = BN(await gauge.methods.earned(me, posId).call());
    const aero = await IERC20.at("0x940181a94A35A4569E4529A3CDfB74e38FD98631");
    const balPre = BN(await aero.balanceOf(me));
    await gauge.methods.withdraw(posId).send({ from: me, gas: 3000000 });
    const got = BN(await aero.balanceOf(me)).sub(balPre);
    console.log(`      withdraw inside minStakeTime: earned=${web3.utils.fromWei(earnedPre)} AERO, actually received=${web3.utils.fromWei(got)} AERO`);
    console.log(`      => forfeited ${earnedPre.isZero() ? 0 : Math.round(Number(earnedPre.sub(got).mul(BN(10000)).div(earnedPre).toString()) / 100)}%`);
  });
});
