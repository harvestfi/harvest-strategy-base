/**
 * Mint the SEED PAIR for a CLVaultV2 — two positions on one identical range.
 *
 * V2 holds two NFTs: a staked one in the gauge and an unstaked buffer that absorbs deposits and
 * serves withdrawals. Their ranges must be IDENTICAL — that is the invariant the whole accounting
 * rests on, because it is what makes `stakedLiquidity + bufferLiquidity` a meaningful total. So both
 * are minted here, in one script, against one tick reading, with the range passed explicitly to each
 * mint rather than recomputed. `initializeVault` re-checks this and reverts if they disagree.
 *
 * The split follows targetStakedBps so the vault starts on-target and the first ratio rebalance
 * (which costs a gauge window restart) isn't needed on day one.
 *
 * Usage:
 *   CL_POOL=0x… CL_NPM=0x… CL_WIDTH=60 CL_AMOUNT0=… CL_AMOUNT1=… [CL_TARGET_BPS=8000] \
 *     npx hardhat run --network mainnet scripts/19-mint-cl-seed-v2.js
 *
 * CL_AMOUNT0/1 are raw token units and are the TOTAL across both positions. Supply generously:
 * a mint consumes only what the range needs at the current price and the rest stays in your wallet.
 */
const hre = require("hardhat");
const { type2Transaction } = require("./utils.js");

const IPosManager = artifacts.require("INonfungiblePositionManager");
const IPool = artifacts.require("contracts/base/interface/concentrated-liquidity/IPool.sol:IPool");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IERC721 = artifacts.require("IERC721");

