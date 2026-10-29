// What does the F2 penalty actually cost, and can it be managed?
//
// Today minStakeTimes(pool)=10s, so the penalty is invisible. But MAX_MIN_STAKE_TIME is 7 days and
// notifyAdmin can raise it in one tx with no notice, so a vault has to be solvent at the maximum,
// not at today's value. Two questions decide the design:
//   1. Does getReward() alone forfeit inside the window? If so the at-risk balance cannot be
//      drained by harvesting - it just grows for the whole window.
//   2. Does re-staking reset the clock? If so every buffer refill restarts the exposure.
const { impersonates } = require("../utilities/hh-utils.js");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const IPool = artifacts.require("contracts/base/interface/concentrated-liquidity/IPool.sol:IPool");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IERC721 = artifacts.require("IERC721");

const NPM2 = "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53";
const POOL = "0x42d4a22CaD0F5a49681a5715cE994Af73A43B76b";
const GAUGE = "0x61E0B10423a0009C3f83ab4313813d29437d0817";
const FACTORY = "0x385293CaE378C813F16f0C1334d774AdDDf56AbB";
const NOTIFY_ADMIN = "0xE6A41fE61E7a1996B59d508661e3f524d6A32075";
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const WETH = "0x4200000000000000000000000000000000000006";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const TS = 10, WIDTH = 8, WEEK = 604800;
const BN = web3.utils.toBN;
const F = v => Number(web3.utils.fromWei(v.toString())).toFixed(4);

