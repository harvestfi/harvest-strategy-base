// Shared constants and helpers for the CL V2 suites on the post-merger Aero V3 CL deployment.
//
// Every CL V2 suite runs against the WETH/cbBTC tickSpacing=10 V3 pool and its gauge. They need a
// post-merger fork block (`.env` pins a pre-merger one), so run them with FORK_BLOCK=53236000.
//
// Units changed in the port: the gauge window is BLOCKS, and so is the vault's window safety. `mine`
// advances blocks at Base's 2s spacing, so it also moves time for the timestamp-based cooldowns.
const NPM = "0x4857DB576eE0e45F10525eC59527BfD10beeC60b";
const POOL = "0xbB5507DaaE822ba89C4dA61BbfDf4b49a1666BAc";
const GAUGE = "0x5b14d6D194E49330647eB4717010aDe1B1B3f8B5";
const GAUGE_FACTORY = "0xf437f62053ACB121665b8fDBfeA8F214FB8E589d";
const LEAF_VOTER = "0x382409fad8503FbCdbB27A4211551fa03e884078";
const PENALTY_ADMIN = "0x42255e3c2d0b71a0b006243148fdf1a71d054ce0";
const EMERGENCY_ADMIN = "0x15Ad691083b3D31Ee0ad8664E606Febd62CD8892";
const AERO = "0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee";
// The AERO/USDC ts200 pool: holds millions of new AERO and is on no route the suites use. A V3
// gauge mints on claim and holds no AERO, so suites that seed reward take it from here.
const AERO_WHALE = "0xD0Acf293547457Fb4fE9eE32CA93e89497626816";
// The killed pre-merger F2 WETH/cbBTC pool. It still holds both tokens and nothing reads its price,
// so it funds fixtures without draining the pool under test.
const WHALE = "0x42d4a22CaD0F5a49681a5715cE994Af73A43B76b";
const WETH = "0x4200000000000000000000000000000000000006";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const HELPER = "0x74a343dECf3b4578B07D0F7b7577aB2f3c4762b2";
const UL_OWNER = "0x6a74649aCFD7822ae8Fb78463a9f2192752E5Aa2";
const UL_REGISTRY = "0x07d212988ECDf8d2c2Ab448114685CE5fDf07a4C";
// The UL's registered dex for the post-merger Slipstream SwapRouter (factory 0x9CB22058).
const SLIPSTREAM_DEX = "0x847EDdC78Dc6F3b046427eb1e5878E9df3223267";
const TS = 10;
// The 150-block window the V3 xStock gauges carry today: long enough to land several txs inside it.
const WINDOW = 150;

const GAUGE_ABI = [
  { name: "depositBlock", type: "function", stateMutability: "view", inputs: [{ name: "t", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "earned", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }, { name: "t", type: "uint256[]" }], outputs: [{ name: "", type: "uint256" }] },
];
const FACTORY_ABI = [
  { name: "setMinStakeBlocks", type: "function", stateMutability: "nonpayable", inputs: [{ name: "g", type: "address" }, { name: "v", type: "uint256" }], outputs: [] },
];
const REGISTRY_ABI = [
  { name: "setPath", type: "function", stateMutability: "nonpayable", inputs: [{ name: "d", type: "bytes32" }, { name: "p", type: "address[]" }], outputs: [] },
];
const DEX_ABI = [
  { name: "setTickSpacing", type: "function", stateMutability: "nonpayable", inputs: [{ name: "a", type: "address" }, { name: "b", type: "address" }, { name: "s", type: "int24" }], outputs: [] },
];

function disableConfirmationListeners(...classes) {
  for (const C of classes) C.disableConfirmationListener = true;
}

async function fund(...accounts) {
  for (const a of accounts) {
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [a] });
    await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x21E19E0C9BAB2400000"] });
  }
}

async function mine(blocks) {
  if (blocks <= 0) return;
  await hre.network.provider.send("hardhat_mine", ["0x" + Math.ceil(blocks).toString(16), "0x2"]);
}

async function setWindow(blocks) {
  await fund(PENALTY_ADMIN);
  await new web3.eth.Contract(FACTORY_ABI, GAUGE_FACTORY).methods.setMinStakeBlocks(GAUGE, blocks)
    .send({ from: PENALTY_ADMIN, gas: 300000 });
}

// Register the routes the strategy needs on the live UL, as the ULOwner would before a launch:
// new AERO -> WETH on the AERO/WETH ts200 pool, and WETH <-> cbBTC on the ts1 pool so the fold's
// planner swap never trades against the pool under test.
async function registerAeroV3Routes() {
  await fund(UL_OWNER);
  const dex = new web3.eth.Contract(DEX_ABI, SLIPSTREAM_DEX);
  const reg = new web3.eth.Contract(REGISTRY_ABI, UL_REGISTRY);
  const name = web3.utils.keccak256("aeroSlipstream");
  await dex.methods.setTickSpacing(AERO, WETH, 200).send({ from: UL_OWNER, gas: 200000 });
  await dex.methods.setTickSpacing(WETH, CBBTC, 1).send({ from: UL_OWNER, gas: 200000 });
  for (const p of [[AERO, WETH], [WETH, CBBTC], [CBBTC, WETH]]) {
    await reg.methods.setPath(name, p).send({ from: UL_OWNER, gas: 500000 });
  }
}

// Write a cbBTC balance straight into storage (FiatToken layout: balances at slot 9, found by state
// override). The V3 pool is ~30x deeper than F2 was, so pushing it across a range takes far more
// cbBTC than any holder can spare, and pulling it from the pool under test would leave that pool
// short of the reserves its own swaps pay out of.
async function dealCbBTC(to, amount) {
  const key = web3.utils.keccak256(web3.eth.abi.encodeParameters(["address", "uint256"], [to, 9]));
  const value = "0x" + web3.utils.toBN(amount).toString(16).padStart(64, "0");
  await hre.network.provider.send("hardhat_setStorageAt", [CBBTC, key, value]);
}

// Point the UL's WETH <-> cbBTC hop at a different tick spacing (ts10 = the pool under test).
async function setWethCbbtcRouteSpacing(spacing) {
  await fund(UL_OWNER);
  await new web3.eth.Contract(DEX_ABI, SLIPSTREAM_DEX).methods.setTickSpacing(WETH, CBBTC, spacing)
    .send({ from: UL_OWNER, gas: 200000 });
}

function gauge() {
  return new web3.eth.Contract(GAUGE_ABI, GAUGE);
}

module.exports = {
  NPM, POOL, GAUGE, GAUGE_FACTORY, LEAF_VOTER, PENALTY_ADMIN, EMERGENCY_ADMIN, AERO, AERO_WHALE, WHALE, WETH, CBBTC,
  HELPER, UL_OWNER, UL_REGISTRY, SLIPSTREAM_DEX, TS, WINDOW,
  GAUGE_ABI, FACTORY_ABI, disableConfirmationListeners, fund, mine, setWindow, registerAeroV3Routes, setWethCbbtcRouteSpacing, dealCbBTC, gauge,
};
