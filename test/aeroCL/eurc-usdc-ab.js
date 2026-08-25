// End-to-end rehearsal of the EURC/USDC A/B deployment: two vaults on the SAME pool and gauge,
// identical settings except posWidth (1 vs 2). Proves the pair can be deployed, staked, used and
// rebalanced side by side before any mainnet transaction is sent.
const { impersonates } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

const VaultProxy = artifacts.require("VaultProxy");
const CLVault = artifacts.require("CLVault");
const CLRebalanceHelper = artifacts.require("CLRebalanceHelper");
const StrategyProxy = artifacts.require("StrategyProxy");
const Strategy = artifacts.require("AerodromeCLStrategyMainnet_EURC_USDC");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const IPool = artifacts.require("contracts/base/interface/concentrated-liquidity/IPool.sol:IPool");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IERC721 = artifacts.require("IERC721");

const POOL  = "0xE846373C1a92B167b4E9cd5d8E4d6B1Db9E90EC7"; // EURC/USDC ts=50 (F1)
const GAUGE = "0x1f6c9d116CE22b51b0BC666f86B038a6c19900B8";
const NPM   = "0x827922686190790b37229fd06084350E74485b72";
const EURC  = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42";
const USDC  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TS = 50;
const BN = web3.utils.toBN;

describe("EURC/USDC A/B deployment rehearsal (posWidth 1 vs 2)", function () {
  this.timeout(900000);
  let governance, user, helper, npm, t0, t1, tick;
  const arms = { 1: {}, 2: {} };

  before(async () => {
    const accounts = await web3.eth.getAccounts();
    governance = addresses.Governance;
    user = accounts[4];
    await impersonates([governance, POOL]);
    for (const a of [governance, user, POOL]) {
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x21E19E0C9BAB2400000"] });
    }
    t0 = await IERC20.at(EURC);
    t1 = await IERC20.at(USDC);
    npm = await IPosManager.at(NPM);
    // fund from the pool's own reserves (fork-only convenience)
    await t0.transfer(governance, "400000000000", { from: POOL }); // 400k EURC
    await t1.transfer(governance, "400000000000", { from: POOL }); // 400k USDC
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

  for (const width of [1, 2]) {
    it(`mints a ${width * TS}-tick seed and deploys the posWidth=${width} vault`, async () => {
      const [tickLower, tickUpper] = rangeFor(width);
      await t0.approve(NPM, "200000000000", { from: governance });
      await t1.approve(NPM, "200000000000", { from: governance });
      const res = await npm.mint({
        token0: EURC, token1: USDC, tickSpacing: TS, tickLower, tickUpper,
        amount0Desired: "150000000000", amount1Desired: "150000000000",
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
      await vault.setRebalanceSafetyConfig(10000, 100, 900, 200, { from: governance });
      await vault.setRebalanceConfig(0, 3600, governance, { from: governance });
      await vault.setLanePause(false, false, false, false, { from: governance });

      const sImpl = await Strategy.new();
      const sProxy = await StrategyProxy.new(sImpl.address);
      const strategy = await Strategy.at(sProxy.address);
      await strategy.initializeStrategy(addresses.Storage, vault.address, { from: governance });
      await vault.setStrategy(strategy.address, { from: governance });

      arms[width] = { vault, strategy, posId, tickLower, tickUpper, implAddr: sImpl.address };
      const onchainWidth = (parseInt((await vault.tickUpper()).toString()) - parseInt((await vault.tickLower()).toString())) / TS;
      console.log(`      w${width}: posId=${posId} range=[${tickLower},${tickUpper}] posWidth=${onchainWidth} ` +
        `targetWidth=${(await vault.targetWidth()).toString()} vault=${vault.address}`);
      assert.equal(onchainWidth, width, "seed width must equal targetWidth");
      assert.equal((await strategy.rewardPool()).toLowerCase(), GAUGE.toLowerCase());
      assert.equal((await vault.token0()).toLowerCase(), EURC.toLowerCase());
      assert.equal((await vault.token1()).toLowerCase(), USDC.toLowerCase());
    });
  }

  it("both vaults stake into the same gauge and coexist", async () => {
    const nft = await IERC721.at(NPM);
    for (const w of [1, 2]) {
      await arms[w].vault.doHardWork({ from: governance });
      const owner = await nft.ownerOf(arms[w].posId);
      console.log(`      w${w}: NFT ${arms[w].posId} owner=${owner} ${owner.toLowerCase() === GAUGE.toLowerCase() ? "(GAUGE)" : "(NOT STAKED)"}`);
      assert.equal(owner.toLowerCase(), GAUGE.toLowerCase(), `w${w} must be staked`);
    }
    // the gauge tracks stakes per depositor, so the two strategies must not collide
    const g = new web3.eth.Contract([{ name: "stakedContains", type: "function", stateMutability: "view",
      inputs: [{ name: "d", type: "address" }, { name: "t", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }], GAUGE);
    for (const w of [1, 2]) {
      const mine = await g.methods.stakedContains(arms[w].strategy.address, arms[w].posId).call();
      const other = await g.methods.stakedContains(arms[w === 1 ? 2 : 1].strategy.address, arms[w].posId).call();
      console.log(`      w${w}: stakedContains(own strategy)=${mine}  (other strategy)=${other}`);
      assert.equal(mine, true); assert.equal(other, false);
    }
  });

  it("deposit + withdraw work on both arms and leave them staked", async () => {
    const nft = await IERC721.at(NPM);
    for (const w of [1, 2]) {
      const { vault } = arms[w];
      await t0.transfer(user, "1000000000", { from: POOL });
      await t1.transfer(user, "1000000000", { from: POOL });
      await t0.approve(vault.address, "1000000000", { from: user });
      await t1.approve(vault.address, "1000000000", { from: user });
      const before0 = BN(await t0.balanceOf(user)), before1 = BN(await t1.balanceOf(user));
      await vault.deposit("1000000000", "1000000000", 0, user, { from: user });
      const shares = BN(await vault.balanceOf(user));
      assert.equal(shares.gt(BN("0")), true, `w${w} deposit must mint shares`);
      await vault.withdraw(shares.toString(), 0, 0, { from: user });
      const d0 = before0.sub(BN(await t0.balanceOf(user))), d1 = before1.sub(BN(await t1.balanceOf(user)));
      const owner = await nft.ownerOf(await vault.posId());
      console.log(`      w${w}: round-trip cost EURC=${d0.toString()} USDC=${d1.toString()}  staked-after=${owner.toLowerCase() === GAUGE.toLowerCase()}`);
      assert.equal(owner.toLowerCase(), GAUGE.toLowerCase(), `w${w} must be re-staked after withdraw`);
    }
  });

  it("rebalance works on both arms and keeps posWidth", async () => {
    const nft = await IERC721.at(NPM);
    for (const w of [1, 2]) {
      const { vault } = arms[w];
      const before = (await vault.posId()).toString();
      await vault.rebalanceCurrentTick(w, { from: governance });
      const after = (await vault.posId()).toString();
      const onchainWidth = (parseInt((await vault.tickUpper()).toString()) - parseInt((await vault.tickLower()).toString())) / TS;
      const owner = await nft.ownerOf(after);
      console.log(`      w${w}: posId ${before} -> ${after}  width=${onchainWidth}  staked=${owner.toLowerCase() === GAUGE.toLowerCase()}`);
      assert.equal(onchainWidth, w, `w${w} width must be preserved`);
      assert.equal(owner.toLowerCase(), GAUGE.toLowerCase(), `w${w} must stay staked (no-op rebalance included)`);
    }
  });

  it("reports the value-per-share metric to compare the arms on", async () => {
    for (const w of [1, 2]) {
      const { vault, strategy } = arms[w];
      const sqrt = BN(await vault.getSqrtPriceX96());
      const amts = await vault.getCurrentTokenAmounts();
      const idle0 = BN(await t0.balanceOf(vault.address)).add(BN(await t0.balanceOf(strategy.address)));
      const idle1 = BN(await t1.balanceOf(vault.address)).add(BN(await t1.balanceOf(strategy.address)));
      const a0 = BN(amts[0]).add(idle0), a1 = BN(amts[1]).add(idle1);
      const Q96 = BN(2).pow(BN(96));
      const v = a0.mul(sqrt).div(Q96).mul(sqrt).div(Q96).add(a1); // USDC-denominated
      const supply = BN(await vault.totalSupply());
      console.log(`      w${w}: value=${v.toString()} USDC-raw  supply=${supply.toString()}  ` +
        `valuePerShare=${v.mul(BN(10).pow(BN(18))).div(supply).toString()}  PPS=${(await vault.getPricePerFullShare()).toString()}`);
    }
  });
});
