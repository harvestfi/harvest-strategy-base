// KeeperChecker fork tests against live Base state.
//
//   KEEPER_FORK_BLOCK=52896000 npx hardhat test test/keeper/keeper-checker-fork.js
//
// Forks ONCE (one hardhat_reset in `before`), then evm_snapshot/evm_revert per test. Uses ethers
// contracts only (no truffle), so there are no confirmation pollers.
const { ethers, network } = require("hardhat");
const assert = require("assert");

const FORK_BLOCK = Number(process.env.KEEPER_FORK_BLOCK || 52896000);

const STORE = "0x98E03c6Ed7374F1e58FF022f1D2D8239526E13F9"; // governance = msig, controller = CONTROLLER
const CONTROLLER = "0xF90FF0F7c8Db52bF1bF869F74226eAD125EFa745";
const MSIG = "0x920b1aCb7618B553324aa0F71620226FA2e09870"; // Controller, vault and fold-strategy governance
const OPS = "0x6a74649aCFD7822ae8Fb78463a9f2192752E5Aa2"; // CLChainlinkChecker governance
const OLD_CL = "0xaba4ba582E04B729ABCd2Bae0d7c14fe21C9F510";

const FOLD = "0xcfd2f32E6d533653cEd5Ba7E5fe1a76C3c626757"; // Aave fold strategy, CL-checker index 7
const FOLD_VAULT = "0xE78285A51f51916F2311B7017Db036D8351F3Cf9";
const CL_W16 = "0x58bfF80948b11F76066223cdF0B4956c5A584f3a"; // fCL_WETH_cbBTC w16, CL-checker index 4

const SLOT_EXECUTOR = "0x2b03419b0a75317010c2c9c6753d475bd595f74113c0ba88f0af572c718b3fda";
const SLOT_DEVIATION = "0xef14df50012225a4f04edea124bcd8271c46dcca17ab80e5f8f189e352fa097a";
const SLOT_COOLDOWN = "0xd18f22707e82220d6b5763ef48685930876ed861e77af969d83d53007e049af9";

const KIND = { NONE: 0, CL_REBALANCE: 1, HARD_WORK: 2 };
const STATUS = ["ELIGIBLE", "NOT_REGISTERED", "BACKED_OFF", "CHECKER_FAILED", "NOT_NEEDED", "BAD_PAYLOAD", "STALE_STRATEGY"];
const PERFORM_GAS = 25_000_000;

const OLD_CHECKER_ABI = [
  "function vaults(uint256) view returns (address)",
  "function addVault(address)",
  "function addVaults(address[])",
  "function removeVault(address)",
  "function removeVaults(address[])",
  "function checkUpkeep(bytes) view returns (bool, bytes)",
  "function performUpkeep(bytes)",
];
const CL_VAULT_ABI = [
  "function checker() view returns (bool, bytes)",
  "function posId() view returns (uint256)",
  "function rebalanceHelper() view returns (address)",
  "function setRebalanceHelper(address)",
  "function setRebalanceConfig(uint256,uint256,address)",
  "event Rebalanced(uint256 oldPosId, uint256 newPosId, uint256 oldLiquidity, uint256 newLiquidity, uint256 timestamp)",
];
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

/// Asserts that `promise` reverts with exactly the custom error `sig` (e.g. "NotNeeded()").
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

async function slotUint(addr, slot) {
  return ethers.BigNumber.from(await ethers.provider.getStorageAt(addr, slot));
}

function eventsOf(receipt, contract, name) {
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === contract.address.toLowerCase())
    .map((l) => { try { return contract.interface.parseLog(l); } catch (e) { return null; } })
    .filter((l) => l && l.name === name);
}

