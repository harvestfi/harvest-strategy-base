/**
 * Mint a correctly-sized seed position NFT for a new CLVault.
 *
 * The vault derives `posWidth` from the seed NFT itself:
 *     posWidth = (tickUpper - tickLower) / tickSpacing
 * and `initializeVault` requires `targetWidth <= posWidth`. For the A/B comparison we want
 * posWidth == targetWidth exactly, so the seed range must be EXACTLY width * tickSpacing ticks
 * wide, centred the same way `CLRebalanceHelper.prepareRebalance` centres a rebalance — otherwise
 * the vault's very first rebalance shifts the range and the two vaults stop being comparable.
 *
 * Usage:
 *   CL_POOL=0x…  CL_NPM=0x…  CL_WIDTH=2  CL_AMOUNT0=…  CL_AMOUNT1=…  \
 *     npx hardhat run --network mainnet scripts/17-mint-cl-seed-position.js
 *
 * CL_AMOUNT0/1 are raw token units. Supply generously — leftovers stay in your wallet; the
 * mint consumes only what the range needs at the current price.
 */
const hre = require("hardhat");
const { type2Transaction } = require("./utils.js");

const IPosManager = artifacts.require("INonfungiblePositionManager");
const IPool = artifacts.require("contracts/base/interface/concentrated-liquidity/IPool.sol:IPool");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IERC721 = artifacts.require("IERC721");

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
  const amount0 = need("CL_AMOUNT0");
  const amount1 = need("CL_AMOUNT1");

  const [deployer] = await web3.eth.getAccounts();
  const pool = await IPool.at(poolAddr);
  const npm = await IPosManager.at(npmAddr);

  // token0/token1/tickSpacing come from the pool so they can never disagree with it
  const PoolMeta = new web3.eth.Contract([
    { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
    { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
    { name: "tickSpacing", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "int24" }] },
  ], poolAddr);
  const token0 = await PoolMeta.methods.token0().call();
  const token1 = await PoolMeta.methods.token1().call();
  const tickSpacing = parseInt(await PoolMeta.methods.tickSpacing().call(), 10);

  const slot0 = await pool.slot0();
  const tick = parseInt(slot0[1].toString(), 10);

  // Mirror CLRebalanceHelper.prepareRebalance centring. Solidity truncates toward zero and the
  // helper compensates with its `spotSqrt > tickSqrtPrice` branch, which makes it behave as
  // floor() for both signs — so floor() here is the faithful equivalent.
  const mid = Math.floor(tick / tickSpacing);
  const lowerUnits = width === 1 ? mid : mid - Math.floor(width / 2);
  const tickLower = lowerUnits * tickSpacing;
  const tickUpper = (lowerUnits + width) * tickSpacing;

  console.log(`pool         ${poolAddr}`);
  console.log(`tokens       ${token0} / ${token1}`);
  console.log(`tickSpacing  ${tickSpacing}   current tick ${tick}`);
  console.log(`width        ${width}  ->  range [${tickLower}, ${tickUpper}]  (${width * tickSpacing} ticks, ` +
    `${((Math.pow(1.0001, width * tickSpacing) - 1) * 100).toFixed(3)}%)`);
  if ((tickUpper - tickLower) / tickSpacing !== width) throw new Error("range width mismatch");
  if (tick < tickLower || tick >= tickUpper) console.log("WARNING: current tick is outside the seed range");

  // Optional guard: CL_EXPECT_RANGE="tickLower,tickUpper". The range is derived from the tick at
  // send time, so a price move between planning the amounts and the tx landing silently changes
  // which token the mint needs — near a boundary it can invert almost completely (all token1 on
  // one side, all token0 on the other). When that happens the amounts you sized are wrong and you
  // get a much smaller position than intended, with no error. Set this to abort instead.
  const expect = process.env.CL_EXPECT_RANGE;
  if (expect) {
    const [eL, eU] = expect.split(",").map((x) => parseInt(x.trim(), 10));
    if (eL !== tickLower || eU !== tickUpper) {
      throw new Error(
        `Range moved: expected [${eL}, ${eU}] but the current tick ${tick} gives [${tickLower}, ${tickUpper}]. ` +
        "Re-derive the amounts for the new range before minting."
      );
    }
    console.log(`range guard OK (CL_EXPECT_RANGE=${expect})`);
  }

  await type2Transaction((await IERC20.at(token0)).approve, npmAddr, amount0);
  await type2Transaction((await IERC20.at(token1)).approve, npmAddr, amount1);

  const res = await type2Transaction(npm.mint, {
    token0, token1, tickSpacing, tickLower, tickUpper,
    amount0Desired: amount0, amount1Desired: amount1,
    amount0Min: 0, amount1Min: 0,
    recipient: deployer, deadline: Math.floor(Date.now() / 1000) + 1800,
    sqrtPriceX96: 0,
  });

  const nft = await IERC721.at(npmAddr);
  const evs = await nft.getPastEvents("Transfer", {
    fromBlock: res.blockNumber || res.receipt?.blockNumber, toBlock: "latest",
  });
  const minted = evs
    .filter((e) => e.returnValues.to.toLowerCase() === deployer.toLowerCase() &&
                   e.returnValues.from === "0x0000000000000000000000000000000000000000")
    .map((e) => e.returnValues.tokenId);
  const tokenId = minted[minted.length - 1];

  const pos = await npm.positions(tokenId);
  console.log("=====================================================");
  console.log(`minted tokenId ${tokenId}`);
  console.log(`  ticks [${pos.tickLower}, ${pos.tickUpper}]  liquidity ${pos.liquidity.toString()}`);
  console.log(`  posWidth = ${(parseInt(pos.tickUpper) - parseInt(pos.tickLower)) / tickSpacing}`);
  console.log("=====================================================");
  console.log(`Put this in the deploy config:  "posId": "${tokenId}"`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
