// Rehearsal of the STRATEGY-ONLY governance upgrade of the live fold deployment (Phase 2 of
// aave-fold-execution-plan.md). The vault proxy is NOT upgraded: dev's FoldVaultV2 is
// byte-identical to the live impl 0x4942b35f, so there is nothing to schedule on it, and
// the preview lens never ships.
//
// Forks Base at REHEARSAL_BLOCK (default: the live chain head minus 5 blocks), deploys the
// new AaveReserveLib and strategy impl from this tree, and then sends the transactions of
// plan.strategyOnlyPlan() in scripts/fold-upgrade-plan.js (the same calldata scripts/16
// writes as Transaction Builder files with STRATEGY_ONLY=1) through the REAL Safe 0x920b1a:
// execTransaction with two owners' approved hashes, MultiSendCallOnly 1.4.1 as a
// delegatecall for the batch. No setStorageAt, no impersonated shortcut for the upgrade
// itself (setStorageAt only appears in side checks run inside a snapshot: the EXPECTED_PPFS
// claim and the stale-library brick).
//
//   Safe tx 1: strategy.scheduleUpgrade(newStrat)                     (one plain call)
//   (12h)
//   Safe tx 2: strategy.preInteract() + StrategyProxy.upgrade()     (one batch)
//   Rollback:  strategy.scheduleUpgrade(live impl), 12h, the same Safe tx 2
//
// Also checked against the upgraded state: the impl-slot override that runbook step 2.4
// prints as EXPECTED_PPFS equals the post-tx-2 share price to the wei (same timestamp), and
// a fresh KeeperChecker (wired as the impersonated Safe, as Phase 1.4 does) reads the new
// impl's checker() within its checkGasLimit and runs a Morpho deleverage through the new pool.
//
// Route: the strategy swaps WETH<->cbETH through the UL. Mainnet is on the aeroSlipstream
// adapter (new Aero CL pool 0x03bf2066, tickSpacing 1) since the Phase 0 setPath txs at
// blocks 53112297 / 53112300. With REHEARSAL_BLOCK set (the runbook's prerequisite run) or
// REQUIRE_LIVE_ROUTE=1 the test FAILS if the fork block is not on that route: the plan needs
// the live route, not a patched one. Otherwise (chain head by default, which is after Phase 0)
// an older fork is patched as the ULOwner EOA, exactly as Phase 0 did, with a loud warning.
// The summary line prints the fork block and whether the route was already live.
//
// Continuity inside a transaction is measured by running the same batch with calls to a
// read-only FoldUpgradeRecorder interleaved, from the same snapshot and block timestamp,
// and then checking that the exact runbook batch leaves the same storage behind.
//
// What the preInteract bundle does and does not buy (measured here): it makes upgrade()
// itself neutral to the wei, and it books the fee on a pending gain that finalizeUpgrade()
// would otherwise forgive. It does NOT avoid the block-level share-price move: the old
// impl reports a cached balance, and the carry accrued since the last interaction lands in
// Safe tx 2 with or without the bundle (bundled: in preInteract, unbundled: in upgrade()).
//
//   npx hardhat test test/aave/fold/upgrade-rehearsal-fork.js                      (chain head - 5)
//   REHEARSAL_BLOCK=<block after Phase 0> npx hardhat test test/aave/fold/upgrade-rehearsal-fork.js
//   REQUIRE_LIVE_ROUTE=1 npx hardhat test test/aave/fold/upgrade-rehearsal-fork.js  (head, no patching)
//
// Needs ALCHEMEY_KEY (fork + chain head). ethers-only on purpose: truffle's confirmation
// pollers are what deadlocked the in-process node in the 2026-10-05 crash.

const { assert } = require("chai");
const { ethers } = hre;
const plan = require("../../../scripts/fold-upgrade-plan.js");

const { STRATEGY_PROXY: STRAT, VAULT_PROXY: VAULT, SAFE, CONTROLLER, UL_OWNER,
  SPECTRA_PT, STALE_LIB, LIB_FQN, STRATEGY_NAME } = plan;