describe("KeeperChecker (Base fork)", function () {
  this.timeout(900_000);

  let msig, ops, keeper, stranger;
  let controller, fold, clVault, oldCL;
  let checker, forwarder;
  let snap;

  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`, blockNumber: FORK_BLOCK } }],
    });
    // Base's forked base fee sits right at ethers' fee estimate; start from a tiny one (only falls after).
    await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x1"]);
    await network.provider.send("evm_mine");
    [keeper, stranger] = await ethers.getSigners();
    msig = await impersonate(MSIG);
    ops = await impersonate(OPS);

    controller = new ethers.Contract(CONTROLLER, CONTROLLER_ABI, msig);
    fold = new ethers.Contract(FOLD, FOLD_ABI, msig);
    clVault = new ethers.Contract(CL_W16, CL_VAULT_ABI, msig);
    oldCL = new ethers.Contract(OLD_CL, OLD_CHECKER_ABI, ops);

    const KC = await ethers.getContractFactory("KeeperChecker");
    checker = await KC.connect(keeper).deploy(STORE);
    await checker.deployed();
    assert.strictEqual(await checker.governance(), MSIG);
    assert.strictEqual(await checker.controller(), CONTROLLER);

    // Make the CL vault eligible without moving the pool: wrap its helper so shouldRebalance says yes.
    const F = await ethers.getContractFactory("MockRebalanceHelperForwarder");
    forwarder = await F.deploy(await clVault.rebalanceHelper());
    await forwarder.deployed();
    await (await clVault.setRebalanceHelper(forwarder.address)).wait();

    // Make the fold strategy eligible: a lower leverage target puts health below 99% of target,
    // which is the checker's deleverage branch (the one that matters for safety).
    const target = await fold.borrowTargetFactorNumerator();
    await (await fold.setBorrowTargetFactorNumerator(target.mul(95).div(100))).wait();

    const [clCan] = await clVault.checker();
    const [foldCan] = await fold.checker();
    assert(clCan, "CL vault should be eligible");
    assert(foldCan, "fold strategy should be eligible");
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
  });

  // Wires the new checker the way the runbook does: hardWorker on the Controller, executor on the
  // CL vault (deviation and cooldown preserved), keeper registered.
  async function wireNewChecker() {
    await (await controller.addHardWorker(checker.address)).wait();
    const dev = await slotUint(CL_W16, SLOT_DEVIATION);
    const cd = await slotUint(CL_W16, SLOT_COOLDOWN);
    await (await clVault.setRebalanceConfig(dev, cd, checker.address)).wait();
    assert((await slotUint(CL_W16, SLOT_DEVIATION)).eq(dev) && (await slotUint(CL_W16, SLOT_COOLDOWN)).eq(cd));
    await (await checker.connect(msig).setKeeper(keeper.address, true)).wait();
  }

  async function deployMocks() {
    const MCL = await ethers.getContractFactory("MockKeeperCLVault");
    const MV = await ethers.getContractFactory("MockKeeperVault");
    const MS = await ethers.getContractFactory("MockKeeperStrategy");
    const badCL = await MCL.deploy(); // eligible, rebalance reverts
    const badVault = await MV.deploy(); // doHardWork reverts
    const badStrat = await MS.deploy(badVault.address);
    await (await badVault.setStrategy(badStrat.address)).wait();
    return { badCL, badVault, badStrat };
  }

  async function decodeTargets(performData) {
    return ethers.utils.defaultAbiCoder.decode(["address[]"], performData)[0];
  }

  async function statusName(t) {
    const [s] = await checker.status(t);
    return STATUS[s];
  }

  // ------------------------------------------------------------------------------------ RED --

  describe("old checkers wedge (red)", () => {
    it("CLChainlinkChecker: the fold strategy at index 7 starves an eligible CL vault behind it", async () => {
      // Put the eligible CL vault behind the fold strategy, as entries 8-20 already are.
      await (await oldCL.removeVault(CL_W16)).wait();
      await (await oldCL.addVault(CL_W16)).wait();
      assert.strictEqual(await oldCL.vaults(7), FOLD);
      assert.strictEqual(await oldCL.vaults(20), CL_W16);

      const [up, data] = await oldCL.checkUpkeep("0x");
      assert(up);
      const [picked] = ethers.utils.defaultAbiCoder.decode(["address", "bytes"], data);
      assert.strictEqual(picked, FOLD, "old checker surfaces the fold strategy first");
      await expectCustomError(oldCL.connect(keeper).callStatic.performUpkeep(data), "BadSelector()");
      // Every rotation start in [0..7] lands on the fold strategy before the CL vault.
      for (let start = 0; start <= 7; start++) {
        const [, d] = await oldCL.checkUpkeep(ethers.utils.defaultAbiCoder.encode(["uint256"], [start]));
        assert.strictEqual(ethers.utils.defaultAbiCoder.decode(["address", "bytes"], d)[0], FOLD);
      }
      const [stillDue] = await clVault.checker();
      assert(stillDue, "the CL vault is still waiting");
    });

    it("CLChainlinkChecker, interim fix applied: one reverting CL entry still starves the vaults behind it", async () => {
      // The interim fix takes the fold strategy out. A CL entry whose rebalance keeps reverting
      // (V2 stake-ratio payload, paused vault, TWAP guard) wedges the queue the same way.
      const MCL = await ethers.getContractFactory("MockKeeperCLVault");
      const badCL = await MCL.deploy();
      await (await oldCL.removeVault(FOLD)).wait();
      await (await oldCL.removeVault(CL_W16)).wait();
      await (await oldCL.addVaults([badCL.address, CL_W16])).wait();

      const [up, data] = await oldCL.checkUpkeep("0x");
      assert(up);
      const [picked] = ethers.utils.defaultAbiCoder.decode(["address", "bytes"], data);
      assert.strictEqual(picked, badCL.address, "old checker surfaces the broken entry first");
      await expectCustomError(oldCL.connect(keeper).callStatic.performUpkeep(data), "CallFailed(bytes)");
      // A hand-encoded perform for the vault would still work; a keeper that follows checkUpkeep
      // (the bot, CRE) never gets one.
      assert((await clVault.checker())[0], "the CL vault is still waiting");
    });
  });

  // ---------------------------------------------------------------------------------- GREEN --

  describe("KeeperChecker", () => {
    it("executes a CL rebalance and a fold doHardWork, isolating two reverting entries in the same batch", async () => {
      await wireNewChecker();
      const { badCL, badStrat } = await deployMocks();
      // The broken entries share the tiers of the real ones, so a first-eligible scan would hit them.
      await (await checker.connect(msig).addEntries(
        [badStrat.address, badCL.address, CL_W16, FOLD],
        [KIND.HARD_WORK, KIND.CL_REBALANCE, KIND.CL_REBALANCE, KIND.HARD_WORK],
        [0, 1, 1, 0],
      )).wait();
      await (await checker.connect(msig).setMaxPerPerform(4)).wait();

      const [up, data] = await checker.checkUpkeep("0x");
      assert(up);
      const targets = await decodeTargets(data);
      assert.strictEqual(targets.length, 4);
      assert.deepStrictEqual(new Set(targets.slice(0, 2)), new Set([badStrat.address, FOLD]), "safety tier first");
      assert.deepStrictEqual(new Set(targets.slice(2)), new Set([badCL.address, CL_W16]));

      const posBefore = await clVault.posId();
      const rc = await (await checker.connect(keeper).performUpkeep(data, { gasLimit: PERFORM_GAS })).wait();
      console.log(`      perform (2 ok + 2 failing) gasUsed=${rc.gasUsed.toString()}`);

      const executed = eventsOf(rc, checker, "UpkeepExecuted").map((e) => e.args.target);
      const failed = eventsOf(rc, checker, "UpkeepFailed");
      assert.deepStrictEqual(new Set(executed), new Set([FOLD, CL_W16]));
      assert.deepStrictEqual(new Set(failed.map((e) => e.args.target)), new Set([badStrat.address, badCL.address]));
      for (const f of failed) assert(Number(f.args.backoffUntil) > 0 && Number(f.args.failures) === 1);

      // The fold hard work went through the Controller for the right vault, and cleared the condition.
      const logs = eventsOf(rc, controller, "SharePriceChangeLog");
      assert.strictEqual(logs.length, 1);
      assert.strictEqual(logs[0].args.vault, FOLD_VAULT);
      assert.strictEqual(logs[0].args.strategy, FOLD);
      assert(!(await fold.checker())[0], "fold strategy deleveraged");
      // The CL vault really recentred.
      assert(!(await clVault.posId()).eq(posBefore), "CL vault minted a new position");
      assert(rc.logs.some((l) => l.address.toLowerCase() === CL_W16.toLowerCase() &&
        l.topics[0] === clVault.interface.getEventTopic("Rebalanced")));

      // Broken entries are backed off; nothing else is due, so the upkeep goes quiet.
      assert.strictEqual(await statusName(badCL.address), "BACKED_OFF");
      assert.strictEqual(await statusName(badStrat.address), "BACKED_OFF");
      assert(!(await checker.checkUpkeep("0x"))[0]);

      // Backoff is time-based and doubles on the next failure.
      const base = (await checker.backoffBase()).toNumber();
      await network.provider.send("evm_increaseTime", [base + 1]);
      await network.provider.send("evm_mine");
      const [up2, data2] = await checker.checkUpkeep("0x");
      assert(up2);
      assert.deepStrictEqual(new Set(await decodeTargets(data2)), new Set([badCL.address, badStrat.address]));
      const rc2 = await (await checker.connect(keeper).performUpkeep(data2, { gasLimit: PERFORM_GAS })).wait();
      for (const f of eventsOf(rc2, checker, "UpkeepFailed")) {
        assert.strictEqual(Number(f.args.failures), 2);
        const block = await ethers.provider.getBlock(rc2.blockNumber);
        assert.strictEqual(Number(f.args.backoffUntil) - block.timestamp, 2 * base);
      }
    });

    it("with one entry per perform, a broken first entry delays the others by one perform only", async () => {
      await wireNewChecker();
      const { badCL } = await deployMocks();
      await (await checker.connect(msig).addEntries([badCL.address, CL_W16], [KIND.CL_REBALANCE, KIND.CL_REBALANCE], [1, 1])).wait();
      await (await checker.connect(msig).setMaxPerPerform(1)).wait();
      const posBefore = await clVault.posId();
      const ran = [];
      for (let i = 0; i < 4; i++) {
        const [up, data] = await checker.checkUpkeep("0x");
        if (!up) break;
        const rc = await (await checker.connect(keeper).performUpkeep(data, { gasLimit: PERFORM_GAS })).wait();
        ran.push(...eventsOf(rc, checker, "UpkeepExecuted").map((e) => `ok:${e.args.target}`));
        ran.push(...eventsOf(rc, checker, "UpkeepFailed").map((e) => `fail:${e.args.target}`));
      }
      assert(ran.includes(`ok:${CL_W16}`) && ran.includes(`fail:${badCL.address}`), ran.join(","));
      assert(ran.length <= 2, `quiet after both were handled: ${ran.join(",")}`);
      assert(!(await clVault.posId()).eq(posBefore));
    });

    it("scans the safety tier first and respects re-prioritisation", async () => {
      await wireNewChecker();
      await (await checker.connect(msig).addEntries([CL_W16, FOLD], [KIND.CL_REBALANCE, KIND.HARD_WORK], [1, 0])).wait();
      await (await checker.connect(msig).setMaxPerPerform(1)).wait();
      for (let i = 0; i < 3; i++) {
        assert.deepStrictEqual(await decodeTargets((await checker.checkUpkeep("0x"))[1]), [FOLD]);
        await network.provider.send("evm_mine"); // rotation changes with the block; tiers do not
      }
      await (await checker.connect(msig).setPriority(FOLD, 2)).wait();
      assert.deepStrictEqual(await decodeTargets((await checker.checkUpkeep("0x"))[1]), [CL_W16]);
    });

    it("shards by address via checkData", async () => {
      await wireNewChecker();
      await (await checker.connect(msig).addEntries([CL_W16, FOLD], [KIND.CL_REBALANCE, KIND.HARD_WORK], [1, 0])).wait();
      const enc = (s) => ethers.utils.defaultAbiCoder.encode(["uint256", "uint256", "uint256"], [0, 2, s]);
      const shardOf = (a) => ethers.BigNumber.from(a).mod(2).toNumber();
      for (const s of [0, 1]) {
        const [up, data] = await checker.checkUpkeep(enc(s));
        const got = up ? await decodeTargets(data) : [];
        const want = [FOLD, CL_W16].filter((a) => shardOf(a) === s);
        assert.deepStrictEqual(new Set(got), new Set(want));
      }
      await expectCustomError(checker.checkUpkeep(ethers.utils.defaultAbiCoder.encode(["uint256", "uint256", "uint256"], [0, 2, 2])), "BadValue()");
    });

    it("a stranger can perform, but cannot push an entry into backoff", async () => {
      await wireNewChecker();
      const { badCL } = await deployMocks();
      await (await checker.connect(msig).addEntries([badCL.address, FOLD], [KIND.CL_REBALANCE, KIND.HARD_WORK], [1, 0])).wait();
      const only = ethers.utils.defaultAbiCoder.encode(["address[]"], [[badCL.address]]);
      await expectCustomError(checker.connect(stranger).callStatic.performUpkeep(only, { gasLimit: PERFORM_GAS }), "NotNeeded()");
      const both = ethers.utils.defaultAbiCoder.encode(["address[]"], [[badCL.address, FOLD]]);
      const rc = await (await checker.connect(stranger).performUpkeep(both, { gasLimit: PERFORM_GAS })).wait();
      assert.deepStrictEqual(eventsOf(rc, checker, "UpkeepExecuted").map((e) => e.args.target), [FOLD]);
      const [f] = eventsOf(rc, checker, "UpkeepFailed");
      assert.strictEqual(f.args.target, badCL.address);
      assert.strictEqual(Number(f.args.backoffUntil), 0, "not recorded");
      assert.strictEqual(await statusName(badCL.address), "ELIGIBLE");

      await (await checker.connect(msig).setKeepersOnly(true)).wait();
      await expectCustomError(checker.connect(stranger).callStatic.performUpkeep(only), "NotKeeper(address)");
    });

    it("a short-gassed perform skips the entry instead of failing it", async () => {
      await wireNewChecker();
      await (await checker.connect(msig).addEntry(FOLD, KIND.HARD_WORK, 0)).wait();
      const data = (await checker.checkUpkeep("0x"))[1];
      // 3M is below the 4.5M cap: the entry is skipped and nothing is recorded.
      await expectCustomError(checker.connect(keeper).callStatic.performUpkeep(data, { gasLimit: 3_000_000 }), "NotNeeded()");
      assert.strictEqual(await statusName(FOLD), "ELIGIBLE");
      const rc = await (await checker.connect(keeper).performUpkeep(data, { gasLimit: PERFORM_GAS })).wait();
      console.log(`      fold deleverage via KeeperChecker gasUsed=${rc.gasUsed.toString()}`);
      assert.strictEqual(eventsOf(rc, checker, "UpkeepExecuted").length, 1);
    });

    it("rejects selector and subject spoofing", async () => {
      await wireNewChecker();
      const { badCL, badVault, badStrat } = await deployMocks();
      const MS = await ethers.getContractFactory("MockKeeperStrategy");
      const MH = await ethers.getContractFactory("MockKeeperHostile");

      // (1) A strategy registered for its own vault starts asking for a hard work on a REAL vault.
      await (await badVault.setRevertOnHardWork(false)).wait();
      await (await checker.connect(msig).addEntry(badStrat.address, KIND.HARD_WORK, 0)).wait();
      assert.strictEqual((await checker.entries(badStrat.address)).vault, badVault.address);
      await (await badStrat.setSubject(FOLD_VAULT)).wait();
      assert.strictEqual(await statusName(badStrat.address), "BAD_PAYLOAD");
      assert(!(await checker.checkUpkeep("0x"))[0]);
      const forged = ethers.utils.defaultAbiCoder.encode(["address[]"], [[badStrat.address]]);
      await expectCustomError(checker.connect(keeper).callStatic.performUpkeep(forged, { gasLimit: PERFORM_GAS }), "NotNeeded()");

      // (2) A CL entry whose payload is not rebalanceCurrentTick: another selector, a V2
      // rebalanceStakeRatio(), and the fold strategy registered as CL (today's index-7 mistake).
      const iface = new ethers.utils.Interface(["function doHardWork(address)", "function withdraw(uint256)", "function rebalanceStakeRatio()"]);
      await (await badCL.setRevertOnRebalance(false)).wait();
      await (await checker.connect(msig).addEntries([badCL.address, FOLD, CL_W16], [KIND.CL_REBALANCE, KIND.CL_REBALANCE, KIND.CL_REBALANCE], [1, 1, 1])).wait();
      for (const p of [iface.encodeFunctionData("doHardWork", [FOLD_VAULT]), iface.encodeFunctionData("withdraw", [1]), iface.encodeFunctionData("rebalanceStakeRatio")]) {
        await (await badCL.setPayload(p)).wait();
        assert.strictEqual(await statusName(badCL.address), "BAD_PAYLOAD");
      }
      assert.strictEqual(await statusName(FOLD), "BAD_PAYLOAD");
      // Neither blocks the real CL vault.
      await (await checker.connect(msig).setMaxPerPerform(5)).wait();
      const [up, data] = await checker.checkUpkeep("0x");
      assert(up);
      assert.deepStrictEqual(await decodeTargets(data), [CL_W16]);

      // (3) A strategy that is no longer its vault's active strategy.
      await (await badCL.setPayload("0x")).wait();
      await (await badStrat.setSubject(badVault.address)).wait();
      assert.strictEqual(await statusName(badStrat.address), "ELIGIBLE");
      await (await badVault.setStrategy(stranger.address)).wait();
      assert.strictEqual(await statusName(badStrat.address), "STALE_STRATEGY");

      // (4) Registration: a strategy its vault does not point back to; non-governance callers.
      const orphan = await MS.deploy(badVault.address);
      await expectCustomError(checker.connect(msig).addEntry(orphan.address, KIND.HARD_WORK, 0), "StrategyNotActive(address,address)");
      await expectCustomError(checker.connect(msig).addEntry(stranger.address, KIND.CL_REBALANCE, 1), "NotAContract(address)");
      await expectCustomError(checker.connect(msig).addEntry(CL_W16, KIND.CL_REBALANCE, 1), "Duplicate(address)");
      await expectCustomError(checker.connect(msig).addEntry(orphan.address, KIND.CL_REBALANCE, 8), "BadPriority(uint8)");
      try {
        await checker.connect(stranger).callStatic.addEntry(orphan.address, KIND.CL_REBALANCE, 1);
        assert.fail("stranger added an entry");
      } catch (e) { assert(String(e.message).includes("Not governance"), e.message); }

      // A plain vault (no vault() function) registers as its own subject. Regression: the vault()
      // probe reverts with no data, and the strategy() probe after it must not see that stale size.
      const MV = await ethers.getContractFactory("MockKeeperVault");
      const plain = await MV.deploy();
      await (await plain.setStrategy(orphan.address)).wait();
      await (await checker.connect(msig).addEntry(plain.address, KIND.HARD_WORK, 2)).wait();
      assert.strictEqual((await checker.entries(plain.address)).vault, plain.address);

      // (5) Unregistered targets in performData do nothing.
      const unregistered = ethers.utils.defaultAbiCoder.encode(["address[]"], [[orphan.address, FOLD_VAULT]]);
      await expectCustomError(checker.connect(keeper).callStatic.performUpkeep(unregistered, { gasLimit: PERFORM_GAS }), "NotNeeded()");

      // (6) Hostile checkers (return bomb, revert, malformed) never break the scan.
      const hostile = await MH.deploy();
      await (await checker.connect(msig).addEntry(hostile.address, KIND.CL_REBALANCE, 0)).wait();
      for (const [mode, want] of [[0, "BAD_PAYLOAD"], [1, "CHECKER_FAILED"], [2, "CHECKER_FAILED"], [3, "CHECKER_FAILED"]]) {
        await (await hostile.setMode(mode)).wait();
        assert.strictEqual(await statusName(hostile.address), want, `mode ${mode}`);
        const [u, d] = await checker.checkUpkeep("0x");
        assert(u);
        assert.deepStrictEqual(await decodeTargets(d), [CL_W16]);
      }
    });

    it("governance tooling: remove keeps the index consistent, settings are bounded", async () => {
      await wireNewChecker();
      const { badCL, badStrat } = await deployMocks();
      await (await checker.connect(msig).addEntries([badCL.address, CL_W16, FOLD, badStrat.address],
        [KIND.CL_REBALANCE, KIND.CL_REBALANCE, KIND.HARD_WORK, KIND.HARD_WORK], [1, 1, 0, 2])).wait();
      await (await checker.connect(msig).removeEntry(badCL.address)).wait();
      assert.deepStrictEqual(await checker.getTargets(), [badStrat.address, CL_W16, FOLD]);
      await (await checker.connect(msig).removeEntries([FOLD, badStrat.address])).wait();
      assert.deepStrictEqual(await checker.getTargets(), [CL_W16]);
      assert.strictEqual(await statusName(FOLD), "NOT_REGISTERED");
      await expectCustomError(checker.connect(msig).removeEntry(FOLD), "UnknownTarget(address)");
      await expectCustomError(checker.connect(msig).setMaxPerPerform(6), "BadValue()");
      await expectCustomError(checker.connect(msig).setCallGasLimit(KIND.HARD_WORK, 15_000_001), "BadValue()");
      await expectCustomError(checker.connect(msig).setCallGasLimit(KIND.NONE, 1_000_000), "BadKind()");
      await expectCustomError(checker.connect(msig).setBackoff(0, 1), "BadValue()");
      const tooMany = ethers.utils.defaultAbiCoder.encode(["address[]"], [[CL_W16, CL_W16, CL_W16]]);
      await expectCustomError(checker.connect(keeper).callStatic.performUpkeep(tooMany), "TooMany(uint256)");
    });

    it("migration rehearsal: every live CLChainlinkChecker entry, one target, keeper loop until quiet", async () => {
      // Register exactly what CLChainlinkChecker holds (the only checker in use; the hard-work
      // ChainlinkChecker is retired): the fold strategy in the safety tier, the 20 CL vaults next.
      const cl = [];
      for (let i = 0; i < 21; i++) cl.push(await oldCL.vaults(i));
      let more = true;
      try { await oldCL.vaults(21); } catch (e) { more = false; }
      assert(!more, "CLChainlinkChecker holds more than 21 entries - update the rehearsal");
      const folds = [FOLD];
      const clVaults = cl.filter((a) => a !== FOLD);
      assert.strictEqual(clVaults.length, 20);

      // Runbook step 1 + 2: hardWorker, then re-point every CL vault, preserving deviation/cooldown.
      await (await controller.addHardWorker(checker.address)).wait();
      for (const v of clVaults) {
        const c = new ethers.Contract(v, CL_VAULT_ABI, msig);
        const dev = await slotUint(v, SLOT_DEVIATION);
        const cd = await slotUint(v, SLOT_COOLDOWN);
        await (await c.setRebalanceConfig(dev, cd, checker.address)).wait();
        assert.strictEqual(ethers.utils.getAddress("0x" + (await ethers.provider.getStorageAt(v, SLOT_EXECUTOR)).slice(26)), checker.address);
      }
      // Runbook step 3.
      const targets = [...folds, ...clVaults];
      const kinds = [...folds.map(() => KIND.HARD_WORK), ...clVaults.map(() => KIND.CL_REBALANCE)];
      const prios = [...folds.map(() => 0), ...clVaults.map(() => 1)];
      await (await checker.connect(msig).addEntries(targets, kinds, prios)).wait();
      await (await checker.connect(msig).setKeeper(keeper.address, true)).wait();
      assert.strictEqual((await checker.targetCount()).toNumber(), 21);

      for (const t of targets) {
        const [s] = await checker.status(t);
        if (STATUS[s] !== "NOT_NEEDED") console.log(`      status ${t} ${STATUS[s]}`);
      }
      const checkGas = await checker.estimateGas.checkUpkeep("0x");
      console.log(`      checkUpkeep over 21 entries: ~${checkGas.toString()} gas`);

      const ran = [];
      for (let i = 0; i < 10; i++) {
        const [up, data] = await checker.checkUpkeep("0x");
        if (!up) break;
        const rc = await (await checker.connect(keeper).performUpkeep(data, { gasLimit: PERFORM_GAS })).wait();
        const ok = eventsOf(rc, checker, "UpkeepExecuted").map((e) => e.args.target);
        const bad = eventsOf(rc, checker, "UpkeepFailed").map((e) => e.args.target);
        console.log(`      perform ${i}: ok=[${ok}] failed=[${bad}] gasUsed=${rc.gasUsed}`);
        ran.push(...ok, ...bad);
        await network.provider.send("evm_mine");
      }
      // The two eligible safety/rebalance entries from the test setup both ran.
      assert(ran.includes(FOLD) && ran.includes(CL_W16), ran.join(","));
      assert(!(await checker.checkUpkeep("0x"))[0], "quiet after the loop");

      // Runbook step 4: empty the old CL checker (its governance EOA); it has nothing left to scan.
      await (await oldCL.removeVaults(cl)).wait();
      assert(!(await oldCL.checkUpkeep("0x"))[0]);
    });
  });
});