const GAUGE_ABI = [
  { name: "deposit", type: "function", stateMutability: "nonpayable", inputs: [{ name: "t", type: "uint256" }], outputs: [] },
  { name: "withdraw", type: "function", stateMutability: "nonpayable", inputs: [{ name: "t", type: "uint256" }], outputs: [] },
  { name: "getReward", type: "function", stateMutability: "nonpayable", inputs: [{ name: "t", type: "uint256" }], outputs: [] },
  { name: "earned", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }, { name: "t", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "depositTimestamp", type: "function", stateMutability: "view", inputs: [{ name: "t", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
];
const FACTORY_ABI = [
  { name: "setMinStakeTime", type: "function", stateMutability: "nonpayable", inputs: [{ name: "p", type: "address" }, { name: "v", type: "uint256" }], outputs: [] },
  { name: "minStakeTimes", type: "function", stateMutability: "view", inputs: [{ name: "p", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
];

describe("F2 penalty window: cost and manageability at MAX_MIN_STAKE_TIME", function () {
  this.timeout(1800000);
  let me, npm, nft, aero, gauge, factory;

  before(async () => {
    const acc = await web3.eth.getAccounts();
    me = acc[3];
    await impersonates([POOL, NOTIFY_ADMIN]);
    for (const a of [me, POOL, NOTIFY_ADMIN]) {
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x21E19E0C9BAB2400000"] });
    }
    npm = await IPosManager.at(NPM2); nft = await IERC721.at(NPM2); aero = await IERC20.at(AERO);
    gauge = new web3.eth.Contract(GAUGE_ABI, GAUGE);
    factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);
    await (await IERC20.at(WETH)).transfer(me, web3.utils.toWei("20"), { from: POOL });
    await (await IERC20.at(CBBTC)).transfer(me, "100000000", { from: POOL });
    await (await IERC20.at(WETH)).approve(NPM2, web3.utils.toWei("20"), { from: me });
    await (await IERC20.at(CBBTC)).approve(NPM2, "100000000", { from: me });
  });

  async function evmNow() {
    return Number((await web3.eth.getBlock('latest')).timestamp)
  }

  async function freshStake() {
    const tick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
    const mid = Math.floor(tick / TS), lower = (mid - WIDTH / 2) * TS;
    const res = await npm.mint({
      token0: WETH, token1: CBBTC, tickSpacing: TS, tickLower: lower, tickUpper: lower + WIDTH * TS,
      amount0Desired: web3.utils.toWei("2"), amount1Desired: "10000000",
      amount0Min: 0, amount1Min: 0, recipient: me,
      deadline: (await evmNow()) + 1800, sqrtPriceX96: 0,
    }, { from: me });
    const evs = await nft.getPastEvents("Transfer", { fromBlock: res.receipt.blockNumber, toBlock: res.receipt.blockNumber });
    const id = evs.filter(e => e.returnValues.to.toLowerCase() === me.toLowerCase()).map(e => e.returnValues.tokenId).pop();
    await nft.approve(GAUGE, id, { from: me });
    await gauge.methods.deposit(id).send({ from: me, gas: 3000000 });
    return id;
  }

  it("raises minStakeTime to the 7-day maximum and measures the exposure", async () => {
    const g2 = new web3.eth.Contract([{ name: 'periodFinish', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] }], GAUGE);
    const periodFinish = Number(await g2.methods.periodFinish().call());
    const now0 = await evmNow();
    const runway = periodFinish - now0;
    console.log(`      gauge periodFinish in ${(runway / 3600).toFixed(1)}h - rewards only accrue that far ahead`);
    // Use the largest window we can still observe accrual inside of.
    const WINDOW = Math.min(WEEK, Math.max(2 * 3600, runway - 3600));
    await factory.methods.setMinStakeTime(POOL, WINDOW).send({ from: NOTIFY_ADMIN, gas: 500000 });
    const set = await factory.methods.minStakeTimes(POOL).call();
    console.log(`      minStakeTimes(pool) set to ${set}s (${(set / 3600).toFixed(1)}h) by notifyAdmin; MAX is ${WEEK}s\n`);
    this.WINDOW = Number(set);

    // --- 1. getReward() INSIDE the window
    let id = await freshStake();
    await hre.network.provider.send("evm_increaseTime", [Math.floor(this.WINDOW / 2)]);
    await hre.network.provider.send("evm_mine");
    let earned = BN(await gauge.methods.earned(me, id).call());
    let pre = BN(await aero.balanceOf(me));
    await gauge.methods.getReward(id).send({ from: me, gas: 3000000 });
    let got = BN(await aero.balanceOf(me)).sub(pre);
    const lostClaim = earned.isZero() ? 0 : Math.round(Number(earned.sub(got).mul(BN(10000)).div(earned).toString()) / 100);
    console.log(`      getReward() at HALF the window: earned ${F(earned)} AERO -> received ${F(got)} AERO  (forfeited ${lostClaim}%)`);
    if (earned.isZero()) {
      console.log('        => INCONCLUSIVE: nothing had accrued at this point (the fork sits near the end of a');
      console.log('           reward epoch, so periodFinish caps accrual). Re-run at a block with more runway');
      console.log('           to settle whether getReward() inside the window forfeits.');
    } else {
      console.log(`        => harvesting inside the window ${lostClaim > 0 ? 'DOES NOT reduce exposure; the at-risk balance cannot be drained' : 'works; exposure can be harvested away'}`);
    }

    // does the clock reset on claim?
    const tsAfterClaim = await gauge.methods.depositTimestamp(id).call();
    console.log(`        depositTimestamp after getReward: ${tsAfterClaim}`);
    await gauge.methods.withdraw(id).send({ from: me, gas: 3000000 });

    // --- 2. full window then claim
    id = await freshStake();
    const tsStake = Number(await gauge.methods.depositTimestamp(id).call());
    await hre.network.provider.send("evm_increaseTime", [this.WINDOW + 60]);
    await hre.network.provider.send("evm_mine");
    earned = BN(await gauge.methods.earned(me, id).call());
    pre = BN(await aero.balanceOf(me));
    await gauge.methods.getReward(id).send({ from: me, gas: 3000000 });
    got = BN(await aero.balanceOf(me)).sub(pre);
    console.log(`\n      getReward() after the full window: earned ${F(earned)} -> received ${F(got)} AERO  (forfeited ${earned.isZero()?0:Math.round(Number(earned.sub(got).mul(BN(10000)).div(earned).toString())/100)}%)`);

    // --- 3. does re-staking reset the clock?
    await gauge.methods.withdraw(id).send({ from: me, gas: 3000000 });
    await nft.approve(GAUGE, id, { from: me });
    await gauge.methods.deposit(id).send({ from: me, gas: 3000000 });
    const tsRestake = Number(await gauge.methods.depositTimestamp(id).call());
    console.log(`      depositTimestamp: first stake ${tsStake} -> after unstake+restake ${tsRestake}`);
    console.log(`        => clock ${tsRestake > tsStake ? "RESETS on every re-stake: each buffer refill restarts the full window" : "does not reset"}`);
  });
});
