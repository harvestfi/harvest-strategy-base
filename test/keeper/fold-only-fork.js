// Fold-only KeeperChecker fork test (Phase 1 of aave-fold-execution-plan.md): a FRESH KeeperChecker
// with only the Aave fold strategy registered, driven the way the bot drives it.
//
//   export ALCHEMEY_KEY=...            # Base RPC key
//   export MNEMONIC="..."              # accounts[0] = ULOwner (only used to sign the route fix-up)
//   FOLD_ONLY_FORK_BLOCK=<block> npx hardhat test test/keeper/fold-only-fork.js
//
// Do NOT leave .env's FORK_BLOCK (50490707) in the environment: hardhat boots a fork from it before
// `before()` resets, and that block predates the fold strategy's current state. Without
// FOLD_ONLY_FORK_BLOCK the test forks at (latest block - 5) read from the live provider.
//
// Forks ONCE in before() (one hardhat_reset), then evm_snapshot/evm_revert per test. ethers only (no
// truffle), so there are no confirmation pollers.
//
// ROUTE FIX-UP: until mainnet is re-routed, WETH<>cbETH still points at the drained legacy pool and
// a fold deleverage cannot sell cbETH. If either getPath(WETH, cbETH)[0].dex or getPath(cbETH, WETH)[0].dex
// is not the new Aero Slipstream adapter, before() impersonates the ULOwner and re-points both
// directions (a no-op once mainnet is fixed).
const { ethers, network } = require("hardhat");
const assert = require("assert");
const { ethers: rawEthers } = require("ethers");
const { buildWire } = require("../../scripts/keeper/build-migration-batch.js");

const RPC = `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`;

const STORE = "0x98E03c6Ed7374F1e58FF022f1D2D8239526E13F9"; // governance = msig, controller = CONTROLLER
const CONTROLLER = "0xF90FF0F7c8Db52bF1bF869F74226eAD125EFa745";
const MSIG = "0x920b1aCb7618B553324aa0F71620226FA2e09870";
const KEEPER_BOT = "0xE262C1e7c5177E28E51A5cf1C6944470697B2c9F";
const FOLD = "0xcfd2f32E6d533653cEd5Ba7E5fe1a76C3c626757";
const FOLD_VAULT = "0xE78285A51f51916F2311B7017Db036D8351F3Cf9";

const ULOWNER = "0x6a74649aCFD7822ae8Fb78463a9f2192752E5Aa2";
const UL_REGISTRY = "0x07d212988ECDf8d2c2Ab448114685CE5fDf07a4C";
const AERO_ADAPTER = "0x847EDdC78Dc6F3b046427eb1e5878E9df3223267";
const AERO_ID = rawEthers.utils.id("aeroSlipstream"); // 0x6ac70dc6...
const WETH = "0x4200000000000000000000000000000000000006";
const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
const NEW_POOL = "0x03bf20662F76312aEc31EF28d4a024E1ECa108Af"; // Aero CL, cbETH token0, WETH token1

const KIND = { NONE: 0, CL_REBALANCE: 1, HARD_WORK: 2 };
const STATUS = ["ELIGIBLE", "NOT_REGISTERED", "BACKED_OFF", "CHECKER_FAILED", "NOT_NEEDED", "BAD_PAYLOAD", "STALE_STRATEGY"];
const PERFORM_GAS = 10_000_000;
const ENTRY_GAS_CAP = 4_500_000; // KeeperChecker.callGasLimit[HARD_WORK]

