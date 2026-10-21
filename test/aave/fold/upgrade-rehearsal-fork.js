// Rehearsal of the exact governance upgrade of BOTH live fold proxies on the release build.
//
// Forks Base at REHEARSAL_BLOCK (default: a recent block), deploys the new AaveReserveLib,
// strategy impl and FoldVaultV2 impl from this tree, and then sends the transactions of
// scripts/fold-upgrade-plan.js (the same calldata scripts/16 prints) through the REAL Safe
// 0x920b1a: execTransaction with two owners' approved hashes, MultiSendCallOnly 1.4.1 as a
// delegatecall for the batches. No setStorageAt, no impersonated shortcut for the upgrade.
//
//   Safe tx 1: strategy.scheduleUpgrade(newStrat) + vault.scheduleUpgrade(newVault)
//   (12h)
//   Safe tx 2: strategy.preInteract() + StrategyProxy.upgrade()     (one batch)
//   Safe tx 3: VaultProxy.upgrade()
//   ULOwner EOA: CLChainlinkChecker.removeVault(strategy)
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
//   REHEARSAL_BLOCK=52896800 npx hardhat test test/aave/fold/upgrade-rehearsal-fork.js
//
// ethers-only on purpose: truffle's confirmation pollers are what deadlocked the
// in-process node in the 2026-10-05 crash.

const { assert } = require("chai");
const { ethers } = hre;
const plan = require("../../../scripts/fold-upgrade-plan.js");

const BLOCK = Number(process.env.REHEARSAL_BLOCK || 52896800);
const { STRATEGY_PROXY: STRAT, VAULT_PROXY: VAULT, SAFE, CONTROLLER, CL_CHECKER, UL_OWNER, CHAINLINK_CHECKER,
  SPECTRA_PT, STALE_LIB, LIB_FQN, STRATEGY_NAME } = plan;
const WETH = "0x4200000000000000000000000000000000000006";
const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
const CLPOOL = "0x47cA96Ea59C13F72745928887f84C9F52C3D7348"; // Slipstream cbETH(token0)/WETH(token1), the UL route
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
const VAULT_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function getPricePerFullShare() view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function previewLens() view returns (address)",
  "function depositCap() view returns (uint256)",
  "function implementation() view returns (address)",
  "function nextImplementation() view returns (address)",
  "function nextImplementationTimestamp() view returns (uint256)",
  "function nextImplementationDelay() view returns (uint256)",
  "function deposit(uint256) returns (uint256)",
  "function deposit(uint256,address) returns (uint256)",
  "function deposit(uint256,address,uint256) returns (uint256)",
  "function withdraw(uint256) returns (uint256)",
  "function redeem(uint256,address,address) returns (uint256)",
  "function redeem(uint256,address,address,uint256) returns (uint256)",
  "function upgrade()",
  "event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares)",
];
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
  "function checker() view returns (bool,bytes)",
  "function upgrade()",
];
const SWAP_TOPIC = ethers.utils.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const SWAP_IFACE = new ethers.utils.Interface(["event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"]);

// Getters that must read the same before and after both upgrades. Everything zero-arg in
// the new ABIs, minus values that are live by design (NAV and what derives from it), the
// upgrade schedule (reset by finalizeUpgrade, asserted separately), and the fee/stored
// balance (asserted against the in-batch values instead).
const STRAT_SKIP = new Set(["checker", "investedUnderlyingBalance", "storedBalance", "pendingFee",
  "nextImplementation", "nextImplementationTimestamp", "shouldUpgrade"]);
const VAULT_SKIP = new Set(["assetsPerShare", "availableToInvestOut", "getPricePerFullShare", "totalAssets",
  "underlyingBalanceWithInvestment", "nextImplementation", "nextImplementationTimestamp", "shouldUpgrade"]);

