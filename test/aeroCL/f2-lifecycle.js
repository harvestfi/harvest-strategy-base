// Full CLVault lifecycle against the SECOND Aerodrome Slipstream deployment (factory
// 0xf8f2eB49..., position manager 0xe1f8cd9A...), which hosts the deepest Base pools.
// Proves whether running the existing strategy there is config-only or needs code changes.
const { impersonates, setupCoreProtocol } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

const VaultProxy = artifacts.require("VaultProxy");
const CLVault = artifacts.require("CLVault");
const CLRebalanceHelper = artifacts.require("CLRebalanceHelper");
const StrategyProxy = artifacts.require("StrategyProxy");
const Strategy = artifacts.require("AerodromeCLStrategyMainnet_WETH_cbBTC");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IERC721 = artifacts.require("IERC721");

const NPM2  = "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53";
const POOL  = "0x42d4a22CaD0F5a49681a5715cE994Af73A43B76b"; // WETH/cbBTC ts=10 (F2)
const GAUGE = "0x61E0B10423a0009C3f83ab4313813d29437d0817";
const WETH  = "0x4200000000000000000000000000000000000006";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const TS = 10;
const WIDTH = 8; // posWidth in tickSpacings -> 80 ticks

const BN = web3.utils.toBN;

describe("F2 deployment — full CLVault lifecycle (WETH/cbBTC ts=10)", function () {
  this.timeout(900000);
  let governance, user, vault, strategy, helper, posId, t0, t1, npm;

  before(async () => {
    const accounts = await web3.eth.getAccounts();
    governance = addresses.Governance;
    user = accounts[3];
    await impersonates([governance, POOL]);
    for (const a of [governance, user, POOL]) {
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x21E19E0C9BAB2400000"] });
    }
    t0 = await IERC20.at(WETH);
    t1 = await IERC20.at(CBBTC);
    npm = await IPosManager.at(NPM2);

    // Fund governance from the pool's own reserves (fork-only convenience).
    await t0.transfer(governance, web3.utils.toWei("40", "ether"), { from: POOL });
    await t1.transfer(governance, "120000000", { from: POOL }); // 1.2 cbBTC (8dp)

    const IPool = artifacts.require("contracts/base/interface/concentrated-liquidity/IPool.sol:IPool");
    const slot0 = await (await IPool.at(POOL)).slot0();
    const tick = parseInt(slot0[1].toString());
    const mid = Math.floor(tick / TS);
    const tickLower = (mid - WIDTH / 2) * TS;
    const tickUpper = tickLower + WIDTH * TS;
    console.log(`      pool tick=${tick} -> seeding position [${tickLower}, ${tickUpper}] (width ${WIDTH})`);

    await t0.approve(NPM2, web3.utils.toWei("40", "ether"), { from: governance });
    await t1.approve(NPM2, "120000000", { from: governance });
    const res = await npm.mint({
      token0: WETH, token1: CBBTC, tickSpacing: TS,
      tickLower, tickUpper,
      amount0Desired: web3.utils.toWei("30", "ether"),
      amount1Desired: "100000000",
      amount0Min: 0, amount1Min: 0,
      recipient: governance, deadline: Math.floor(Date.now() / 1000) + 3600,
      sqrtPriceX96: 0,
    }, { from: governance });
    posId = res.logs ? null : null;
    // tokenId comes from the NFT Transfer event
    const nft = await IERC721.at(NPM2);
    const evs = await nft.getPastEvents("Transfer", { fromBlock: res.receipt.blockNumber, toBlock: res.receipt.blockNumber });
    posId = evs.filter(e => e.returnValues.to.toLowerCase() === governance.toLowerCase())
               .map(e => e.returnValues.tokenId).pop();
    console.log(`      minted F2 position tokenId=${posId}`);
  });

  it("initializeVault accepts the F2 position manager and derives the F2 pool", async () => {
    const impl = await CLVault.new();
    const proxy = await VaultProxy.new(impl.address);
    vault = await CLVault.at(proxy.address);
    const nft = await IERC721.at(NPM2);
    await nft.approve(vault.address, posId, { from: governance });
    await vault.initializeVault(addresses.Storage, posId, NPM2, WIDTH, { from: governance });

    helper = await CLRebalanceHelper.new();
    await vault.setRebalanceHelper(helper.address, { from: governance });
    await vault.setRebalanceSafetyConfig(10000, 100, 900, 200, { from: governance });
    await vault.setRebalanceConfig(0, 0, governance, { from: governance });
    await vault.setLanePause(false, false, false, false, { from: governance });

    console.log(`      VAULT ADDRESS = ${vault.address}`);
    const derived = await helper.poolAddressFor(NPM2, WETH, CBBTC, TS);
    console.log(`      vault.posManager=${await vault.posManager()}`);
    console.log(`      helper.poolAddressFor -> ${derived}`);
    assert.equal(derived.toLowerCase(), POOL.toLowerCase(), "pool derivation must resolve the F2 pool");
    assert.equal((await vault.token0()).toLowerCase(), WETH.toLowerCase());
    assert.equal((await vault.token1()).toLowerCase(), CBBTC.toLowerCase());
    console.log(`      NAV=${(await vault.underlyingBalanceWithInvestment()).toString()} PPS=${(await vault.getPricePerFullShare()).toString()}`);
  });

  it("strategy stakes the F2 position into the F2 gauge via doHardWork", async () => {
    const impl = await Strategy.new();
    const proxy = await StrategyProxy.new(impl.address);
    strategy = await Strategy.at(proxy.address);
    await strategy.initializeStrategy(addresses.Storage, vault.address, { from: governance });
    await vault.setStrategy(strategy.address, { from: governance });

    assert.equal((await strategy.rewardPool()).toLowerCase(), GAUGE.toLowerCase(), "gauge wired");
    await vault.doHardWork({ from: governance });

    const nft = await IERC721.at(NPM2);
    const owner = await nft.ownerOf(posId);
    const label = owner.toLowerCase() === GAUGE.toLowerCase() ? "GAUGE (staked)"
                : owner.toLowerCase() === vault.address.toLowerCase() ? "VAULT (idle!)"
                : owner.toLowerCase() === strategy.address.toLowerCase() ? "STRATEGY (unstaked)" : "unknown";
    console.log(`      after doHardWork, NFT owner = ${owner}  -> ${label}`);
    assert.equal(owner.toLowerCase(), GAUGE.toLowerCase(), "NFT must be staked in the F2 gauge");
  });

  it("user deposit works and re-stakes", async () => {
    await t0.transfer(user, web3.utils.toWei("2", "ether"), { from: POOL });
    await t1.transfer(user, "8000000", { from: POOL });
    await t0.approve(vault.address, web3.utils.toWei("2", "ether"), { from: user });
    await t1.approve(vault.address, "8000000", { from: user });

    const ppsBefore = BN(await vault.getPricePerFullShare());
    await vault.deposit(web3.utils.toWei("2", "ether"), "8000000", 0, user, { from: user });
    const shares = BN(await vault.balanceOf(user));
    const ppsAfter = BN(await vault.getPricePerFullShare());
    const nft = await IERC721.at(NPM2);
    console.log(`      shares=${shares.toString()} pps ${ppsBefore} -> ${ppsAfter}`);
    console.log(`      NFT owner after deposit = ${await nft.ownerOf(posId)}`);
    assert.equal(shares.gt(BN("0")), true, "must mint shares");
    assert.equal((await nft.ownerOf(posId)).toLowerCase(), GAUGE.toLowerCase(), "must be re-staked");
  });

  it("rebalance works on the F2 pool", async () => {
    const before = await vault.posId();
    const tl = parseInt((await vault.tickLower()).toString());
    const tu = parseInt((await vault.tickUpper()).toString());
    await vault.rebalanceCurrentTick(WIDTH, { from: governance });
    const after = await vault.posId();
    const nft = await IERC721.at(NPM2);
    console.log(`      posId ${before} -> ${after}; ticks [${tl},${tu}] -> [${await vault.tickLower()},${await vault.tickUpper()}]`);
    const ownerAfter = await nft.ownerOf(after);
    const lbl = ownerAfter.toLowerCase() === GAUGE.toLowerCase() ? "GAUGE (staked)"
              : ownerAfter.toLowerCase() === vault.address.toLowerCase() ? "VAULT (idle!)" : ownerAfter;
    console.log(`      NFT owner after rebalance = ${ownerAfter}  -> ${lbl}`);
    assert.equal(ownerAfter.toLowerCase(), GAUGE.toLowerCase(),
      "position must remain staked even when the rebalance is a no-op");
    console.log(`      strategy idle: WETH=${(await t0.balanceOf(strategy.address)).toString()} cbBTC=${(await t1.balanceOf(strategy.address)).toString()}`);
  });

  it("user withdraw returns funds", async () => {
    const shares = BN(await vault.balanceOf(user));
    const b0 = BN(await t0.balanceOf(user));
    const b1 = BN(await t1.balanceOf(user));
    await vault.withdraw(shares.toString(), 0, 0, { from: user });
    const d0 = BN(await t0.balanceOf(user)).sub(b0);
    const d1 = BN(await t1.balanceOf(user)).sub(b1);
    console.log(`      withdrew WETH=${web3.utils.fromWei(d0.toString())} cbBTC=${d1.toString()}`);
    assert.equal(d0.add(d1).gt(BN("0")), true, "must return funds");
    assert.equal(BN(await vault.balanceOf(user)).isZero(), true, "shares burned");
  });

  it("AERO accrues to the staked position", async () => {
    const AERO = await IERC20.at("0x940181a94A35A4569E4529A3CDfB74e38FD98631");
    const gauge = new web3.eth.Contract([
      { name: "earned", type: "function", stateMutability: "view",
        inputs: [{name:"a",type:"address"},{name:"b",type:"uint256"}],
        outputs: [{name:"",type:"uint256"}] }], GAUGE);
    const earned = await gauge.methods.earned(strategy.address, (await vault.posId()).toString()).call();
    console.log(`      gauge.earned(strategy, posId) = ${earned}`);
    await hre.network.provider.request({ method: "evm_increaseTime", params: [86400] });
    await hre.network.provider.request({ method: "evm_mine", params: [] });
    const earned2 = await gauge.methods.earned(strategy.address, (await vault.posId()).toString()).call();
    console.log(`      after +1 day = ${earned2}`);
    const before = BN(await AERO.balanceOf(strategy.address));
    await vault.doHardWork({ from: governance });
    console.log(`      AERO in strategy before/after doHardWork: ${before} / ${(await AERO.balanceOf(strategy.address)).toString()}`);
  });
});