const REGISTRY_ABI = [
  "function getPath(address,address) view returns (tuple(address dex, address[] paths)[])",
  "function setPath(bytes32,address[])",
  "function dexesInfo(bytes32) view returns (address)",
  "function addDex(bytes32,address)",
];
const ADAPTER_ABI = ["function setTickSpacing(address,address,int24)"];
const POOL_ABI = ["event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"];
const FOLD_ABI = [
  "function checker() view returns (bool, bytes)",
  "function borrowTargetFactorNumerator() view returns (uint256)",
  "function setBorrowTargetFactorNumerator(uint256)",
];
const CONTROLLER_ABI = [
  "function addHardWorker(address)",
  "function hardWorkers(address) view returns (bool)",
  "event SharePriceChangeLog(address indexed vault, address indexed strategy, uint256 oldSharePrice, uint256 newSharePrice, uint256 timestamp)",
];

const sel = (sig) => ethers.utils.id(sig).slice(0, 10);

async function expectCustomError(promise, sig) {
  const want = sel(sig);
  try {
    await promise;
  } catch (e) {
    const blob = [e.data, e.error && e.error.data, e.errorSignature, e.message].filter(Boolean).map(String).join(" ");
    const name = sig.split("(")[0];
    assert(blob.includes(want) || blob.includes(`'${name}(`) || blob.includes(`custom error '${name}`),
      `expected ${sig} (${want}), got: ${blob.slice(0, 400)}`);
    return;
  }
  assert.fail(`expected revert ${sig}, but the call succeeded`);
}

async function impersonate(addr) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}

function eventsOf(receipt, contract, name) {
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === contract.address.toLowerCase())
    .map((l) => { try { return contract.interface.parseLog(l); } catch (e) { return null; } })
    .filter((l) => l && l.name === name);
}

