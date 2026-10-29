// UniV3TwapFeed on a fork of Base: the iFARM and FARM USD prices from the Uniswap V3 WETH/FARM and
// FARM/iFARM pools' TWAP, and RewardForwarderV2 buying iFARM above that floor instead of an Ethereum anchor.
// Both pools keep a single observation (cardinality 1) at this block, as on mainnet before the cut-over.
// Run: npx hardhat test test/rewardForwarder/univ3-twap-feed.js

const assert = require("assert");
const { ethers, network } = require("hardhat");
const addresses = require("../test-config.js");

const FORK_BLOCK = 53238400;

const WETH = addresses.WETH;
const FARM = addresses.FARM;
const IFARM = addresses.iFARM;
const ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const WETH_FARM_POOL = "0x8037FE64f8365212Cb47ef9a9Cf2e80bDCFc66cF";
const FARM_IFARM_POOL = "0x9fd310A80e3D570CfB52b01224970eD7f3152976";
const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
const QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const HARD_WORKER = addresses.ULOwner;
const WINDOW = 1800;
const FEED_MAX_AGE = 86400;
const CHUNK = ethers.utils.parseEther("0.01");
const BUY_INTERVAL = 1800;
const WAD = ethers.constants.WeiPerEther;

const POOL_ABI = [
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function increaseObservationCardinalityNext(uint16)",
  "function fee() view returns (uint24)",
];
const ROUTER_ABI = ["function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256)"];
const QUOTER_ABI = ["function quoteExactInput(bytes,uint256) returns (uint256,uint160[],uint32[],uint256)"];
const WETH_ABI = ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];
const FEED_ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"];

const ratio = (a, b) => Number(a.mul(1000000).div(b)) / 1e6;

async function send(method, params = []) {
  return network.provider.send(method, params);
}
async function warp(seconds) {
  await send("evm_increaseTime", [seconds]);
  await send("evm_mine");
}
async function account(addr) {
  await send("hardhat_impersonateAccount", [addr]);
  await send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}
const buyPath = ethers.utils.solidityPack(["address", "uint24", "address", "uint24", "address"], [WETH, 3000, FARM, 3000, IFARM]);

