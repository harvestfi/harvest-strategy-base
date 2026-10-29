// The initialization front-run, and the fix.
//
// scripts/20 deploys a proxy in one transaction and initializes it in a later one. Both
// `initializeVault` and `initializeBaseStrategy` are `initializer`-guarded but otherwise
// permissionless, so between those two transactions anyone can initialize the proxy first. On Base
// this needs no mempool access: the proxy's creation is public the moment it lands, and the attacker
// takes the next block.
const { impersonates } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");
const CLVaultV2 = artifacts.require("CLVaultV2");
const VaultProxy = artifacts.require("VaultProxy");
const StrategyProxy = artifacts.require("StrategyProxy");
const Strategy = artifacts.require("AerodromeCLStrategyV2");
const CLRebalanceLibV2 = artifacts.require("CLRebalanceLibV2");
const Deployer = artifacts.require("CLProxyDeployer");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const IPool = artifacts.require("contracts/base/interface/concentrated-liquidity/IPool.sol:IPool");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IERC721 = artifacts.require("IERC721");

const V3 = require("../utilities/aero-v3-fixture.js");
const { NPM, POOL, GAUGE, WHALE, AERO, WETH, CBBTC, TS } = V3;
const WIDTH = 8, TARGET_BPS = 8000, BAND_BPS = 1000, SAFETY = 15; // safety is in BLOCKS
V3.disableConfirmationListeners(CLVaultV2, VaultProxy, StrategyProxy, Strategy, CLRebalanceLibV2, Deployer, IPosManager, IPool, IERC20, IERC721);
const BN = web3.utils.toBN;
let linkedLib = null;