const LIVE_RPC = `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`;
const WETH = "0x4200000000000000000000000000000000000006";
const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
// New Aero CL pool cbETH(token0)/WETH(token1), tickSpacing 1: where the liquidity went after
// the 10-21 merger. Same Swap event layout as the legacy Slipstream pool.
const CLPOOL = "0x03bf20662F76312aEc31EF28d4a024E1ECa108Af";
const UL_REGISTRY = "0x07d212988ECDf8d2c2Ab448114685CE5fDf07a4C";
const AERO_DEX = "0x847EDdC78Dc6F3b046427eb1e5878E9df3223267"; // aeroSlipstream adapter, owned by the ULOwner
const AERO_DEX_ID = ethers.utils.id("aeroSlipstream");
const CBETH_ATOKEN = "0xcf3D55c10DB69f28fD1A75Bd73f3D8A2d9c595ad"; // holds the Aave cbETH reserve: a deep cbETH source
const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const USER = "0x00000000000000000000000000000000C0FFEE01";
const ZERO = ethers.constants.AddressZero;
const ONE = ethers.utils.parseEther("1");

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function deposit() payable",
];
const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function approveHash(bytes32)",
  "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)",
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)",
];
// Only what the live vault impl (0x4942b35f == dev's FoldVaultV2) has: no min-out
// overloads, no preview lens.
const VAULT_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function getPricePerFullShare() view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function depositCap() view returns (uint256)",
  "function implementation() view returns (address)",
  "function nextImplementation() view returns (address)",
  "function nextImplementationTimestamp() view returns (uint256)",
  "function deposit(uint256) returns (uint256)",
  "function deposit(uint256,address) returns (uint256)",
  "function withdraw(uint256) returns (uint256)",
  "function redeem(uint256,address,address) returns (uint256)",
  "event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares)",
];
// The vault's zero-arg getters (FoldVaultV2's ABI, written out because nothing deploys or
// reads that artifact any more), plus the proxy's implementation(). Compared before/after.
const VAULT_GETTERS = new ethers.utils.Interface([
  "function TEN() view returns (uint256)",
  "function asset() view returns (address)",
  "function compoundOnWithdraw() view returns (bool)",
  "function controller() view returns (address)",
  "function decimals() view returns (uint8)",
  "function depositCap() view returns (uint256)",
  "function governance() view returns (address)",
  "function implementation() view returns (address)",
  "function investOnDeposit() view returns (bool)",
  "function name() view returns (string)",
  "function nextImplementation() view returns (address)",
  "function nextImplementationDelay() view returns (uint256)",
  "function nextImplementationTimestamp() view returns (uint256)",
  "function nextStrategy() view returns (address)",
  "function nextStrategyTimestamp() view returns (uint256)",
  "function strategy() view returns (address)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function underlying() view returns (address)",
  "function underlyingBalanceInVault() view returns (uint256)",
  "function underlyingUnit() view returns (uint256)",
  "function vaultFractionToInvestDenominator() view returns (uint256)",
  "function vaultFractionToInvestNumerator() view returns (uint256)",
]);
const STRAT_ABI = [
  "function implementation() view returns (address)",
  "function nextImplementation() view returns (address)",
  "function nextImplementationTimestamp() view returns (uint256)",
  "function nextImplementationDelay() view returns (uint256)",
  "function storedBalance() view returns (uint256)",
  "function pendingFee() view returns (uint256)",
  "function universalLiquidator() view returns (address)",
  "function leverFlashPremiumBps() view returns (uint256)",
  "function deleverFlashPremiumBps() view returns (uint256)",
  "function feeFloor() view returns (uint256)",
  "function upgrade()",
];
const REGISTRY_ABI = [
  "function getPath(address,address) view returns (tuple(address dex, address[] paths)[])",
  "function setPath(bytes32,address[])",
];
const DEX_ABI = ["function setTickSpacing(address,address,int24)"]; // 0x8a190657, onlyOwner
const PT_ABI = ["function getIBTRate() view returns (uint256)"];
// Decoder for the Transaction Builder files: every call the strategy-only plan may contain,
// plus multiSend so a pre-encoded batch would be recognised (and refused).
const CALLS = new ethers.utils.Interface([
  "function scheduleUpgrade(address)",
  "function preInteract()",
  "function upgrade()",
  "function multiSend(bytes)",
]);
// KeeperChecker wiring (Phase 1.4) and its view of the upgraded strategy.
const KEEPER_STORAGE = "0x98E03c6Ed7374F1e58FF022f1D2D8239526E13F9"; // governance = SAFE, controller = CONTROLLER
const KEEPER_BOT = "0xE262C1e7c5177E28E51A5cf1C6944470697B2c9F";
const KIND_HARD_WORK = 2;
const KEEPER_STATUS = ["ELIGIBLE", "NOT_REGISTERED", "BACKED_OFF", "CHECKER_FAILED", "NOT_NEEDED", "BAD_PAYLOAD", "STALE_STRATEGY"];
const KEEPER_PERFORM_GAS = 10_000_000;
const KEEPER_ENTRY_GAS_CAP = 4_500_000; // KeeperChecker.callGasLimit[HARD_WORK]
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
const EIP170 = 24576; // max runtime code size on Base
const SWAP_TOPIC = ethers.utils.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const SWAP_IFACE = new ethers.utils.Interface(["event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"]);

// Getters that must read the same before and after the upgrade. Everything zero-arg in the
// ABIs, minus values that are live by design (NAV and what derives from it), the upgrade
// schedule (reset by finalizeUpgrade, asserted separately), and the fee/stored balance
// (asserted against the in-batch values instead).
const STRAT_SKIP = new Set(["checker", "investedUnderlyingBalance", "storedBalance", "pendingFee",
  "nextImplementation", "nextImplementationTimestamp", "shouldUpgrade"]);
const VAULT_SKIP = new Set(["assetsPerShare", "availableToInvestOut", "getPricePerFullShare", "totalAssets",
  "underlyingBalanceWithInvestment", "shouldUpgrade"]);