describe("KeeperChecker, fold strategy only (Base fork)", function () {
  this.timeout(900_000);

  let msig, keeperBot, stranger, deployer;
  let controller, fold, checker;
  let snap;

  // Re-points WETH<>cbETH at the new Aero Slipstream pool when mainnet still uses the drained one.
  async function routeFixUp() {
    const registry = new ethers.Contract(UL_REGISTRY, REGISTRY_ABI, ethers.provider);
    const dexOf = async (a, b) => {
      try { return (await registry.getPath(a, b))[0].dex; } catch (e) { return ethers.constants.AddressZero; } // no route at all: fix it too
    };
    const fwd = await dexOf(WETH, CBETH);
    const back = await dexOf(CBETH, WETH);
    const isAero = (d) => d.toLowerCase() === AERO_ADAPTER.toLowerCase();
    if (isAero(fwd) && isAero(back)) {
      console.log("      route already on aeroSlipstream (no fix-up)");
      return;
    }
    console.log(`      route: WETH>cbETH on ${fwd}, cbETH>WETH on ${back}; applying the ULOwner fix-up`);
    const owner = await impersonate(ULOWNER);
    const reg = registry.connect(owner);
    if ((await reg.dexesInfo(AERO_ID)) === ethers.constants.AddressZero) await (await reg.addDex(AERO_ID, AERO_ADAPTER)).wait();
    await (await new ethers.Contract(AERO_ADAPTER, ADAPTER_ABI, owner).setTickSpacing(WETH, CBETH, 1)).wait(); // 0x8a190657
    await (await reg.setPath(AERO_ID, [WETH, CBETH])).wait();
    await (await reg.setPath(AERO_ID, [CBETH, WETH])).wait();
    for (const [a, b] of [[WETH, CBETH], [CBETH, WETH]]) {
      const got = (await registry.getPath(a, b))[0].dex;
      assert.strictEqual(got.toLowerCase(), AERO_ADAPTER.toLowerCase(), "route fix-up did not take");
    }
  }

  before(async () => {
    let block = Number(process.env.FOLD_ONLY_FORK_BLOCK || 0);
    if (!block) block = (await new rawEthers.providers.JsonRpcProvider(RPC).getBlockNumber()) - 5;
    console.log(`      forking Base at block ${block} (FOLD_ONLY_FORK_BLOCK ${process.env.FOLD_ONLY_FORK_BLOCK ? "set" : "unset: latest - 5"})`);
    await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: RPC, blockNumber: block } }] });
    // Chain 8453 has no hardfork history at the fork block: mine once so hardhat has a local block.
    // Base's forked base fee sits right at ethers' fee estimate; start from a tiny one (only falls after).
    await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x1"]);
    await network.provider.send("evm_mine");

    [deployer, stranger] = await ethers.getSigners();
    await routeFixUp();

    msig = await impersonate(MSIG);
    keeperBot = await impersonate(KEEPER_BOT);
    controller = new ethers.Contract(CONTROLLER, CONTROLLER_ABI, msig);
    fold = new ethers.Contract(FOLD, FOLD_ABI, msig);

    const KC = await ethers.getContractFactory("KeeperChecker");
    checker = await KC.connect(deployer).deploy(STORE);
    await checker.deployed();
    assert.strictEqual(await checker.governance(), MSIG);
    assert.strictEqual(await checker.controller(), CONTROLLER);

    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
  });

  // The three Phase 1.4 calls, applied directly as the Safe.
  async function wireFoldOnly() {
    await (await controller.addHardWorker(checker.address)).wait();
    await (await checker.connect(msig).addEntries([FOLD], [KIND.HARD_WORK], [0])).wait();
    await (await checker.connect(msig).setKeeper(KEEPER_BOT, true)).wait();
  }

  // A lower leverage target puts health below 99% of target: the checker's deleverage branch.
  async function lowerBorrowTarget() {
    const target = await fold.borrowTargetFactorNumerator();
    await (await fold.setBorrowTargetFactorNumerator(target.mul(95).div(100))).wait();
    assert((await fold.checker())[0], "lowering the borrow target by 5% should make the fold strategy fire");
  }

  async function statusName(t) {
    const [s] = await checker.status(t);
    return STATUS[s];
  }

  it("(a) buildWire encodes exactly addHardWorker, addEntries([fold],[HARD_WORK],[0]), setKeeper (pure)", () => {
    const fake = "0x1111111111111111111111111111111111111111";
    const iface = new ethers.utils.Interface([
      "function addHardWorker(address)",
      "function addEntries(address[],uint8[],uint8[])",
      "function setKeeper(address,bool)",
    ]);
    const entries = [{ target: FOLD, kind: KIND.HARD_WORK, priority: 0 }];
    const wire = buildWire({ checker: fake, keepers: [KEEPER_BOT], entries, alreadyHardWorker: false });
    assert.strictEqual(wire.length, 3);
    assert.deepStrictEqual(wire.map((t) => [t.to, t.value, t.data]), [
      [CONTROLLER, "0", iface.encodeFunctionData("addHardWorker", [fake])],
      [fake, "0", iface.encodeFunctionData("addEntries", [[FOLD], [2], [0]])],
      [fake, "0", iface.encodeFunctionData("setKeeper", [KEEPER_BOT, true])],
    ]);
    // Already a hardWorker: the first call is omitted, nothing else changes.
    const again = buildWire({ checker: fake, keepers: [KEEPER_BOT], entries, alreadyHardWorker: true });
    assert.deepStrictEqual(again.map((t) => t.data), wire.slice(1).map((t) => t.data));
  });

  it("(b) a fresh checker with only the fold entry is quiet while the position is healthy", async () => {
    assert(!(await fold.checker())[0], "premise: the live fold strategy is not asking for a deleverage");
    await wireFoldOnly();
    assert(await controller.hardWorkers(checker.address));
    assert.strictEqual((await checker.targetCount()).toNumber(), 1);
    assert.strictEqual(await checker.targetAt(0), FOLD);
    assert(await checker.isKeeper(KEEPER_BOT));
    assert.strictEqual(await statusName(FOLD), "NOT_NEEDED");
    assert.strictEqual((await checker.checkUpkeep("0x"))[0], false);
  });

  it("(c) a deleverage through the keeper stays inside the per-entry gas cap on the new route", async () => {
    await wireFoldOnly();
    await lowerBorrowTarget();

    assert.strictEqual(await statusName(FOLD), "ELIGIBLE");
    const [up, data] = await checker.checkUpkeep("0x");
    assert.strictEqual(up, true);
    const [targets] = ethers.utils.defaultAbiCoder.decode(["address[]"], data);
    assert.deepStrictEqual(targets, [FOLD]);

    const rc = await (await checker.connect(keeperBot).performUpkeep(data, { gasLimit: PERFORM_GAS })).wait();
    console.log(`      fold deleverage via KeeperChecker (new route) gasUsed=${rc.gasUsed.toString()}`);

    const failed = eventsOf(rc, checker, "UpkeepFailed");
    assert.strictEqual(failed.length, 0, `UpkeepFailed: ${failed.map((e) => e.args.reason).join(",")}`);
    const executed = eventsOf(rc, checker, "UpkeepExecuted");
    assert.strictEqual(executed.length, 1);
    assert.strictEqual(executed[0].args.target, FOLD);
    // The deleverage sold cbETH on the NEW Aero CL pool: cbETH is token0, so a sale has amount0 > 0.
    const swaps = eventsOf(rc, new ethers.Contract(NEW_POOL, POOL_ABI, ethers.provider), "Swap");
    assert(swaps.length >= 1, `expected at least one Swap log from ${NEW_POOL} in the performUpkeep receipt`);
    assert(swaps.some((s) => s.args.amount0.gt(0)), "expected a Swap on the new pool with amount0 > 0 (cbETH sold)");
    // The whole tx is an upper bound for the entry's own gas.
    assert(rc.gasUsed.lt(ENTRY_GAS_CAP), `gasUsed ${rc.gasUsed} should be under the ${ENTRY_GAS_CAP} per-entry cap`);

    // The hard work went through the Controller for the fold vault.
    const logs = eventsOf(rc, controller, "SharePriceChangeLog");
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].args.vault, FOLD_VAULT);
    assert.strictEqual(logs[0].args.strategy, FOLD);

    assert.strictEqual((await checker.checkUpkeep("0x"))[0], false, "quiet after the deleverage");
    assert(!(await fold.checker())[0], "fold strategy deleveraged");
    assert.strictEqual((await checker.entries(FOLD)).failures, 0);
  });

  it("(d) a stranger cannot back an entry off by performing a failing one", async () => {
    await wireFoldOnly();
    await lowerBorrowTarget();
    const MCL = await ethers.getContractFactory("MockKeeperCLVault"); // eligible, rebalance reverts
    const badCL = await MCL.deploy();
    await badCL.deployed();
    await (await checker.connect(msig).addEntry(badCL.address, KIND.CL_REBALANCE, 1)).wait();

    // A lone failing entry does nothing (and reverts cleanly) ...
    const only = ethers.utils.defaultAbiCoder.encode(["address[]"], [[badCL.address]]);
    await expectCustomError(checker.connect(stranger).callStatic.performUpkeep(only, { gasLimit: PERFORM_GAS }), "NotNeeded()");
    // ... next to the real deleverage it fails unrecorded.
    const both = ethers.utils.defaultAbiCoder.encode(["address[]"], [[FOLD, badCL.address]]);
    const rc = await (await checker.connect(stranger).performUpkeep(both, { gasLimit: PERFORM_GAS })).wait();
    assert.deepStrictEqual(eventsOf(rc, checker, "UpkeepExecuted").map((e) => e.args.target), [FOLD]);
    const [f] = eventsOf(rc, checker, "UpkeepFailed");
    assert.strictEqual(f.args.target, badCL.address);
    assert.strictEqual(Number(f.args.backoffUntil), 0, "not recorded");
    assert.strictEqual(await statusName(badCL.address), "ELIGIBLE", "still eligible: no backoff");
    assert.strictEqual((await checker.entries(badCL.address)).failures, 0);
  });
});