describe("initialization front-running", function () {
  this.timeout(3600000);
  let gov, attacker, npm, nft, vaultImpl, stratImpl, lower, upper, snap;

  // Built once and snapshotted per test (it used to hardhat_reset the fork for every test).
  before(async () => {
    const acc = await web3.eth.getAccounts();
    gov = addresses.Governance; attacker = acc[5];
    await impersonates([gov, WHALE]);
    for (const a of [gov, attacker, WHALE]) {
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x152D02C7E14AF6800000"] });
    }
    npm = await IPosManager.at(NPM); nft = await IERC721.at(NPM);
    const t0 = await IERC20.at(WETH), t1 = await IERC20.at(CBBTC);
    for (const who of [gov, attacker]) {
      await t0.transfer(who, web3.utils.toWei("20"), { from: WHALE });
      await t1.transfer(who, "100000000", { from: WHALE });
      await t0.approve(NPM, web3.utils.toWei("20"), { from: who });
      await t1.approve(NPM, "100000000", { from: who });
    }
    const tick = parseInt((await (await IPool.at(POOL)).slot0())[1].toString(), 10);
    lower = (Math.floor(tick / TS) - WIDTH / 2) * TS; upper = lower + WIDTH * TS;
    const lib = await CLRebalanceLibV2.new({ from: gov });
    if (linkedLib === null) { await Strategy.link(lib); linkedLib = lib.address; }
    assert.equal(lib.address, linkedLib, "library must redeploy to the linked address");
    vaultImpl = (await CLVaultV2.new({ from: gov })).address;
    stratImpl = (await Strategy.new({ from: gov })).address;
    snap = await hre.network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await hre.network.provider.send("evm_revert", [snap]);
    snap = await hre.network.provider.send("evm_snapshot");
  });

  const mintSeed = async (who, w0, w1) => {
    const now = Number((await web3.eth.getBlock("latest")).timestamp);
    const res = await npm.mint({ token0: WETH, token1: CBBTC, tickSpacing: TS, tickLower: lower,
      tickUpper: upper, amount0Desired: w0, amount1Desired: w1, amount0Min: 0, amount1Min: 0,
      recipient: who, deadline: now + 1800, sqrtPriceX96: 0 }, { from: who });
    const evs = await nft.getPastEvents("Transfer", { fromBlock: res.receipt.blockNumber, toBlock: res.receipt.blockNumber });
    return evs.filter(e => e.returnValues.to.toLowerCase() === who.toLowerCase()).map(e => e.returnValues.tokenId).pop();
  };

  it("the two-step flow really is front-runnable — an attacker burns the proxy", async () => {
    const stakedId = await mintSeed(gov, web3.utils.toWei("8"), "40000000");
    const bufferId = await mintSeed(gov, web3.utils.toWei("2"), "10000000");

    // Step 1 of scripts/20: the proxy lands on-chain, uninitialized and public.
    const proxy = await VaultProxy.new(vaultImpl, { from: gov });
    const vault = await CLVaultV2.at(proxy.address);

    // The attacker sees it and initializes first, with their OWN seeds and their own storage.
    const aStaked = await mintSeed(attacker, web3.utils.toWei("1"), "5000000");
    const aBuffer = await mintSeed(attacker, web3.utils.toWei("1"), "5000000");
    await nft.approve(vault.address, aStaked, { from: attacker });
    await nft.approve(vault.address, aBuffer, { from: attacker });
    await vault.initializeVault(addresses.Storage, aStaked, aBuffer, NPM, WIDTH, TARGET_BPS, BAND_BPS, SAFETY, { from: attacker });

    // Step 2 of scripts/20 now reverts: the proxy is spent.
    await nft.approve(vault.address, stakedId, { from: gov });
    await nft.approve(vault.address, bufferId, { from: gov });
    let threw = false, msg = "";
    try {
      await vault.initializeVault(addresses.Storage, stakedId, bufferId, NPM, WIDTH, TARGET_BPS, BAND_BPS, SAFETY, { from: gov });
    } catch (e) { threw = true; msg = e.message; }
    console.log(`      deployer's initializeVault reverted=${threw}  ${msg.slice(0, 60)}`);
    assert.equal(threw, true, "premise: the second initializeVault must fail — that is the burn");

    // The seeds are NOT stolen: initializeVault pulls from ITS msg.sender, so the attacker could
    // only ever contribute their own. This is griefing, not theft.
    assert.equal(await nft.ownerOf(stakedId), gov, "the deployer's staked seed must still be theirs");
    assert.equal(await nft.ownerOf(bufferId), gov, "the deployer's buffer seed must still be theirs");
    assert.equal(BN(await vault.balanceOf(attacker)).gt(BN(0)), true, "the attacker owns the burned vault's shares");
  });

  it("the atomic deployer closes the window and produces an equivalent vault", async () => {
    const stakedId = await mintSeed(gov, web3.utils.toWei("8"), "40000000");
    const bufferId = await mintSeed(gov, web3.utils.toWei("2"), "10000000");
    const dep = await Deployer.new({ from: gov });
    await nft.approve(dep.address, stakedId, { from: gov });
    await nft.approve(dep.address, bufferId, { from: gov });

    const rc = await dep.deployVault(vaultImpl, addresses.Storage, stakedId, bufferId, NPM,
      WIDTH, TARGET_BPS, BAND_BPS, SAFETY, { from: gov });
    const ev = rc.logs.find(l => l.event === "VaultDeployed");
    const vault = await CLVaultV2.at(ev.args.vault);
    console.log(`      vault ${ev.args.vault} shares ${ev.args.shares.toString()} in ONE tx`);

    // Equivalence with the two-step result.
    assert.equal((await vault.posId()).toString(), stakedId.toString(), "staked seed must be adopted");
    assert.equal((await vault.bufferPosId()).toString(), bufferId.toString(), "buffer seed must be adopted");
    assert.equal(await nft.ownerOf(stakedId), vault.address, "vault must hold the staked seed");
    assert.equal(await nft.ownerOf(bufferId), vault.address, "vault must hold the buffer seed");
    assert.equal((await vault.targetWidth()).toString(), String(WIDTH), "targetWidth must be set");
    assert.equal(BN(await vault.totalLiquidity()).gt(BN(0)), true, "vault must hold liquidity");

    // The shares must reach the caller, not sit in the stateless helper forever.
    assert.equal(BN(await vault.balanceOf(dep.address)).isZero(), true, "the deployer contract must retain NO shares");
    assert.equal(BN(await vault.balanceOf(gov)).eq(BN(await vault.totalSupply())), true,
      "the caller must hold the entire seed supply");

    // And the proxy cannot be front-run, because it did not exist before it was initialized.
    let threw = false;
    try {
      await vault.initializeVault(addresses.Storage, stakedId, bufferId, NPM, WIDTH, TARGET_BPS, BAND_BPS, SAFETY, { from: attacker });
    } catch (e) { threw = true; }
    assert.equal(threw, true, "the vault must already be initialized");
  });

  it("the strategy proxy is atomically initialized too", async () => {
    const stakedId = await mintSeed(gov, web3.utils.toWei("8"), "40000000");
    const bufferId = await mintSeed(gov, web3.utils.toWei("2"), "10000000");
    const dep = await Deployer.new({ from: gov });
    await nft.approve(dep.address, stakedId, { from: gov });
    await nft.approve(dep.address, bufferId, { from: gov });
    const rc = await dep.deployVault(vaultImpl, addresses.Storage, stakedId, bufferId, NPM,
      WIDTH, TARGET_BPS, BAND_BPS, SAFETY, { from: gov });
    const vaultAddr = rc.logs.find(l => l.event === "VaultDeployed").args.vault;

    const rc2 = await dep.deployStrategy(stratImpl, addresses.Storage, vaultAddr, GAUGE, AERO, { from: gov });
    const sAddr = rc2.logs.find(l => l.event === "StrategyDeployed").args.strategy;
    const strategy = await Strategy.at(sAddr);
    console.log(`      strategy ${sAddr} in ONE tx`);
    assert.equal(await strategy.vault(), vaultAddr, "strategy must point at the vault");
    assert.equal(await strategy.rewardPool(), GAUGE, "strategy must point at the gauge");
    let threw = false;
    try { await strategy.initializeBaseStrategy(addresses.Storage, vaultAddr, GAUGE, AERO, { from: attacker }); }
    catch (e) { threw = true; }
    assert.equal(threw, true, "the strategy must already be initialized");
  });
});