const BN = web3.utils.toBN;
function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function main() {
  if (typeof artifacts === "undefined") throw new Error("run via `npx hardhat run`");
  const poolAddr = need("CL_POOL");
  const npmAddr = need("CL_NPM");
  const width = parseInt(need("CL_WIDTH"), 10);
  const amount0 = BN(need("CL_AMOUNT0"));
  const amount1 = BN(need("CL_AMOUNT1"));
  const targetBps = BN(process.env.CL_TARGET_BPS || "8000");
  if (targetBps.lte(BN(0)) || targetBps.gte(BN(10000))) throw new Error("CL_TARGET_BPS must be in (0, 10000)");

  const [deployer] = await web3.eth.getAccounts();
  const pool = await IPool.at(poolAddr);
  const npm = await IPosManager.at(npmAddr);

  const PoolMeta = new web3.eth.Contract([
    { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
    { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
    { name: "tickSpacing", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "int24" }] },
  ], poolAddr);
  const token0 = await PoolMeta.methods.token0().call();
  const token1 = await PoolMeta.methods.token1().call();
  const tickSpacing = parseInt(await PoolMeta.methods.tickSpacing().call(), 10);

  const tick = parseInt((await pool.slot0())[1].toString(), 10);
  // Identical centring to scripts/17 and to CLRebalanceHelper.prepareRebalance.
  const mid = Math.floor(tick / tickSpacing);
  const lowerUnits = width === 1 ? mid : mid - Math.floor(width / 2);
  const tickLower = lowerUnits * tickSpacing;
  const tickUpper = (lowerUnits + width) * tickSpacing;
  const spanPct = (Math.pow(1.0001, width * tickSpacing) - 1) * 100;

  console.log(`pool          ${poolAddr}`);
  console.log(`tokens        ${token0} / ${token1}`);
  console.log(`tickSpacing   ${tickSpacing}   current tick ${tick}`);
  console.log(`width         ${width} -> [${tickLower}, ${tickUpper}]  (${width * tickSpacing} ticks, ${spanPct.toFixed(2)}% span)`);
  console.log(`split         ${targetBps} bps staked / ${BN(10000).sub(targetBps)} bps buffer`);
  if ((tickUpper - tickLower) / tickSpacing !== width) throw new Error("range width mismatch");
  if (tick < tickLower || tick >= tickUpper) throw new Error("current tick is outside the seed range — refusing to mint");

  // Same guard as scripts/17: the range is derived from the tick at send time, so a price move
  // between sizing the amounts and the tx landing silently changes which token the mint needs.
  const expect = process.env.CL_EXPECT_RANGE;
  if (expect) {
    const [eL, eU] = expect.split(",").map((x) => parseInt(x.trim(), 10));
    if (eL !== tickLower || eU !== tickUpper) {
      throw new Error(`range moved: expected [${eL}, ${eU}] but would mint [${tickLower}, ${tickUpper}] — re-size and retry`);
    }
  }

  const t0 = await IERC20.at(token0);
  const t1 = await IERC20.at(token1);
  const bal0 = BN(await t0.balanceOf(deployer));
  const bal1 = BN(await t1.balanceOf(deployer));
  console.log(`balances      ${bal0.toString()} token0 / ${bal1.toString()} token1`);
  if (bal0.lt(amount0) || bal1.lt(amount1)) throw new Error("deployer balance is short of CL_AMOUNT0/CL_AMOUNT1");

  await type2Transaction(t0.approve, npmAddr, "0", { from: deployer });
  await type2Transaction(t0.approve, npmAddr, amount0.toString(), { from: deployer });
  await type2Transaction(t1.approve, npmAddr, "0", { from: deployer });
  await type2Transaction(t1.approve, npmAddr, amount1.toString(), { from: deployer });

  const nft = await IERC721.at(npmAddr);
  async function mint(label, a0, a1) {
    const deadline = (await web3.eth.getBlock("latest")).timestamp + 1800;
    const rc = await type2Transaction(npm.mint, {
      token0, token1, tickSpacing, tickLower, tickUpper,
      amount0Desired: a0.toString(), amount1Desired: a1.toString(),
      amount0Min: "0", amount1Min: "0", recipient: deployer, deadline, sqrtPriceX96: "0",
    }, { from: deployer });
    // type2Transaction returns an ethers TransactionResponse, not a Truffle result — there is no
    // `.receipt` on it. Fetch the receipt by hash to find the block the mint landed in.
    const receipt = await web3.eth.getTransactionReceipt(rc.hash);
    const evs = await nft.getPastEvents("Transfer", { fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
    const id = evs.filter((e) => e.returnValues.to.toLowerCase() === deployer.toLowerCase())
      .map((e) => e.returnValues.tokenId).pop();
    const pos = await npm.positions(id);
    console.log(`  ${label.padEnd(7)} posId=${id}  liquidity=${pos.liquidity.toString()}  range=[${pos.tickLower},${pos.tickUpper}]`);
    return { id, pos };
  }

  const s0 = amount0.mul(targetBps).div(BN(10000));
  const s1 = amount1.mul(targetBps).div(BN(10000));
  console.log("\nminting seed pair:");
  const staked = await mint("staked", s0, s1);
  const buffer = await mint("buffer", amount0.sub(s0), amount1.sub(s1));

  // Belt and braces: initializeVault enforces this too, but failing here is far cheaper.
  if (staked.pos.tickLower.toString() !== buffer.pos.tickLower.toString() ||
      staked.pos.tickUpper.toString() !== buffer.pos.tickUpper.toString()) {
    throw new Error("seed positions do not share a range — do NOT initialize a vault with these");
  }
  const sl = BN(staked.pos.liquidity.toString());
  const bl = BN(buffer.pos.liquidity.toString());
  if (sl.isZero() || bl.isZero()) throw new Error("a seed position minted zero liquidity — re-size the amounts");
  const bps = sl.mul(BN(10000)).div(sl.add(bl));
  console.log(`\nseed ok: stakedPosId=${staked.id} bufferPosId=${buffer.id}  actual split=${bps.toString()}bps (target ${targetBps})`);
  console.log(`put these in the config as "posId" (staked) and "bufferPosId".`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