describe("UniV3TwapFeed: iFARM priced from the Base pools", function () {
  let governance, hardWorker, whale, iFarmFeed, farmFeed, v2, weth, router, quoter, controller, snapshotId;

  // a trader who buys iFARM with WETH through both pools, moving the Base price
  async function pushPrice(wethIn) {
    await (await weth.connect(whale).approve(ROUTER, wethIn)).wait();
    await (await router.connect(whale).exactInput({ path: buyPath, recipient: whale.address, amountIn: wethIn, amountOutMinimum: 0 })).wait();
  }

  // iFARM out for a 0.0001 WETH buy through both pools (under a basis point of impact), scaled to one WETH
  // and grossed up for the two 0.3% fees: the pools' mid price, which the feed should match once the window
  // has no swaps in it
  async function spotIfarmPerWeth() {
    const amountIn = ethers.utils.parseEther("0.0001");
    const [out] = await quoter.callStatic.quoteExactInput(buyPath, amountIn);
    return out.mul(WAD).div(amountIn).mul(1000000).div(997 * 997);
  }

  async function feedIfarmPerWeth() {
    // WETH per iFARM from the feed's TWAP, inverted
    return WAD.mul(WAD).div(await iFarmFeed.twapQuote());
  }

  before(async function () {
    await send("hardhat_reset", [{ forking: { jsonRpcUrl: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`, blockNumber: FORK_BLOCK } }]);
    await send("evm_mine");
    // the window must start after the last swap, as it does on mainnet between buys
    await warp(WINDOW);

    governance = await account(addresses.Governance);
    hardWorker = await account(HARD_WORKER);
    whale = await account("0x00000000000000000000000000000000000BEEF1");
    weth = new ethers.Contract(WETH, WETH_ABI, whale);
    await (await weth.deposit({ value: ethers.utils.parseEther("20") })).wait();
    router = new ethers.Contract(ROUTER, ROUTER_ABI, whale);
    quoter = new ethers.Contract(QUOTER, QUOTER_ABI, ethers.provider);
    controller = await ethers.getContractAt("IController", addresses.Controller);

    const Feed = await ethers.getContractFactory("UniV3TwapFeed");
    iFarmFeed = await Feed.deploy([IFARM, FARM, WETH], [FARM_IFARM_POOL, WETH_FARM_POOL], ETH_USD_FEED, WINDOW, "iFARM / USD (Base TWAP)");
    farmFeed = await Feed.deploy([FARM, WETH], [WETH_FARM_POOL], ETH_USD_FEED, WINDOW, "FARM / USD (Base TWAP)");

    const V2 = await ethers.getContractFactory("RewardForwarderV2");
    v2 = await V2.deploy(addresses.Storage, WETH, IFARM);
    const g = v2.connect(governance);
    // Chainlink does not update on a fork and these tests jump hours ahead, so the ETH/USD leg gets a day
    // of maxAge here (production: 3600); staleness is covered in reward-forwarder-v2.js
    await (await g.setPriceFeed(WETH, ETH_USD_FEED, FEED_MAX_AGE)).wait();
    await (await g.setPriceFeed(IFARM, iFarmFeed.address, FEED_MAX_AGE)).wait();
    await (await g.setOracleTolerance(200)).wait();
    // static circuit breaker at 0.75x today's Base price: it binds only if the TWAP itself runs away
    const minRate = (await feedIfarmPerWeth()).mul(75).div(100);
    await (await g.setSwapLimit(WETH, IFARM, CHUNK, minRate)).wait();
    await (await g.setMinBuyInterval(BUY_INTERVAL)).wait();

    // 0.1 WETH of profit share buffered in V2, paid by a stand-in strategy
    await (await weth.connect(whale).approve(v2.address, ethers.utils.parseEther("0.1"))).wait();
    await (await v2.connect(whale).notifyFee(WETH, ethers.utils.parseEther("0.1"), 0, 0)).wait();
    assert.ok(await controller.hardWorkers(HARD_WORKER));

    snapshotId = await send("evm_snapshot");
  });

  afterEach(async function () {
    await send("evm_revert", [snapshotId]);
    snapshotId = await send("evm_snapshot");
  });

  async function buy() {
    const r = await (await v2.connect(hardWorker).distributeAllFees({ gasLimit: 8_000_000 })).wait();
    return r.logs.filter((l) => l.address === v2.address).map((l) => v2.interface.parseLog(l));
  }

  describe("price", function () {
    it("matches the pools' mid price when the window holds no swaps", async function () {
      const feed = await feedIfarmPerWeth();
      const spot = await spotIfarmPerWeth();
      console.log(`      feed ${ethers.utils.formatEther(feed)} iFARM/WETH, pools' mid ${ethers.utils.formatEther(spot)}`);
      // the TWAP is a whole tick and the quote the exact sqrt price, so they agree within a tick (1 bp) per pool
      assert.ok(Math.abs(ratio(feed, spot) - 1) < 0.0005, `feed ${feed} vs spot ${spot}`);
    });

    it("answers in USD with 18 decimals and the ETH/USD feed's timestamps", async function () {
      const [, ethUsd, , ethUpdated] = await new ethers.Contract(ETH_USD_FEED, FEED_ABI, ethers.provider).latestRoundData();
      const [, answer, , updatedAt] = await iFarmFeed.latestRoundData();
      const expected = (await iFarmFeed.twapQuote()).mul(ethUsd.mul(1e10)).div(WAD);
      assert.ok(answer.eq(expected));
      assert.ok(updatedAt.eq(ethUpdated));
      assert.equal(await iFarmFeed.decimals(), 18);
      assert.equal(await iFarmFeed.description(), "iFARM / USD (Base TWAP)");
      const [, farmUsd] = await farmFeed.latestRoundData();
      console.log(`      iFARM $${Number(ethers.utils.formatEther(answer)).toFixed(4)}, FARM $${Number(ethers.utils.formatEther(farmUsd)).toFixed(4)}`);
      // iFARM is FARM staked, so it must price above FARM
      assert.ok(answer.gt(farmUsd));
    });

    it("puts V2's stage-2 floor at exactly the chunk's TWAP value less 2%", async function () {
      const expected = CHUNK.mul(WAD).div(await iFarmFeed.twapQuote()).mul(9800).div(10000);
      const floor = await v2.floorFor(WETH, IFARM, CHUNK);
      console.log(`      floor ${ethers.utils.formatEther(floor)} iFARM, expected ${ethers.utils.formatEther(expected)}`);
      // the ETH/USD legs cancel; only the 18-decimal truncations differ
      assert.ok(floor.sub(expected).abs().lte(expected.div(1e12).add(2)), `floor ${floor} vs ${expected}`);
    });

    it("floors FARM -> WETH at the FARM TWAP value less 2%", async function () {
      const g = v2.connect(governance);
      await (await g.setPriceFeed(FARM, farmFeed.address, FEED_MAX_AGE)).wait();
      const amount = ethers.utils.parseEther("5");
      await (await g.setSwapLimit(FARM, WETH, amount, 1)).wait();
      const expected = amount.mul(await farmFeed.twapQuote()).div(WAD).mul(9800).div(10000);
      const floor = await v2.floorFor(FARM, WETH, amount);
      assert.ok(floor.sub(expected).abs().lte(expected.div(1e12).add(2)), `floor ${floor} vs ${expected}`);
    });

    it("rejects a pool that does not hold the hop's tokens, a short path and a tiny window", async function () {
      const Feed = await ethers.getContractFactory("UniV3TwapFeed");
      await assert.rejects(Feed.deploy([IFARM, WETH], [FARM_IFARM_POOL], ETH_USD_FEED, WINDOW, "x"), /PathMismatch/);
      await assert.rejects(Feed.deploy([IFARM, FARM, WETH], [FARM_IFARM_POOL], ETH_USD_FEED, WINDOW, "x"), /path length/);
      await assert.rejects(Feed.deploy([FARM, WETH], [WETH_FARM_POOL], ETH_USD_FEED, 60, "x"), /window/);
    });
  });

  describe("tick math, on a pool that reports any tick", function () {
    let pool, feed;
    beforeEach(async function () {
      pool = await (await ethers.getContractFactory("MockObservePool")).deploy(WETH, FARM);
      // WETH is token0 here, so the quote of one WETH is FARM per WETH = 1.0001^tick
      feed = await (await ethers.getContractFactory("UniV3TwapFeed")).deploy([WETH, FARM], [pool.address], ETH_USD_FEED, WINDOW, "test");
    });
    const at = async (tick) => {
      await (await pool.setDelta(tick * WINDOW)).wait();
      return feed.twapQuote();
    };

    it("prices 1.0001^tick on both sides of the sqrt-ratio 2^128 branch", async function () {
      for (const tick of [-200000, 57993, 440000, 450000]) {
        const q = Number(ethers.utils.formatEther(await at(tick)));
        const want = Math.pow(1.0001, tick);
        assert.ok(Math.abs(q / want - 1) < 1e-9, `tick ${tick}: ${q} vs ${want}`);
      }
      // the two branches join: 10,000 ticks apart is a factor 1.0001^10000
      const r = Number((await at(450000)).mul(1e9).div(await at(440000))) / 1e9;
      assert.ok(Math.abs(r / Math.pow(1.0001, 10000) - 1) < 1e-8);
    });

    it("rounds a negative mean tick towards negative infinity, like Uniswap's OracleLibrary", async function () {
      await (await pool.setDelta(-6 * WINDOW)).wait();
      const minus6 = await feed.twapQuote();
      await (await pool.setDelta(-5 * WINDOW - 1)).wait(); // mean -5.0006 -> -6
      assert.ok((await feed.twapQuote()).eq(minus6));
      await (await pool.setDelta(5 * WINDOW + 1)).wait(); // mean 5.0006 -> 5
      assert.ok((await feed.twapQuote()).eq(await at(5)));
    });

    it("reverts an absurd price instead of letting V2's floor arithmetic overflow", async function () {
      // pricing FARM: FARM is token1, so a very negative tick makes FARM worth 2^128 WETH
      const farmPool = await (await ethers.getContractFactory("MockObservePool")).deploy(WETH, FARM);
      const farmUsd = await (await ethers.getContractFactory("UniV3TwapFeed")).deploy([FARM, WETH], [farmPool.address], ETH_USD_FEED, WINDOW, "FARM / USD (test)");
      await (await farmPool.setDelta(57993 * WINDOW)).wait(); // about today's 330 FARM per WETH
      const g = v2.connect(governance);
      await (await g.setPriceFeed(FARM, farmUsd.address, FEED_MAX_AGE)).wait();
      await (await g.setSwapLimit(FARM, WETH, ethers.utils.parseEther("5"), 1)).wait();
      assert.ok((await v2.floorFor(FARM, WETH, ethers.utils.parseEther("5"))).gt(0));
      await (await farmPool.setDelta(-887000 * WINDOW)).wait();
      await assert.rejects(farmUsd.latestRoundData(), /price/);
      // V2 treats the reverting feed as no price: floor 0 (skip), not a reverting run
      assert.ok((await v2.floorFor(FARM, WETH, ethers.utils.parseEther("5"))).isZero());
    });
  });

  describe("buying iFARM at the Base market price", function () {
    it("buys a chunk within the 2% tolerance of the TWAP", async function () {
      const fair = await feedIfarmPerWeth();
      const ev = await buy();
      const bought = ev.find((e) => e.name === "ProfitShareBought");
      assert.ok(bought, `no buy: ${ev.map((e) => e.name)}`);
      const rate = bought.args.amountOut.mul(WAD).div(bought.args.hubIn);
      console.log(`      ${ethers.utils.formatEther(bought.args.hubIn)} WETH -> ${ethers.utils.formatEther(bought.args.amountOut)} iFARM: ${ratio(rate, fair).toFixed(4)} x TWAP`);
      assert.ok(ratio(rate, fair) >= 0.98);
    });

    it("refuses a buy right after someone pushes the price, once the pools keep history", async function () {
      for (const p of [WETH_FARM_POOL, FARM_IFARM_POOL]) await (await new ethers.Contract(p, POOL_ABI, hardWorker).increaseObservationCardinalityNext(50)).wait();
      const before = await feedIfarmPerWeth();
      await pushPrice(ethers.utils.parseEther("0.06")); // about 8% on the iFARM price
      const spot = await spotIfarmPerWeth();
      const after = await feedIfarmPerWeth();
      console.log(`      spot moved to ${ratio(spot, before).toFixed(3)} x; TWAP moved to ${ratio(after, before).toFixed(4)} x`);
      assert.ok(ratio(after, before) > 0.995, "a push in the same window barely moves the TWAP");
      const ev = await buy();
      assert.ok(!ev.some((e) => e.name === "ProfitShareBought"), "bought at the pushed price");
      assert.ok(ev.some((e) => e.name === "SwapFailed"));
      assert.ok((await v2.pendingProfitShare(WETH)).eq(ethers.utils.parseEther("0.1")), "the chunk stays buffered");
    });

    it("skips (no price) right after a swap while the pools keep a single observation", async function () {
      await pushPrice(ethers.utils.parseEther("0.001"));
      await assert.rejects(iFarmFeed.latestRoundData());
      assert.ok((await v2.floorFor(WETH, IFARM, CHUNK)).isZero());
      const ev = await buy();
      assert.ok(ev.some((e) => e.name === "SwapSkipped"));
      assert.ok(!ev.some((e) => e.name === "ProfitShareBought"));
      // and V2 would refuse such a feed at configuration time
      await assert.rejects(v2.connect(governance).setPriceFeed(IFARM, iFarmFeed.address, FEED_MAX_AGE), /BadFeed/);
    });

    it("prices again through a fresh swap once cardinality is raised", async function () {
      for (const p of [WETH_FARM_POOL, FARM_IFARM_POOL]) await (await new ethers.Contract(p, POOL_ABI, hardWorker).increaseObservationCardinalityNext(50)).wait();
      await pushPrice(ethers.utils.parseEther("0.001")); // writes the first new observation; the old one stays
      await iFarmFeed.latestRoundData(); // no revert: the window still starts at an older observation
      await pushPrice(ethers.utils.parseEther("0.001"));
      await iFarmFeed.latestRoundData();
      assert.ok((await v2.floorFor(WETH, IFARM, CHUNK)).gt(0));
    });

    it("follows a price held for the whole window, until the circuit breaker", async function () {
      for (const p of [WETH_FARM_POOL, FARM_IFARM_POOL]) await (await new ethers.Contract(p, POOL_ABI, hardWorker).increaseObservationCardinalityNext(50)).wait();
      const start = await feedIfarmPerWeth();
      // a modest move held for the window: the TWAP follows and V2 buys at the new Base price
      await pushPrice(ethers.utils.parseEther("0.04"));
      await warp(WINDOW + 1);
      let ev = await buy();
      assert.ok(ev.some((e) => e.name === "ProfitShareBought"), `no buy after a held move: ${ev.map((e) => e.name)}`);
      // a large move held for the window: the TWAP follows, but the static floor (0.75x) stops the buy
      await pushPrice(ethers.utils.parseEther("0.5"));
      await warp(WINDOW + 1);
      const held = await feedIfarmPerWeth();
      console.log(`      price held at ${ratio(held, start).toFixed(3)} x the start for the window`);
      assert.ok(ratio(held, start) < 0.75);
      const pending = await v2.pendingProfitShare(WETH);
      ev = await buy();
      assert.ok(!ev.some((e) => e.name === "ProfitShareBought"), "bought past the circuit breaker");
      assert.ok((await v2.pendingProfitShare(WETH)).eq(pending));
    });

    it("keeps buying chunk by chunk as the price moves with our own buys", async function () {
      for (const p of [WETH_FARM_POOL, FARM_IFARM_POOL]) await (await new ethers.Contract(p, POOL_ABI, hardWorker).increaseObservationCardinalityNext(50)).wait();
      const start = await feedIfarmPerWeth();
      const erc = (t) => new ethers.Contract(t, WETH_ABI, ethers.provider);
      const held = {};
      for (const who of [ROUTER, v2.address]) for (const t of [FARM, IFARM]) held[who + t] = await erc(t).balanceOf(who);
      const rates = [];
      for (let i = 0; i < 6; i++) {
        const ev = await buy();
        const b = ev.find((e) => e.name === "ProfitShareBought");
        if (!b) break;
        rates.push(ratio(b.args.amountOut.mul(WAD).div(b.args.hubIn), start).toFixed(3));
        await warp(BUY_INTERVAL + 1);
      }
      console.log(`      chunks at ${rates.join(", ")} x the starting price`);
      assert.ok(rates.length >= 5, `only ${rates.length} chunks`);
      // nothing left behind in the router or in V2
      for (const who of [ROUTER, v2.address]) for (const t of [FARM, IFARM]) assert.ok((await erc(t).balanceOf(who)).eq(held[who + t]), `${who} kept ${t}`);
    });
  });
});