describe(`Aave fold upgrade rehearsal through the Safe (fork @${BLOCK})`, function () {
  let safe, vault, strat, recorder, weth, user, lib, newStrat, newVault, txs;
  let stratArt, vaultArt, libArt, gettersBefore, ready, t0, green;

  const send = (m, p = []) => ethers.provider.send(m, p);
  const E = (x) => ethers.utils.formatEther(x);
  const bps = (num, den) => Number(num.mul(10_000_000).div(den)) / 1000;
  const pad32 = (a) => ethers.utils.hexZeroPad(a, 32);
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

  async function getters(addr, artifact, skip) {
    const c = new ethers.Contract(addr, artifact.abi, ethers.provider);
    const out = {};
    for (const f of artifact.abi) {
      if (f.type !== "function" || !["view", "pure"].includes(f.stateMutability) || f.inputs.length || skip.has(f.name)) continue;
      try { out[f.name] = String(await c[f.name]()); } catch (e) { out[f.name] = "<reverts>"; }
    }
    return out;
  }

  async function fund(amt) {
    await (await weth.deposit({ value: amt })).wait();
    await (await weth.approve(VAULT, ethers.constants.MaxUint256)).wait();
  }
  function depositEvent(rc) {
    const ev = rc.logs.map((l) => { try { return vault.interface.parseLog(l); } catch (e) { return null; } })
      .find((x) => x && x.name === "Deposit");
    return ev.args;
  }
  // Undo a deposit's price impact on the Slipstream pool (sell back the cbETH its swaps
  // bought through the same UL route), so the exit is measured from the untouched price.
  async function restorePool(rc) {
    let cbOut = ethers.BigNumber.from(0);
    for (const l of rc.logs) {
      if (l.address === ethers.utils.getAddress(CLPOOL) && l.topics[0] === SWAP_TOPIC) cbOut = cbOut.sub(SWAP_IFACE.parseLog(l).args.amount0);
    }
    const cb = new ethers.Contract(CBETH, ERC20, await signer(CBETH_ATOKEN));
    await (await cb.transfer(USER, cbOut)).wait();
    const ul = new ethers.Contract(await strat.universalLiquidator(), ["function swap(address,address,uint256,uint256,address) returns (uint256)"], user);
    await (await cb.connect(user).approve(ul.address, cbOut)).wait();
    await (await ul.swap(CBETH, WETH, cbOut, 1, USER, { gasLimit: 3_000_000 })).wait();
  }

  before(async function () {
    await send("hardhat_reset", [{ forking: { jsonRpcUrl: hre.network.config.forking.url, blockNumber: BLOCK } }]);
    await send("evm_mine"); // EDR has no Base hardfork history at the fork block itself
    safe = new ethers.Contract(SAFE, SAFE_ABI, ethers.provider);
    vault = new ethers.Contract(VAULT, VAULT_ABI, ethers.provider);
    strat = new ethers.Contract(STRAT, STRAT_ABI, ethers.provider);
    user = await signer(USER);
    weth = new ethers.Contract(WETH, ERC20, user);

    assert.equal((await strat.implementation()).toLowerCase(), plan.LIVE_STRATEGY_IMPL, "fork block runs the live strategy impl");
    assert.equal((await vault.implementation()).toLowerCase(), plan.LIVE_VAULT_IMPL, "fork block runs the live vault impl");

    // Deployed from the release build exactly as scripts/16 does: fresh lib, impl linked to it.
    lib = await (await ethers.getContractFactory("AaveReserveLib", user)).deploy();
    newStrat = await (await ethers.getContractFactory(STRATEGY_NAME, { signer: user, libraries: { [LIB_FQN]: lib.address } })).deploy();
    newVault = await (await ethers.getContractFactory("FoldVaultV2", user)).deploy();
    recorder = await (await ethers.getContractFactory("FoldUpgradeRecorder", user)).deploy();
    stratArt = await hre.artifacts.readArtifact(STRATEGY_NAME);
    vaultArt = await hre.artifacts.readArtifact("FoldVaultV2");
    libArt = await hre.artifacts.readArtifact("AaveReserveLib");
    txs = plan.governancePlan({ strategyImpl: newStrat.address, vaultImpl: newVault.address });
    console.log(`      lib ${lib.address}  strategy impl ${newStrat.address}  vault impl ${newVault.address}`);
    console.log(`      before: totalAssets ${E(await vault.totalAssets())} ppfs ${E(await vault.getPricePerFullShare())} depositCap ${E(await vault.depositCap())}`);
  });

  it("deploys what scripts/16 would accept: the impl is linked to this build's library", async function () {
    const linked = plan.linkedLibraries(await ethers.provider.getCode(newStrat.address), stratArt)[LIB_FQN];
    assert.equal(linked, lib.address);
    await plan.assertLibraryMatchesBuild(ethers.provider, libArt, linked);
    assert.equal((await ethers.provider.getCode(newVault.address)).toLowerCase(), vaultArt.deployedBytecode.toLowerCase());
  });

  it("Safe tx 1: one batch schedules both upgrades behind the 12h timelock", async function () {
    const rc = await execSafe(txs.safeTxs[0]);
    const ts = (await ethers.provider.getBlock(rc.blockNumber)).timestamp;
    for (const [c, impl] of [[strat, newStrat.address], [vault, newVault.address]]) {
      assert.equal(await c.nextImplementation(), impl);
      assert.equal(Number(await c.nextImplementationDelay()), 43200);
      assert.equal(Number(await c.nextImplementationTimestamp()), ts + 43200);
    }
    // Inside the window even governance cannot upgrade.
    const g = await signer(SAFE);
    assert.include(await reverts(strat.connect(g).upgrade({ gasLimit: 3_000_000 })), "Upgrade not scheduled");
    assert.include(await reverts(vault.connect(g).upgrade({ gasLimit: 3_000_000 })), "Upgrade not scheduled");

    await send("evm_increaseTime", [43200 + 60]);
    await send("evm_mine");
    t0 = (await ethers.provider.getBlock("latest")).timestamp;
    gettersBefore = { strat: await getters(STRAT, stratArt, STRAT_SKIP), vault: await getters(VAULT, vaultArt, VAULT_SKIP) };
    ready = await send("evm_snapshot");
  });

  it("after the delay only governance can run either upgrade() (finalizeUpgrade is onlyGovernance)", async function () {
    await inSnapshot(async () => {
      assert.include(await reverts(strat.connect(user).upgrade({ gasLimit: 3_000_000 })), "Issue when finalizing the upgrade");
      assert.include(await reverts(vault.connect(user).upgrade({ gasLimit: 3_000_000 })), "Issue when finalizing the upgrade");
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
    for (const f of [...NAV_FIELDS, "storedBalance", "pendingFee"]) {
      assert.equal(r[2][f].toString(), r[1][f].toString(), `${f} changed across upgrade()`);
    }
    assert.equal(r[2].ibtRate.toString(), r[2].previewRedeem.mul(1e9).toString(), "Spectra reads previewRedeem(1e18) in ray");
    const red = green.red;
    console.log(`      block-level (what Spectra can observe), before -> after the batch: bundled ${bps(r[2].ppfs.sub(r[0].ppfs), r[0].ppfs)} bps, unbundled ${bps(red[1].ppfs.sub(red[0].ppfs), red[0].ppfs)} bps; fee the unbundled path forgives ${E(r[2].pendingFee.sub(red[1].pendingFee))}`);
    assert.isTrue(red[1].ppfs.gte(r[2].ppfs), "unbundled differs only by the fee it forgives");
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
    const run = (calls) => inSnapshot(async () => { await gain(); await execSafe(recorded(calls), t0 + 600); return snaps(); });
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

  it("Safe tx 2 exactly as in the runbook leaves the same state as the recorded run", async function () {
    await execSafe(txs.safeTxs[1], t0 + 600);
    const g = green.snaps[2];
    assert.equal(await strat.implementation(), newStrat.address);
    assert.equal((await strat.storedBalance()).toString(), g.storedBalance.toString());
    assert.equal((await strat.pendingFee()).toString(), g.pendingFee.toString());
    assert.equal(await strat.nextImplementation(), ZERO);
    assert.equal(Number(await strat.nextImplementationTimestamp()), 0);
  });

  it("Safe tx 3 (VaultProxy.upgrade()) keeps totalAssets, ppfs, previewRedeem(1e18) and the Spectra rate to the wei", async function () {
    const t = (await ethers.provider.getBlock("latest")).timestamp + 600;
    const r = await inSnapshot(async () => {
      await execSafe(recorded([txs.safeTxs[2].calls[0]]), t);
      return snaps();
    });
    console.log(`      before vault upgrade(): ${fmt(r[0])}`);
    console.log(`      after  vault upgrade(): ${fmt(r[1])}`);
    assert.equal(r[0].vaultImpl.toLowerCase(), plan.LIVE_VAULT_IMPL);
    assert.equal(r[1].vaultImpl, newVault.address);
    for (const f of NAV_FIELDS) assert.equal(r[1][f].toString(), r[0][f].toString(), `${f} changed across the vault upgrade`);

    await execSafe(txs.safeTxs[2], t);
    assert.equal(await vault.implementation(), newVault.address);
    assert.equal(await vault.previewLens(), ZERO, "the preview lens stays unset");
    assert.equal(await vault.nextImplementation(), ZERO);
    assert.equal(Number(await vault.nextImplementationTimestamp()), 0);
  });

  it("every slot getter reads the same after both upgrades", async function () {
    const after = { strat: await getters(STRAT, stratArt, STRAT_SKIP), vault: await getters(VAULT, vaultArt, VAULT_SKIP) };
    const added = [];
    for (const side of ["strat", "vault"]) {
      for (const [k, v] of Object.entries(gettersBefore[side])) {
        if (v === "<reverts>") { added.push(`${side}.${k}=${after[side][k]}`); continue; } // new in this build
        assert.equal(after[side][k], v, `${side}.${k}`);
      }
    }
    console.log(`      compared ${Object.keys(after.strat).length} strategy + ${Object.keys(after.vault).length} vault getters; new: ${added.join(", ")}`);
    assert.equal(after.vault.depositCap, ethers.utils.parseEther("200").toString(), "live 200 WETH cap carried over");
    assert.equal(after.vault.previewLens, ZERO);
    assert.equal(after.strat.leverFlashPremiumBps, "0");
  });

  it("smoke: ERC-4626 and legacy deposit/exit, min-out overloads, Controller.doHardWork as governance", async function () {
    await inSnapshot(async () => {
      await fund(ONE.mul(10));
      const u = USER;
      // ERC-4626 deposit + redeem
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

      // min-out overloads
      const pd = await vault.previewDeposit(ONE);
      assert.include(await reverts(vault.connect(user)["deposit(uint256,address,uint256)"](ONE, u, pd.mul(2), { gasLimit: 15_000_000 })), "Below minShares");
      const b1 = await vault.balanceOf(u);
      await (await vault.connect(user)["deposit(uint256,address,uint256)"](ONE, u, pd.mul(99).div(100), { gasLimit: 15_000_000 })).wait();
      const minted = (await vault.balanceOf(u)).sub(b1);
      const pr = await vault.previewRedeem(minted);
      assert.include(await reverts(vault.connect(user)["redeem(uint256,address,address,uint256)"](minted, u, u, pr.mul(2), { gasLimit: 15_000_000 })), "Below minAssets");
      await (await vault.connect(user)["redeem(uint256,address,address,uint256)"](minted, u, u, pr.mul(99).div(100), { gasLimit: 15_000_000 })).wait();
      assert.isTrue((await vault.balanceOf(u)).eq(s0), "all test shares redeemed");

      // Controller.doHardWork(vault) as governance (the Safe)
      const ctrl = new ethers.Contract(CONTROLLER, ["function doHardWork(address)"], await signer(SAFE));
      const ppfs0 = await vault.getPricePerFullShare();
      await (await ctrl.doHardWork(VAULT, { gasLimit: 15_000_000 })).wait();
      console.log(`      doHardWork: ppfs ${E(ppfs0)} -> ${E(await vault.getPricePerFullShare())}`);
    });
  });

  it("entry ~17.5 bps and exit ~-2.5 bps on 1 WETH", async function () {
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
      console.log(`      entry cost ${entry} bps, exit cost ${exit} bps`);
      assert.isAbove(entry, 10); assert.isBelow(entry, 25);
      assert.isAbove(exit, -6); assert.isBelow(exit, 4);
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

  it("keeper checker: removeVault succeeds from the ULOwner EOA, reverts from the Safe; ChainlinkChecker.addVault (optional) works from the Safe", async function () {
    const cl = new ethers.Contract(CL_CHECKER, ["function isVault(address) view returns (bool)", "function governance() view returns (address)"], ethers.provider);
    assert.equal(await cl.governance(), UL_OWNER);
    const [, payload] = await strat.checker(); // the new impl's checker() still answers
    assert.equal(payload.slice(0, 10), new ethers.utils.Interface(["function doHardWork(address)"]).getSighash("doHardWork"), "payload is a Controller call");
    if (!(await cl.isVault(STRAT))) {
      console.log("      strategy is no longer registered in CLChainlinkChecker at this block: EOA tx not needed");
      return;
    }
    // Through the Safe it fails, and takes the whole Safe transaction with it.
    const viaSafe = { to: plan.MULTISEND_CALL_ONLY, value: 0, operation: 1, data: plan.encodeMultiSend([{ to: CL_CHECKER, data: txs.eoaTxs[0].data }]) };
    assert.include(String(await inSnapshot(() => reverts(() => execSafe(viaSafe)))), "GS013", "removeVault inside a Safe batch must revert");

    const eoa = txs.eoaTxs[0];
    await (await (await signer(eoa.from)).sendTransaction({ to: eoa.to, data: eoa.data, gasLimit: 500_000 })).wait();
    assert.isFalse(await cl.isVault(STRAT));

    const opt = txs.optionalSafeTxs[0];
    await execSafe(opt);
    const cc = new ethers.Contract(CHAINLINK_CHECKER, ["function isVault(address) view returns (bool)", "function checkUpkeep(bytes) view returns (bool,bytes)"], ethers.provider);
    assert.isTrue(await cc.isVault(STRAT));
    await cc.checkUpkeep("0x"); // does not revert with the fold strategy registered
  });
});
