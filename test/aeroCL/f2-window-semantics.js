// The two gauge behaviours the V2 design depends on, at the realistic 300s window:
//   1. getReward() inside the window forfeits accrued AERO.
//   2. getReward() does NOT reset depositTimestamp (so harvesting never extends the window),
//      while unstake+restake DOES.
// If (2) were false, every harvest would restart the exposure and the design would not work.
const { impersonates } = require("../utilities/hh-utils.js");
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
const TS = 10, WIDTH = 8, WINDOW = 300;
const BN = web3.utils.toBN;
const A = v => Number(web3.utils.fromWei(v.toString())).toFixed(6);

const G = [
  { name: "deposit", type: "function", stateMutability: "nonpayable", inputs: [{ name: "t", type: "uint256" }], outputs: [] },
  { name: "withdraw", type: "function", stateMutability: "nonpayable", inputs: [{ name: "t", type: "uint256" }], outputs: [] },
  { name: "getReward", type: "function", stateMutability: "nonpayable", inputs: [{ name: "t", type: "uint256" }], outputs: [] },
  { name: "earned", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }, { name: "t", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "depositTimestamp", type: "function", stateMutability: "view", inputs: [{ name: "t", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
];
const FA = [
  { name: "setMinStakeTime", type: "function", stateMutability: "nonpayable", inputs: [{ name: "p", type: "address" }, { name: "v", type: "uint256" }], outputs: [] },
  { name: "minStakeTimes", type: "function", stateMutability: "view", inputs: [{ name: "p", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
];

describe("F2 window semantics at 300s", function () {
  this.timeout(1800000);
  let me, npm, nft, aero, gauge, factory;
  const evmNow = async () => Number((await web3.eth.getBlock("latest")).timestamp);

  before(async () => {
    me = (await web3.eth.getAccounts())[3];
    await impersonates([POOL, ADMIN]);
    for (const a of [me, POOL, ADMIN]) await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x21E19E0C9BAB2400000"] });
    npm = await IPosManager.at(NPM2); nft = await IERC721.at(NPM2); aero = await IERC20.at(AERO);
    gauge = new web3.eth.Contract(G, GAUGE); factory = new web3.eth.Contract(FA, FACTORY);
    await (await IERC20.at(WETH)).transfer(me, web3.utils.toWei("10"), { from: POOL });
    await (await IERC20.at(CBBTC)).transfer(me, "50000000", { from: POOL });
    await (await IERC20.at(WETH)).approve(NPM2, web3.utils.toWei("10"), { from: me });
    await (await IERC20.at(CBBTC)).approve(NPM2, "50000000", { from: me });
    await factory.methods.setMinStakeTime(POOL, WINDOW).send({ from: ADMIN, gas: 500000 });
    console.log(`      minStakeTimes(pool) = ${await factory.methods.minStakeTimes(POOL).call()}s\n`);
  });

  async function stake() {
    const tick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
    const lower = (Math.floor(tick / TS) - WIDTH / 2) * TS;
    const res = await npm.mint({
      token0: WETH, token1: CBBTC, tickSpacing: TS, tickLower: lower, tickUpper: lower + WIDTH * TS,
      amount0Desired: web3.utils.toWei("2"), amount1Desired: "10000000", amount0Min: 0, amount1Min: 0,
      recipient: me, deadline: (await evmNow()) + 1800, sqrtPriceX96: 0,
    }, { from: me });
    const evs = await nft.getPastEvents("Transfer", { fromBlock: res.receipt.blockNumber, toBlock: res.receipt.blockNumber });
    const id = evs.filter(e => e.returnValues.to.toLowerCase() === me.toLowerCase()).map(e => e.returnValues.tokenId).pop();
    await nft.approve(GAUGE, id, { from: me });
    await gauge.methods.deposit(id).send({ from: me, gas: 3000000 });
    return id;
  }
  const advance = async s => { await hre.network.provider.send("evm_increaseTime", [s]); await hre.network.provider.send("evm_mine"); };
  async function claim(id) {
    const earned = BN(await gauge.methods.earned(me, id).call());
    const pre = BN(await aero.balanceOf(me));
    await gauge.methods.getReward(id).send({ from: me, gas: 3000000 });
    const got = BN(await aero.balanceOf(me)).sub(pre);
    return { earned, got, lostPct: earned.isZero() ? null : Number(earned.sub(got).mul(BN(10000)).div(earned).toString()) / 100 };
  }

  it("getReward() INSIDE the window pays nothing, and does not move depositTimestamp", async () => {
    const id = await stake();
    const ts0 = Number(await gauge.methods.depositTimestamp(id).call());
    await advance(WINDOW / 2);
    const r = await claim(id);
    const ts1 = Number(await gauge.methods.depositTimestamp(id).call());
    console.log(`      inside  (t=${WINDOW / 2}s of ${WINDOW}s): earned ${A(r.earned)} -> got ${A(r.got)} AERO  forfeited ${r.lostPct === null ? "n/a (nothing accrued)" : r.lostPct + "%"}`);
    console.log(`        depositTimestamp ${ts0} -> ${ts1}  ${ts0 === ts1 ? "UNCHANGED (claim does not restart the window)" : "MOVED"}`);
    assert.equal(ts1, ts0, "getReward must not reset the stake clock");
    // earned() reports the penalty-ADJUSTED claimable amount: inside the window it reads 0 even
    // though emissions are accruing, and the claim pays out 0. That is convenient for the vault -
    // `earned() == 0 while staked and in range` is itself a usable "still inside the window" signal.
    assert.equal(r.earned.isZero(), true, "earned() should report 0 (penalty-adjusted) inside the window");
    assert.equal(r.got.isZero(), true, "a claim inside the window must pay nothing");
  });

  it("getReward() OUTSIDE the window pays in full, still without moving the clock", async () => {
    const id = await stake();
    const ts0 = Number(await gauge.methods.depositTimestamp(id).call());
    await advance(WINDOW + 30);
    const r = await claim(id);
    const ts1 = Number(await gauge.methods.depositTimestamp(id).call());
    console.log(`      outside (t=${WINDOW + 30}s of ${WINDOW}s): earned ${A(r.earned)} -> got ${A(r.got)} AERO  forfeited ${r.lostPct === null ? "n/a" : r.lostPct + "%"}`);
    console.log(`        depositTimestamp ${ts0} -> ${ts1}  ${ts0 === ts1 ? "UNCHANGED" : "MOVED"}`);
    assert.equal(ts1, ts0, "getReward must not reset the stake clock");
    if (r.lostPct !== null) assert.equal(r.lostPct <= 0.5, true, `no forfeit expected outside the window, saw ${r.lostPct}%`);
  });

  it("unstake + restake DOES reset the clock", async () => {
    const id = await stake();
    const ts0 = Number(await gauge.methods.depositTimestamp(id).call());
    await advance(WINDOW + 30);
    await gauge.methods.withdraw(id).send({ from: me, gas: 3000000 });
    await nft.approve(GAUGE, id, { from: me });
    await gauge.methods.deposit(id).send({ from: me, gas: 3000000 });
    const ts1 = Number(await gauge.methods.depositTimestamp(id).call());
    console.log(`      depositTimestamp ${ts0} -> ${ts1} after unstake+restake  (+${ts1 - ts0}s)`);
    assert.equal(ts1 > ts0, true, "restake must reset the clock");
  });
});