describe(`Aave fold STRATEGY-ONLY upgrade rehearsal through the Safe (fork @${process.env.REHEARSAL_BLOCK || "chain head - 5"})`, function () {
  let safe, vault, strat, recorder, weth, user, lib, newStrat, txs, block;
  let stratArt, libArt, gettersBefore, t0, green, routeLive;

  const send = (m, p = []) => ethers.provider.send(m, p);
  const E = (x) => ethers.utils.formatEther(x);
  const bps = (num, den) => Number(num.mul(10_000_000).div(den)) / 1000;
  const pad32 = (a) => ethers.utils.hexZeroPad(a, 32);
  const same = (a, b) => assert.equal(ethers.utils.getAddress(a), ethers.utils.getAddress(b));
  async function signer(addr) {
    await send("hardhat_impersonateAccount", [addr]);
    await send("hardhat_setBalance", [addr, "0x56BC75E2D63100000000"]);
    return ethers.provider.getSigner(addr);
  }
  async function inSnapshot(fn) {
    const id = await send("evm_snapshot");
    try { return await fn(); } finally { await send("evm_revert", [id]); }
  }
  // Resolves to the revert message, or null if the transaction went through.
  // `p` is a pending transaction, or a function returning a promise of a receipt.
  async function reverts(p) {
    try {
      if (typeof p === "function") await p(); else await (await p).wait();
    } catch (e) { return (e.error && e.error.message) || e.reason || e.message || "reverted"; }
    return null;
  }

  // A recent block by default: the route and the pool depth that matter are today's, and
  // an old pinned block would rehearse against the drained legacy pool.
  async function forkBlock() {
    if (process.env.REHEARSAL_BLOCK) return Number(process.env.REHEARSAL_BLOCK);
    return (await new ethers.providers.JsonRpcProvider(LIVE_RPC).getBlockNumber()) - 5;
  }

  // Phase 0 on the fork, if mainnet had not had it yet at this block. Both directions are
  // checked: Phase 0 allowed the two setPath calls to land separately. A run that is meant to
  // gate the rollout (REHEARSAL_BLOCK set, or REQUIRE_LIVE_ROUTE=1) refuses to patch.
  async function fixRoute() {
    const reg = new ethers.Contract(UL_REGISTRY, REGISTRY_ABI, ethers.provider);
    const routed = async () => {
      const out = [];
      for (const [a, b] of [[WETH, CBETH], [CBETH, WETH]]) out.push((await reg.getPath(a, b))[0].dex);
      return out;
    };
    const before = await routed();
    routeLive = before.every((d) => d.toLowerCase() === AERO_DEX.toLowerCase());
    if (routeLive) {
      console.log("      route: WETH<->cbETH already on aeroSlipstream at this block (no fix-up)");
      return;
    }
    if (process.env.REHEARSAL_BLOCK || process.env.REQUIRE_LIVE_ROUTE === "1") {
      throw new Error(`route: WETH>cbETH / cbETH>WETH at fork block ${block} are on ${before.join(" / ")}, NOT on the `
        + `aeroSlipstream adapter ${AERO_DEX}. The plan requires the LIVE route at the rehearsal block, so this run does `
        + `not patch it (REHEARSAL_BLOCK=${process.env.REHEARSAL_BLOCK || "-"}, REQUIRE_LIVE_ROUTE=${process.env.REQUIRE_LIVE_ROUTE || "-"}). `
        + "Fork at a block after the Phase 0 setPath txs (53112297 / 53112300).");
    }
    console.warn("      ************************************************************************************");
    console.warn(`      ROUTE NOT LIVE at fork block ${block}: WETH<->cbETH on ${before.join(" / ")}.`);
    console.warn("      PATCHING it as the ULOwner on the fork. This run does NOT prove the mainnet route;");
    console.warn("      rerun with REHEARSAL_BLOCK=<block after 53112300> or REQUIRE_LIVE_ROUTE=1 to gate.");
    console.warn("      ************************************************************************************");
    const owner = await signer(UL_OWNER);
    await (await new ethers.Contract(AERO_DEX, DEX_ABI, owner).setTickSpacing(WETH, CBETH, 1, { gasLimit: 200_000 })).wait();
    await (await reg.connect(owner).setPath(AERO_DEX_ID, [WETH, CBETH], { gasLimit: 500_000 })).wait();
    await (await reg.connect(owner).setPath(AERO_DEX_ID, [CBETH, WETH], { gasLimit: 500_000 })).wait();
    const after = await routed();
    for (const d of after) same(d, AERO_DEX);
    console.log(`      route fix-up as the ULOwner: ${before.join(", ")} -> ${after.join(", ")}`);
  }

  // A real Safe execution: every owner up to the threshold approves the hash on chain,
  // then a non-owner submits it with v=1 (approved-hash) signatures sorted by owner.
  async function execSafe(tx, timestamp) {
    const nonce = await safe.nonce();
    const args = [tx.to, tx.value || 0, tx.data, tx.operation, 0, 0, 0, ZERO, ZERO];
    const hash = await safe.getTransactionHash(...args, nonce);
    const owners = (await safe.getOwners()).slice(0, Number(await safe.getThreshold()))
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    for (const o of owners) await (await safe.connect(await signer(o)).approveHash(hash)).wait();
    const sigs = ethers.utils.hexConcat(owners.map((o) => ethers.utils.hexConcat([pad32(o), pad32("0x00"), "0x01"])));
    if (timestamp) await send("evm_setNextBlockTimestamp", [timestamp]);
    return (await safe.connect(user).execTransaction(...args, sigs, { gasLimit: 15_000_000 })).wait();
  }
  const recordCall = () => ({ to: recorder.address, data: recorder.interface.encodeFunctionData("record", [VAULT, STRAT, SPECTRA_PT]) });
  // The same calls as a Safe batch, with a recorder snapshot before, between and after them.
  function recorded(calls) {
    const withRec = [recordCall()];
    for (const c of calls) withRec.push(c, recordCall());
    return { to: plan.MULTISEND_CALL_ONLY, value: 0, operation: 1, data: plan.encodeMultiSend(withRec) };
  }
  async function snaps() {
    const n = Number(await recorder.count());
    const out = [];
    for (let i = 0; i < n; i++) out.push(await recorder.snaps(i));
    return out;
  }
  const NAV_FIELDS = ["totalAssets", "ppfs", "previewRedeem", "ibtRate"];
  const fmt = (s) => `totalAssets ${E(s.totalAssets)} ppfs ${E(s.ppfs)} previewRedeem(1e18) ${E(s.previewRedeem)} stored ${E(s.storedBalance)} fee ${E(s.pendingFee)}`;

  async function getters(addr, abi, skip) {
    const c = new ethers.Contract(addr, abi, ethers.provider);
    const out = {};
    for (const f of abi) {
      if (f.type !== "function" || !["view", "pure"].includes(f.stateMutability) || f.inputs.length || skip.has(f.name)) continue;
      try { out[f.name] = String(await c[f.name]()); } catch (e) { out[f.name] = "<reverts>"; }
    }
    return out;
  }
  const vaultGetterAbi = () => JSON.parse(VAULT_GETTERS.format(ethers.utils.FormatTypes.json));
  const allGetters = async () => ({
    strat: await getters(STRAT, stratArt.abi, STRAT_SKIP),
    vault: await getters(VAULT, vaultGetterAbi(), VAULT_SKIP),
  });

  async function fund(amt) {
    await (await weth.deposit({ value: amt })).wait();
    await (await weth.approve(VAULT, ethers.constants.MaxUint256)).wait();
  }
  function depositEvent(rc) {
    const ev = rc.logs.map((l) => { try { return vault.interface.parseLog(l); } catch (e) { return null; } })
      .find((x) => x && x.name === "Deposit");
    return ev.args;
  }
  function eventsOf(rc, contract, name) {
    return rc.logs
      .filter((l) => l.address.toLowerCase() === contract.address.toLowerCase())
      .map((l) => { try { return contract.interface.parseLog(l); } catch (e) { return null; } })
      .filter((l) => l && l.name === name);
  }
  // Undo a deposit's price impact on the Aero CL pool (sell back the cbETH its swaps bought
  // through the same UL route), so the exit is measured from the untouched price.
  async function restorePool(rc) {
    let cbOut = ethers.BigNumber.from(0);
    for (const l of rc.logs) {
      if (l.address === ethers.utils.getAddress(CLPOOL) && l.topics[0] === SWAP_TOPIC) cbOut = cbOut.sub(SWAP_IFACE.parseLog(l).args.amount0);
    }
    assert.isTrue(cbOut.gt(0), "the deposit bought cbETH on the new Aero pool (route fix-up applied)");
    const cb = new ethers.Contract(CBETH, ERC20, await signer(CBETH_ATOKEN));
    await (await cb.transfer(USER, cbOut)).wait();
    const ul = new ethers.Contract(await strat.universalLiquidator(), ["function swap(address,address,uint256,uint256,address) returns (uint256)"], user);
    await (await cb.connect(user).approve(ul.address, cbOut)).wait();
    await (await ul.swap(CBETH, WETH, cbOut, 1, USER, { gasLimit: 3_000_000 })).wait();
  }

  before(async function () {
    block = await forkBlock();
    await send("hardhat_reset", [{ forking: { jsonRpcUrl: hre.network.config.forking.url, blockNumber: block } }]);
    await send("evm_mine"); // EDR has no Base hardfork history at the fork block itself
    safe = new ethers.Contract(SAFE, SAFE_ABI, ethers.provider);
    vault = new ethers.Contract(VAULT, VAULT_ABI, ethers.provider);
    strat = new ethers.Contract(STRAT, STRAT_ABI, ethers.provider);
    user = await signer(USER);
    weth = new ethers.Contract(WETH, ERC20, user);
    await fixRoute();

    assert.equal((await strat.implementation()).toLowerCase(), plan.LIVE_STRATEGY_IMPL, "fork block runs the live strategy impl");
    assert.equal((await vault.implementation()).toLowerCase(), plan.LIVE_VAULT_IMPL, "fork block runs the live vault impl");
    assert.equal(await vault.nextImplementation(), ZERO, "nothing scheduled on the vault at the fork block");

    // Deployed from the release build exactly as scripts/16 (STRATEGY_ONLY=1) does: fresh
    // lib, impl linked to it. No vault impl.
    lib = await (await ethers.getContractFactory("AaveReserveLib", user)).deploy();
    newStrat = await (await ethers.getContractFactory(STRATEGY_NAME, { signer: user, libraries: { [LIB_FQN]: lib.address } })).deploy();
    recorder = await (await ethers.getContractFactory("FoldUpgradeRecorder", user)).deploy();
    stratArt = await hre.artifacts.readArtifact(STRATEGY_NAME);
    libArt = await hre.artifacts.readArtifact("AaveReserveLib");
    txs = plan.strategyOnlyPlan({ strategyImpl: newStrat.address });
    console.log(`      fork block ${block}  route ${routeLive ? "already live (aeroSlipstream)" : "NOT live, PATCHED on the fork"}  lib ${lib.address}  strategy impl ${newStrat.address}`);
    console.log(`      before: totalAssets ${E(await vault.totalAssets())} ppfs ${E(await vault.getPricePerFullShare())} depositCap ${E(await vault.depositCap())}`);
  });

  it("deploys what scripts/16 would accept: the impl is linked to this build's library, both fit EIP-170", async function () {
    const code = await ethers.provider.getCode(newStrat.address);
    const linked = plan.linkedLibraries(code, stratArt)[LIB_FQN];
    assert.equal(linked, lib.address);
    await plan.assertLibraryMatchesBuild(ethers.provider, libArt, linked);
    // hardhat.config allows unlimited contract size, so the fork would accept an oversized
    // impl that Base itself rejects at deployment.
    const stratSize = ethers.utils.hexDataLength(code);
    const libSize = ethers.utils.hexDataLength(await ethers.provider.getCode(lib.address));
    console.log(`      runtime size: strategy impl ${stratSize} B (${EIP170 - stratSize} B headroom), AaveReserveLib ${libSize} B (EIP-170 limit ${EIP170})`);
    assert.isAtMost(stratSize, EIP170, "strategy impl exceeds EIP-170: Base would refuse the deployment");
    assert.isAtMost(libSize, EIP170, "AaveReserveLib exceeds EIP-170: Base would refuse the deployment");
  });

  it("the Transaction Builder files decode to exactly the calls this rehearsal executes (pure)", function () {
    const sel = (fn) => CALLS.getSighash(fn);
    // Keyed by the file names scripts/16 writes (from plan.strategyOnlyFiles): the rehearsed tx
    // each file must carry, and the raw calls it must decode to.
    const expect = {
      "safe-tx-1-schedule.json": [txs.safeTxs[0], [["scheduleUpgrade", [newStrat.address]]]],
      "safe-tx-2-upgrade.json": [txs.safeTxs[1], [["preInteract", []], ["upgrade", []]]],
      "safe-rollback-schedule.json": [txs.rollbackSafeTxs[0], [["scheduleUpgrade", [plan.LIVE_STRATEGY_IMPL]]]],
    };
    assert.equal(sel("preInteract"), "0xbd51aa1c");
    assert.equal(sel("upgrade"), "0xd55ec697");
    assert.equal(sel("scheduleUpgrade"), "0x0c80447a");
    const files = plan.strategyOnlyFiles({ strategyImpl: newStrat.address });
    assert.lengthOf(files, Object.keys(expect).length, "exactly the strategy-only rollout's files");
    assert.sameMembers(files.map((x) => x.file), Object.keys(expect));
    for (const { file: name, description, tx } of files) {
      const [rehearsed, want] = expect[name];
      // The file's tx is the very tx execSafe sends below.
      same(tx.to, rehearsed.to);
      assert.equal(tx.operation, rehearsed.operation, `${name}: operation`);
      assert.equal(tx.data, rehearsed.data, `${name}: Safe calldata == the rehearsed tx`);
      assert.isString(description, name);
      // Round-trip through JSON: what scripts/16 writes is what the Safe UI loads.
      const f = JSON.parse(JSON.stringify(plan.txBuilderFile(name, description, tx)));
      assert.equal(f.meta.name, name);
      assert.equal(f.version, "1.0", name);
      assert.equal(f.chainId, "8453", name);
      same(f.meta.createdFromSafeAddress, SAFE);
      assert.lengthOf(f.transactions, want.length, `${name}: raw inner calls, one per call`);
      f.transactions.forEach((t, i) => {
        same(t.to, STRAT);
        assert.equal(t.value, "0", name);
        assert.isNull(t.contractMethod, name);
        assert.notEqual(t.data.slice(0, 10), sel("multiSend"), `${name}: never a pre-encoded multiSend (Builder would send it with operation 0)`);
        const d = CALLS.parseTransaction({ data: t.data });
        assert.equal(d.name, want[i][0], `${name}[${i}]`);
        assert.deepEqual(d.args.map((a) => String(a).toLowerCase()), want[i][1].map((a) => a.toLowerCase()), `${name}[${i}] args`);
        same(t.to, tx.calls[i].to);
        assert.equal(t.data, tx.calls[i].data, `${name}[${i}] is the call the rehearsal sends`);
      });
      // What the Safe executes from the file is byte-for-byte what execSafe sends here: one
      // call as operation 0; several calls as Builder's delegatecall to MultiSendCallOnly.
      if (want.length === 1) {
        assert.equal(tx.operation, 0, name);
        same(tx.to, f.transactions[0].to);
        assert.equal(tx.data, f.transactions[0].data, name);
      } else {
        assert.equal(tx.operation, 1, name);
        same(tx.to, plan.MULTISEND_CALL_ONLY);
        assert.equal(tx.data, plan.encodeMultiSend(f.transactions), `${name}: Builder's MultiSend packing == the executed batch`);
      }
    }
    assert.lengthOf(txs.safeTxs, 2, "strategy-only: no vault tx");
  });

  it("Safe tx 1: one plain call schedules the strategy upgrade behind the 12h timelock; nothing on the vault", async function () {
    assert.equal(txs.safeTxs[0].operation, 0);
    assert.lengthOf(txs.safeTxs[0].calls, 1);
    const rc = await execSafe(txs.safeTxs[0]);
    const ts = (await ethers.provider.getBlock(rc.blockNumber)).timestamp;
    const delay = Number(await strat.nextImplementationDelay());
    assert.equal(delay, 43200);
    assert.equal(await strat.nextImplementation(), newStrat.address);
    assert.equal(Number(await strat.nextImplementationTimestamp()), ts + delay);
    assert.equal(await vault.nextImplementation(), ZERO, "nothing scheduled on the vault");
    // Inside the window even governance cannot upgrade.
    assert.include(await reverts(strat.connect(await signer(SAFE)).upgrade({ gasLimit: 3_000_000 })), "Upgrade not scheduled");

    await send("evm_increaseTime", [delay + 60]);
    await send("evm_mine");
    t0 = (await ethers.provider.getBlock("latest")).timestamp;
    gettersBefore = await allGetters();
  });

  it("after the delay only governance can run upgrade() (finalizeUpgrade is onlyGovernance)", async function () {
    await inSnapshot(async () => {
      assert.include(await reverts(strat.connect(user).upgrade({ gasLimit: 3_000_000 })), "Issue when finalizing the upgrade");
    });
  });

  it("RED: StrategyProxy.upgrade() WITHOUT the preInteract bundle steps the share price", async function () {
    const r = await inSnapshot(async () => {
      await execSafe(recorded([txs.safeTxs[1].calls[1]]), t0 + 600);
      return snaps();
    });
    const step = r[1].ppfs.sub(r[0].ppfs);
    console.log(`      before upgrade(): ${fmt(r[0])}`);
    console.log(`      after  upgrade(): ${fmt(r[1])}`);
    console.log(`      step across upgrade(): ppfs ${bps(step, r[0].ppfs)} bps, Spectra IBT rate ${r[0].ibtRate} -> ${r[1].ibtRate}`);
    assert.isFalse(step.isZero(), "the cached->live difference lands on upgrade() itself");
    // finalizeUpgrade() resyncs storedBalance without booking a fee.
    assert.isTrue(r[1].pendingFee.eq(r[0].pendingFee), "no fee booked on this path");
    green = { red: r };
  });

  it("GREEN: preInteract() + upgrade() in one batch: the share price is continuous to the wei across upgrade()", async function () {
    const r = await inSnapshot(async () => {
      await execSafe(recorded(txs.safeTxs[1].calls), t0 + 600);
      return snaps();
    });
    console.log(`      before batch:      ${fmt(r[0])}`);
    console.log(`      after preInteract: ${fmt(r[1])}`);
    console.log(`      after upgrade():   ${fmt(r[2])}`);
    console.log(`      preInteract on the old impl (cached -> live, books the deferred carry): ppfs ${bps(r[1].ppfs.sub(r[0].ppfs), r[0].ppfs)} bps, fee booked ${E(r[1].pendingFee.sub(r[0].pendingFee))}`);
    assert.equal(r[0].strategyImpl.toLowerCase(), plan.LIVE_STRATEGY_IMPL);
    assert.equal(r[2].strategyImpl, newStrat.address);
    for (const s of r) assert.equal(s.vaultImpl.toLowerCase(), plan.LIVE_VAULT_IMPL, "the vault impl never changes");
    for (const f of [...NAV_FIELDS, "storedBalance", "pendingFee"]) {
      assert.equal(r[2][f].toString(), r[1][f].toString(), `${f} changed across upgrade()`);
    }
    assert.equal(r[2].ibtRate.toString(), r[2].previewRedeem.mul(1e9).toString(), "Spectra reads previewRedeem(1e18) in ray");
    const red = green.red;
    console.log(`      block-level (what Spectra can observe), before -> after the batch: bundled ${bps(r[2].ppfs.sub(r[0].ppfs), r[0].ppfs)} bps, unbundled ${bps(red[1].ppfs.sub(red[0].ppfs), red[0].ppfs)} bps; fee the unbundled path forgives ${E(r[2].pendingFee.sub(red[1].pendingFee))}`);
    assert.isTrue(red[1].ppfs.gte(r[2].ppfs), "unbundled differs only by the fee it forgives");
    // Both runs start from the same snapshot at the same block timestamp, so the live NAV is
    // identical and the totalAssets gap is exactly the fee preInteract() books.
    assert.equal(red[1].totalAssets.sub(r[2].totalAssets).toString(), r[2].pendingFee.sub(r[0].pendingFee).toString(),
      "unbundled - bundled totalAssets == the fee the bundle books, to the wei");
    green = { ...green, snaps: r };
  });

  it("with a gain pending (live > storedBalance) the bundle books the fee that an unbundled upgrade forgives", async function () {
    // 0.05 cbETH supplied to Aave on behalf of the strategy: a gain the old impl has not booked.
    const gain = async () => {
      const amt = ethers.utils.parseEther("0.05");
      await (await new ethers.Contract(CBETH, ERC20, await signer(CBETH_ATOKEN)).transfer(USER, amt)).wait();
      await (await new ethers.Contract(CBETH, ERC20, user).approve(AAVE_POOL, amt)).wait();
      await (await new ethers.Contract(AAVE_POOL, ["function supply(address,uint256,address,uint16)"], user).supply(CBETH, amt, STRAT, 0)).wait();
    };
    // The gain is applied ONCE, outside both runs: its Aave supply updates the reserve at its
    // block's timestamp, and blocks mined outside execSafe's pinned timestamp follow the wall
    // clock. Applying it per run moved the live NAV by a few hundred thousand wei of interest
    // between the two paths and broke the wei-exact comparison below.
    const run = (calls) => inSnapshot(async () => { await execSafe(recorded(calls), t0 + 600); return snaps(); });
    await inSnapshot(async () => {
      await gain();
      const red = await run([txs.safeTxs[1].calls[1]]);
      const grn = await run(txs.safeTxs[1].calls);
      const fee = grn[2].pendingFee.sub(grn[0].pendingFee);
      console.log(`      unbundled: ppfs ${E(red[0].ppfs)} -> ${E(red[1].ppfs)}, fee booked ${E(red[1].pendingFee.sub(red[0].pendingFee))}`);
      console.log(`      bundled:   ppfs ${E(grn[0].ppfs)} -> ${E(grn[2].ppfs)}, fee booked ${E(fee)} (continuous across upgrade(): ${grn[1].ppfs.eq(grn[2].ppfs)})`);
      assert.isTrue(red[1].pendingFee.eq(red[0].pendingFee), "unbundled: finalizeUpgrade() resyncs storedBalance, the fee on the gain is lost");
      assert.isTrue(fee.gt(0), "bundled: preInteract() books it");
      assert.equal(red[1].totalAssets.sub(grn[2].totalAssets).toString(), fee.toString(), "the only difference is the forgiven fee");
      for (const f of [...NAV_FIELDS, "pendingFee", "storedBalance"]) assert.equal(grn[2][f].toString(), grn[1][f].toString(), f);
    });
  });

  // Runbook 2.4 prints EXPECTED_PPFS from an eth_call stateDiff override of the impl slot on
  // the pre-tx-2 state: no preInteract(), the new impl's simulated fee stands in for the one
  // tx 2 books. That value is only a valid reference if it IS the post-tx-2 share price.
  it("EXPECTED_PPFS (runbook 2.4): the impl-slot override on the pre-tx-2 state equals the post-tx-2 share price to the wei", async function () {
    const g = green.snaps[2]; // inside the GREEN batch, after upgrade(), at t0 + 600
    const o = await inSnapshot(async () => {
      await send("hardhat_setStorageAt", [STRAT, IMPL_SLOT, pad32(newStrat.address)]);
      await send("evm_setNextBlockTimestamp", [t0 + 600]); // the GREEN batch's timestamp
      await send("evm_mine");
      const b = await ethers.provider.getBlock("latest");
      assert.equal(b.timestamp, t0 + 600);
      const at = { blockTag: b.number };
      return {
        ppfs: await vault.getPricePerFullShare(at),
        previewRedeem: await vault.previewRedeem(ONE, at),
        totalAssets: await vault.totalAssets(at),
      };
    });
    console.log(`      override (no preInteract): ppfs ${o.ppfs} previewRedeem(1e18) ${o.previewRedeem} totalAssets ${o.totalAssets}`);
    console.log(`      GREEN after upgrade():     ppfs ${g.ppfs} previewRedeem(1e18) ${g.previewRedeem} totalAssets ${g.totalAssets}`);
    assert.equal(o.ppfs.toString(), g.ppfs.toString(), "EXPECTED_PPFS == post-tx-2 getPricePerFullShare()");
    assert.equal(o.previewRedeem.toString(), g.previewRedeem.toString(), "EXPECTED_PREVIEW_REDEEM == post-tx-2 previewRedeem(1e18)");
  });

  it("Safe tx 2 exactly as in the runbook leaves the same state as the recorded run", async function () {
    await execSafe(txs.safeTxs[1], t0 + 600);
    const g = green.snaps[2];
    assert.equal(await strat.implementation(), newStrat.address);
    assert.equal((await strat.storedBalance()).toString(), g.storedBalance.toString());
    assert.equal((await strat.pendingFee()).toString(), g.pendingFee.toString());
    assert.equal((await vault.getPricePerFullShare()).toString(), g.ppfs.toString());
    assert.equal(await strat.nextImplementation(), ZERO);
    assert.equal(Number(await strat.nextImplementationTimestamp()), 0);
  });

  it("keeper against the new impl: KeeperChecker reads checker() within checkGasLimit and runs the Morpho deleverage", async function () {
    await inSnapshot(async () => {
      const safeSigner = await signer(SAFE);
      const kc = await (await ethers.getContractFactory("KeeperChecker", user)).deploy(KEEPER_STORAGE);
      await kc.deployed();
      same(await kc.governance(), SAFE);
      same(await kc.controller(), CONTROLLER);
      // Phase 1.4's three calls, applied directly as the Safe.
      const ctrl = new ethers.Contract(CONTROLLER, CONTROLLER_ABI, safeSigner);
      await (await ctrl.addHardWorker(kc.address)).wait();
      await (await kc.connect(safeSigner).addEntries([STRAT], [KIND_HARD_WORK], [0])).wait();
      await (await kc.connect(safeSigner).setKeeper(KEEPER_BOT, true)).wait();
      assert.isTrue(await ctrl.hardWorkers(kc.address));
      const statusName = async () => KEEPER_STATUS[(await kc.status(STRAT))[0]];

      // CHECKER_FAILED here would mean the new checker() does not fit in checkGasLimit.
      assert.equal(await statusName(), "NOT_NEEDED", `healthy position, checker() within checkGasLimit ${await kc.checkGasLimit()}`);
      assert.isFalse((await kc.checkUpkeep("0x"))[0]);

      // 5% lower leverage target: targetHealth ~1.011 -> ~1.064, trigger ~1.053 vs HF ~1.032.
      const fold = new ethers.Contract(STRAT, FOLD_ABI, safeSigner);
      const target = await fold.borrowTargetFactorNumerator();
      await (await fold.setBorrowTargetFactorNumerator(target.mul(95).div(100))).wait();
      assert.isTrue((await fold.checker())[0], "a 5% lower borrow target makes the new impl ask for a deleverage");
      assert.equal(await statusName(), "ELIGIBLE");
      const [up, data] = await kc.checkUpkeep("0x");
      assert.isTrue(up);
      const [targets] = ethers.utils.defaultAbiCoder.decode(["address[]"], data);
      assert.deepEqual(targets, [STRAT]);

      const bot = await signer(KEEPER_BOT);
      const rc = await (await kc.connect(bot).performUpkeep(data, { gasLimit: KEEPER_PERFORM_GAS })).wait();
      console.log(`      deleverage on the new impl via KeeperChecker: gasUsed ${rc.gasUsed.toString()} (entry cap ${KEEPER_ENTRY_GAS_CAP})`);
      const failed = eventsOf(rc, kc, "UpkeepFailed");
      assert.lengthOf(failed, 0, `UpkeepFailed: ${failed.map((e) => e.args.reason).join(",")}`);
      const executed = eventsOf(rc, kc, "UpkeepExecuted");
      assert.lengthOf(executed, 1);
      same(executed[0].args.target, STRAT);
      const logs = eventsOf(rc, ctrl, "SharePriceChangeLog");
      assert.lengthOf(logs, 1, "the hard work went through the Controller");
      same(logs[0].args.vault, VAULT);
      same(logs[0].args.strategy, STRAT);
      // The Morpho delever sells cbETH (token0) into the new pool: amount0 > 0 for the pool.
      const swaps = rc.logs.filter((l) => l.address === ethers.utils.getAddress(CLPOOL) && l.topics[0] === SWAP_TOPIC)
        .map((l) => SWAP_IFACE.parseLog(l).args);
      assert.isTrue(swaps.some((s) => s.amount0.gt(0)), `cbETH sold through the new Aero pool ${CLPOOL} (swaps: ${swaps.length})`);
      // The whole tx is an upper bound for the entry's own gas.
      assert.isTrue(rc.gasUsed.lt(KEEPER_ENTRY_GAS_CAP), `gasUsed ${rc.gasUsed} under the ${KEEPER_ENTRY_GAS_CAP} per-entry cap`);
      assert.isFalse((await kc.checkUpkeep("0x"))[0], "quiet after the deleverage");
      assert.isFalse((await fold.checker())[0], "deleveraged to the new target");
    });
  });

  it("every strategy and vault getter reads the same after the upgrade; the vault impl is still the live one", async function () {
    const after = await allGetters();
    const added = [];
    for (const side of ["strat", "vault"]) {
      for (const [k, v] of Object.entries(gettersBefore[side])) {
        if (v === "<reverts>") { added.push(`${side}.${k}=${after[side][k]}`); continue; } // new in this build
        assert.equal(after[side][k], v, `${side}.${k}`);
      }
    }
    console.log(`      compared ${Object.keys(after.strat).length} strategy + ${Object.keys(after.vault).length} vault getters; new: ${added.join(", ") || "none"}`);
    assert.equal(after.vault.implementation.toLowerCase(), plan.LIVE_VAULT_IMPL, "vault not upgraded");
    assert.equal(after.vault.nextImplementation, ZERO, "nothing scheduled on the vault");
    assert.equal(after.vault.depositCap, ethers.utils.parseEther("200").toString(), "live 200 WETH cap untouched");
    assert.equal(after.strat.leverFlashPremiumBps, "0");
    assert.equal(after.strat.deleverFlashPremiumBps, "0", "Morpho can lend the whole debt");
    assert.equal(after.strat.feeFloor, "1000");
    // Spectra's PT keeps reading previewRedeem(1e18) in ray from the same vault.
    const ibt = await new ethers.Contract(SPECTRA_PT, PT_ABI, ethers.provider).getIBTRate();
    assert.equal(ibt.toString(), (await vault.previewRedeem(ONE)).mul(1e9).toString());
  });

  it("smoke: ERC-4626 and legacy deposit/exit of 1 WETH, Controller.doHardWork as governance", async function () {
    await inSnapshot(async () => {
      await fund(ONE.mul(2));
      const u = USER;
      // ERC-4626 deposit
      const s0 = await vault.balanceOf(u);
      await (await vault.connect(user)["deposit(uint256,address)"](ONE, u, { gasLimit: 15_000_000 })).wait();
      const s4626 = (await vault.balanceOf(u)).sub(s0);
      assert.isTrue(s4626.gt(0), "ERC-4626 deposit minted");
      // legacy deposit(uint256)
      await (await vault.connect(user)["deposit(uint256)"](ONE, { gasLimit: 15_000_000 })).wait();
      const sLegacy = (await vault.balanceOf(u)).sub(s0).sub(s4626);
      assert.isTrue(sLegacy.gt(0), "legacy deposit minted");
      let w0 = await weth.balanceOf(u);
      await (await vault.connect(user)["redeem(uint256,address,address)"](s4626, u, u, { gasLimit: 15_000_000 })).wait();
      const got4626 = (await weth.balanceOf(u)).sub(w0);
      w0 = await weth.balanceOf(u);
      await (await vault.connect(user)["withdraw(uint256)"](sLegacy, { gasLimit: 15_000_000 })).wait();
      const gotLegacy = (await weth.balanceOf(u)).sub(w0);
      console.log(`      1 WETH round trips: ERC-4626 ${E(got4626)}, legacy ${E(gotLegacy)}`);
      assert.isTrue(got4626.gt(ONE.mul(99).div(100)) && gotLegacy.gt(ONE.mul(99).div(100)), "round trips within ~1%");
      assert.isTrue((await vault.balanceOf(u)).eq(s0), "all test shares redeemed");

      // Controller.doHardWork(vault) as governance (the Safe)
      const ctrl = new ethers.Contract(CONTROLLER, ["function doHardWork(address)"], await signer(SAFE));
      const ppfs0 = await vault.getPricePerFullShare();
      await (await ctrl.doHardWork(VAULT, { gasLimit: 15_000_000 })).wait();
      console.log(`      doHardWork: ppfs ${E(ppfs0)} -> ${E(await vault.getPricePerFullShare())}`);
    });
  });

  it("entry 20..35 bps and exit -20..0 bps on 1 WETH (new Aero route, premium-free flashloans)", async function () {
    await inSnapshot(async () => {
      assert.equal((await strat.leverFlashPremiumBps()).toString(), "0");
      assert.equal((await strat.deleverFlashPremiumBps()).toString(), "0", "Morpho can lend the whole debt");
      await fund(ONE);
      const s0 = await vault.balanceOf(USER);
      const rc = await (await vault.connect(user)["deposit(uint256,address)"](ONE, USER, { gasLimit: 15_000_000 })).wait();
      const entry = bps(ONE.sub(depositEvent(rc).assets), ONE);
      await restorePool(rc);
      const shares = (await vault.balanceOf(USER)).sub(s0);
      const fair = shares.mul(await vault.totalAssets()).div(await vault.totalSupply());
      const w0 = await weth.balanceOf(USER);
      await (await vault.connect(user)["redeem(uint256,address,address)"](shares, USER, USER, { gasLimit: 15_000_000 })).wait();
      const exit = bps(fair.sub((await weth.balanceOf(USER)).sub(w0)), fair);
      // Printed before the asserts so a miss still shows the measurement. The plan expects
      // ~27 in / ~-12 out. The pool's dynamic fee (60 -> up to 190 pips) can add up to ~16 bp
      // on entry; a miss above 35 bp with a high fee at the fork block is that, not a regression.
      console.log(`      entry cost ${entry} bps, exit cost ${exit} bps`);
      assert.isAbove(entry, 20); assert.isBelow(entry, 35);
      assert.isAbove(exit, -20); assert.isBelow(exit, 0);
    });
  });

  it("a strategy impl linked to the stale library 0x2B19aB8A bricks deposits and exits, and scripts/16's guard refuses it", async function () {
    await inSnapshot(async () => {
      const stale = await (await ethers.getContractFactory(STRATEGY_NAME, { signer: user, libraries: { [LIB_FQN]: STALE_LIB } })).deploy();
      const linked = plan.linkedLibraries(await ethers.provider.getCode(stale.address), stratArt)[LIB_FQN];
      assert.equal(linked, ethers.utils.getAddress(STALE_LIB));
      let refused = null;
      try { await plan.assertLibraryMatchesBuild(ethers.provider, libArt, linked); } catch (e) { refused = e.message; }
      assert.include(refused || "", "stale library");

      await fund(ONE.mul(2));
      const s0 = await vault.balanceOf(USER);
      await (await vault.connect(user)["deposit(uint256,address)"](ONE, USER, { gasLimit: 15_000_000 })).wait(); // on the good impl
      const shares = (await vault.balanceOf(USER)).sub(s0);
      await send("hardhat_setStorageAt", [STRAT, IMPL_SLOT, pad32(stale.address)]);
      const dep = await reverts(vault.connect(user)["deposit(uint256,address)"](ONE, USER, { gasLimit: 15_000_000 }));
      const red = await reverts(vault.connect(user)["redeem(uint256,address,address)"](shares, USER, USER, { gasLimit: 15_000_000 }));
      console.log(`      stale-linked impl: deposit -> ${String(dep).slice(0, 90)}; redeem -> ${String(red).slice(0, 90)}`);
      assert.isNotNull(dep, "deposit must revert");
      assert.isNotNull(red, "redeem must revert");
    });
  });

  it("rollback: scheduling the live impl again and the same Safe tx 2 after 12h restores it", async function () {
    assert.equal(txs.rollbackSafeTxs[0].operation, 0);
    const rc = await execSafe(txs.rollbackSafeTxs[0]);
    const ts = (await ethers.provider.getBlock(rc.blockNumber)).timestamp;
    assert.equal((await strat.nextImplementation()).toLowerCase(), plan.LIVE_STRATEGY_IMPL);
    assert.equal(Number(await strat.nextImplementationTimestamp()), ts + 43200);
    await send("evm_increaseTime", [43200 + 60]);
    await send("evm_mine");
    const ppfs0 = await vault.getPricePerFullShare();
    const fee0 = await strat.pendingFee();
    const supply = await vault.totalSupply();
    // Its calls are impl-independent: preInteract() on the new impl, then the old impl's
    // finalizeUpgrade() run by the Safe.
    await execSafe(txs.safeTxs[1]);
    assert.equal((await strat.implementation()).toLowerCase(), plan.LIVE_STRATEGY_IMPL, "strategy back on the live impl");
    assert.equal(await strat.nextImplementation(), ZERO);
    assert.equal((await vault.implementation()).toLowerCase(), plan.LIVE_VAULT_IMPL, "vault impl untouched throughout");
    assert.equal(await vault.nextImplementation(), ZERO);
    const ppfs = await vault.getPricePerFullShare();
    assert.isTrue(ppfs.gt(0));
    // The new impl already nets its simulated fee out of the live NAV, and preInteract() books
    // the same fee before the old impl takes over with storedBalance resynced: the share price
    // may move by the booked fee (in ppfs terms) plus less than 1 bp of drift, nothing more.
    const fee = (await strat.pendingFee()).sub(fee0);
    const feePpfs = fee.gt(0) ? fee.mul(ONE).div(supply) : ethers.BigNumber.from(0);
    const move = ppfs.sub(ppfs0).abs();
    console.log(`      rollback batch: ppfs ${E(ppfs0)} -> ${E(ppfs)} (${bps(ppfs.sub(ppfs0), ppfs0)} bps), fee booked ${E(fee)} (${feePpfs} wei of ppfs)`);
    assert.isTrue(move.lt(ppfs0.div(10_000).add(feePpfs)), `rollback moved ppfs by ${move} wei: more than 1 bp + the booked fee`);

    // The rolled-back impl still takes and returns money.
    await inSnapshot(async () => {
      const amt = ONE.div(10);
      await fund(amt);
      const s0 = await vault.balanceOf(USER);
      await (await vault.connect(user)["deposit(uint256,address)"](amt, USER, { gasLimit: 15_000_000 })).wait();
      const shares = (await vault.balanceOf(USER)).sub(s0);
      assert.isTrue(shares.gt(0), "ERC-4626 deposit on the rolled-back impl minted");
      const w0 = await weth.balanceOf(USER);
      await (await vault.connect(user)["redeem(uint256,address,address)"](shares, USER, USER, { gasLimit: 15_000_000 })).wait();
      const got = (await weth.balanceOf(USER)).sub(w0);
      console.log(`      0.1 WETH round trip on the rolled-back impl: ${E(got)}`);
      assert.isTrue((await vault.balanceOf(USER)).eq(s0), "all test shares redeemed");
      // The live impl pays flash premiums (~75 bp in, ~55 bp out): a loose bound.
      assert.isTrue(got.gt(amt.mul(97).div(100)), "round trip within 3%");
    });
  });
});
