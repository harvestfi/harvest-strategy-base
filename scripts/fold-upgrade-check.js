// Read-only checks around the strategy-only fold upgrade (docs/aave-fold-upgrade-runbook.md).
// Plain node + ethers v5 against Base mainnet; no hardhat, no signer, sends nothing.
//
//   STRATEGY_IMPL=0x… SCHEDULE_TX=0x… node scripts/fold-upgrade-check.js --phase after-schedule
//   STRATEGY_IMPL=0x…                 node scripts/fold-upgrade-check.js --phase before-upgrade
//   STRATEGY_IMPL=0x… UPGRADE_TX=0x…  node scripts/fold-upgrade-check.js --phase after-upgrade
//     UPGRADE_TX is the pass/fail path for share-price continuity. Without it,
//     EXPECTED_PPFS (and EXPECTED_PPFS_AT) from before-upgrade are compared for
//     information only: live NAV drifts every block, so that diff cannot pass or fail.
//
// SCHEDULE_TX / UPGRADE_TX are the Safe EXECUTION tx hashes (the on-chain tx that called
// execTransaction), not the safeTxHash shown while collecting signatures.
//
// RPC: https://base-mainnet.g.alchemy.com/v2/${ALCHEMEY_KEY} (from .env), or RPC_URL.
// It must serve archive state and eth_call state overrides (Alchemy does), and ideally
// eth_call block overrides (4th param; Alchemy does), which align the continuity check's
// timestamp.
//
// The linked-library check needs the compiled artifacts (npx hardhat compile, same
// build as the deploy); without them it FAILS unless SKIP_LIB_CHECK=1. The stale-library
// byte scan of the impl runs regardless.
//
// Every checked value is printed. Any failed check exits 1 after all checks of the phase ran.
//
// For a rollback (STRATEGY_IMPL = the live impl 0x74ae6e11) after-schedule and
// before-upgrade apply unchanged except the library check, which is skipped: that impl is
// linked to the stale library by definition. after-upgrade then skips the new impl's
// premium/feeFloor getters (the old impl has none) and prints the share price across
// tx 2 without a pass/fail (the old impl reports a cache, so no override can match it).

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");
const { ethers } = require("ethers");
const plan = require("./fold-upgrade-plan.js");

const {
  STRATEGY_PROXY, VAULT_PROXY, SAFE, SPECTRA_PT, STALE_LIB, LIB_FQN, STRATEGY_NAME,
  LIVE_STRATEGY_IMPL, LIVE_VAULT_IMPL, IMPL_SLOT,
} = plan;

const ZERO = ethers.constants.AddressZero;
const ONE = ethers.constants.WeiPerEther;
const FEE_FLOOR = ethers.BigNumber.from(1000);
const DEPOSIT_CAP = ethers.utils.parseEther("200");
const ARTIFACTS = path.join(__dirname, "..", "artifacts", "contracts", "strategies", "aave", "fold");
const STRATEGY_ARTIFACT = path.join(ARTIFACTS, `${STRATEGY_NAME}.sol`, `${STRATEGY_NAME}.json`);
const LIB_ARTIFACT = path.join(ARTIFACTS, "AaveReserveLib.sol", "AaveReserveLib.json");
// Safe 1.4.1 emits ExecutionSuccess when execTransaction ran its call, ExecutionFailure
// when the tx succeeded but the inner call reverted.
const EXECUTION_SUCCESS = ethers.utils.id("ExecutionSuccess(bytes32,uint256)");
const EXECUTION_FAILURE = ethers.utils.id("ExecutionFailure(bytes32,uint256)");
// BaseUpgradeabilityProxy._upgradeTo (inside StrategyProxy.upgrade()).
const UPGRADED = ethers.utils.id("Upgraded(address)");
// Continuity tolerance: 1e-6 relative (0.01 bp), for other txs in the same block.
const CONTINUITY_TOLERANCE = 1000000;
const SKIP_LIB_CHECK = process.env.SKIP_LIB_CHECK === "1";

const strategyAbi = [
  "function implementation() view returns (address)",
  "function nextImplementation() view returns (address)",
  "function nextImplementationTimestamp() view returns (uint256)",
  "function nextImplementationDelay() view returns (uint256)",
  "function leverFlashPremiumBps() view returns (uint256)",
  "function deleverFlashPremiumBps() view returns (uint256)",
  "function feeFloor() view returns (uint256)",
];
const vaultAbi = [
  "function implementation() view returns (address)",
  "function nextImplementation() view returns (address)",
  "function depositCap() view returns (uint256)",
  "function getPricePerFullShare() view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
];
const ptAbi = ["function getIBTRate() view returns (uint256)"];

// --- output + assertions ------------------------------------------------------------

const failures = [];
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
  if (!ok) failures.push(label);
}
const eqAddr = (a, b) => a.toLowerCase() === b.toLowerCase();
function checkAddr(label, actual, expected) {
  check(`${label} == ${expected}`, eqAddr(actual, expected), `actual ${actual}`);
}
function checkUint(label, actual, expected) {
  check(`${label} == ${expected.toString()}`, actual.eq(expected), `actual ${actual.toString()}`);
}
function die(msg) {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}
const iso = (ts) => new Date(Number(ts) * 1000).toISOString();
// Signed difference in basis points, for display only (2 decimals; 4 for the continuity check).
const bps = (a, b, dp = 2) => (b.isZero() ? "n/a"
  : `${(Number(a.sub(b).mul(ethers.BigNumber.from(10).pow(4 + dp)).div(b).toString()) / 10 ** dp).toFixed(dp)} bp`);

// ethers v5 errors embed the request URL, i.e. the API key: never print them raw.
const redact = (text) => String(text).replace(/(\/v2\/)[A-Za-z0-9_-]+/g, "$1<redacted>");
/** The JSON-RPC error message of a failed provider.send, key-free. */
function rpcError(e) {
  let msg = e.error && e.error.message;
  if (!msg && e.body) { try { msg = JSON.parse(e.body).error.message; } catch (_) { /* not JSON */ } }
  return redact(msg || e.reason || e.code || e.message).split("\n")[0].slice(0, 160);
}

function arg(name) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

function requireAddress(name) {
  const v = process.env[name];
  if (!v) die(`${name} is required`);
  try { return ethers.utils.getAddress(v); } catch (e) { die(`${name}=${v} is not an address`); }
}
function requireTxHash(name) {
  const v = process.env[name];
  if (!v) die(`${name} is required for this phase`);
  if (!ethers.utils.isHexString(v, 32)) die(`${name}=${v} is not a tx hash`);
  return v;
}

// --- chain reads ----------------------------------------------------------------------

/**
 * A mined, successful Safe execution: status 1, an ExecutionSuccess log from the Safe, and
 * no ExecutionFailure from it.
 */
async function safeExecReceipt(provider, hash, name) {
  const r = await provider.getTransactionReceipt(hash);
  if (!r) {
    die(`${name} ${hash} not found (not mined yet, or wrong network). It must be the Safe EXECUTION `
      + "tx hash (the on-chain tx), not the safeTxHash shown while collecting signatures.");
  }
  console.log(`  ${name} ${hash}: block ${r.blockNumber}, status ${r.status}, to ${r.to}`);
  check(`${name} succeeded (status 1)`, r.status === 1);
  const fromSafe = (topic) => r.logs.some((l) => eqAddr(l.address, SAFE) && l.topics[0] === topic);
  check(`${name} has an ExecutionSuccess(bytes32,uint256) event from the Safe ${SAFE}`, fromSafe(EXECUTION_SUCCESS),
    fromSafe(EXECUTION_SUCCESS) ? "" : `none in this receipt: ${name} must be the Safe EXECUTION tx hash, not the safeTxHash`);
  check(`${name} has no Safe ExecutionFailure event (the inner call did not revert)`, !fromSafe(EXECUTION_FAILURE));
  if (!eqAddr(r.to || ZERO, SAFE)) {
    console.log(`  WARN  ${name} was not sent to the Safe ${SAFE} directly (relayed?). Checking state anyway.`);
  }
  return r;
}

/**
 * The impl's linked AaveReserveLib must be this build's library and never the stale one,
 * and the impl itself must be exactly this build's strategy (library address aside).
 */
async function checkLinkedLibrary(provider, impl) {
  if (eqAddr(impl, LIVE_STRATEGY_IMPL)) {
    console.log(`  SKIP  linked-library check: ${impl} is the live impl (rollback), linked to ${STALE_LIB} by design`);
    return;
  }
  // Needs no artifacts: the stale library's address must not appear anywhere in the code.
  const code = (await provider.getCode(impl)).toLowerCase();
  check(`impl ${impl} runtime code does not contain the stale library address ${STALE_LIB}`,
    !code.includes(STALE_LIB.slice(2).toLowerCase()));

  const missing = [STRATEGY_ARTIFACT, LIB_ARTIFACT].filter((f) => !fs.existsSync(f));
  if (missing.length) {
    const what = `${missing.join(", ")} not found (npx hardhat compile, same build as the deploy)`;
    if (SKIP_LIB_CHECK) {
      console.log(`  SKIP  linked-library + exact-build check (SKIP_LIB_CHECK=1): ${what}`);
    } else {
      check("linked-library + exact-build check ran (artifacts present)", false, `${what}; SKIP_LIB_CHECK=1 skips it`);
    }
    return;
  }
  if (SKIP_LIB_CHECK) console.log("  NOTE  SKIP_LIB_CHECK=1 ignored: the artifacts are present, so the check runs");
  const artifact = JSON.parse(fs.readFileSync(STRATEGY_ARTIFACT, "utf8"));
  let lib;
  try {
    lib = plan.linkedLibraries(code, artifact)[LIB_FQN];
  } catch (e) {
    // A different build's code at this build's link offsets reads as random addresses.
    check(`impl ${impl} has this build's library link layout`, false, `${e.message}: not this build's ${STRATEGY_NAME}`);
    return;
  }
  if (!lib) {
    check(`impl ${impl} links ${LIB_FQN}`, false, "the artifact has no link reference for it (stale artifacts?)");
    return;
  }
  check(`impl's linked AaveReserveLib != stale ${STALE_LIB}`, !eqAddr(lib, STALE_LIB), `linked ${lib}`);
  let err = null;
  try { await plan.assertImplMatchesBuild(provider, artifact, impl); } catch (e) { err = e.message; }
  check(`impl ${impl} is byte-for-byte this build's ${STRATEGY_NAME} (library address aside)`, !err, err || "runtime code matches");
  const libArtifact = JSON.parse(fs.readFileSync(LIB_ARTIFACT, "utf8"));
  err = null;
  try { await plan.assertLibraryMatchesBuild(provider, libArtifact, lib); } catch (e) { err = e.message; }
  check(`linked AaveReserveLib ${lib} has this build's bytecode`, !err, err || "bytecode matches");
}

/**
 * Vault reads as if the strategy proxy already pointed at `impl`: an eth_call stateDiff
 * override of the EIP-1967 impl slot only. Never `state`, which replaces the proxy's whole
 * storage with just that slot and returns nonsense. `blockOverrides` ({ number, time },
 * hex), when given, is eth_call's 4th param: the view runs on `blockTag`'s state but at
 * that block number and timestamp (the new impl's NAV accrues with block.timestamp).
 */
async function vaultViewsWithImpl(provider, vault, impl, blockTag, blockOverrides) {
  const override = { [STRATEGY_PROXY]: { stateDiff: { [IMPL_SLOT]: ethers.utils.hexZeroPad(impl, 32) } } };
  const tag = typeof blockTag === "number" ? ethers.utils.hexValue(blockTag) : blockTag;
  const call = async (fn, args = []) => {
    const params = [{ to: VAULT_PROXY, data: vault.interface.encodeFunctionData(fn, args) }, tag, override];
    if (blockOverrides) params.push(blockOverrides);
    const raw = await provider.send("eth_call", params);
    return vault.interface.decodeFunctionResult(fn, raw)[0];
  };
  return { ppfs: await call("getPricePerFullShare"), preview: await call("previewRedeem", [ONE]) };
}

/** max(1 wei, value * 1e-6): 0.01 bp. */
const tolerance = (value) => {
  const t = value.div(CONTINUITY_TOLERANCE);
  return t.gt(1) ? t : ethers.BigNumber.from(1);
};

// --- phases ---------------------------------------------------------------------------

async function afterSchedule(ctx) {
  const { provider, strategy, vault, impl } = ctx;
  const r = await safeExecReceipt(provider, requireTxHash("SCHEDULE_TX"), "SCHEDULE_TX");
  const block = await provider.getBlock(r.blockNumber);
  const [next, nextTs, delay, vaultNext] = await Promise.all([
    strategy.nextImplementation(), strategy.nextImplementationTimestamp(),
    strategy.nextImplementationDelay(), vault.nextImplementation(),
  ]);
  console.log(`  schedule block ${r.blockNumber} timestamp ${block.timestamp} (${iso(block.timestamp)}), nextImplementationDelay ${delay}`);
  checkAddr("strategy.nextImplementation()", next, impl);
  checkUint("strategy.nextImplementationTimestamp() (schedule block timestamp + delay)", nextTs, delay.add(block.timestamp));
  checkAddr("vault.nextImplementation()", vaultNext, ZERO);
  await checkLinkedLibrary(provider, impl);
  console.log(`\n  Safe tx 2 is valid only strictly after ${nextTs} (${iso(nextTs)}): from ${iso(nextTs.add(1))} on.`);
}

async function beforeUpgrade(ctx) {
  const { provider, strategy, vault, impl } = ctx;
  const latest = await provider.getBlock("latest");
  const [cur, next, nextTs, vaultNext] = await Promise.all([
    strategy.implementation({ blockTag: latest.number }), strategy.nextImplementation({ blockTag: latest.number }),
    strategy.nextImplementationTimestamp({ blockTag: latest.number }), vault.nextImplementation({ blockTag: latest.number }),
  ]);
  console.log(`  latest block ${latest.number} timestamp ${latest.timestamp} (${iso(latest.timestamp)})`);
  console.log(`  strategy.implementation() ${cur}`);
  check(`latest block timestamp > nextImplementationTimestamp() ${nextTs} (shouldUpgrade uses >)`,
    nextTs.gt(0) && nextTs.lt(latest.timestamp),
    nextTs.gte(latest.timestamp) ? `${nextTs.sub(latest.timestamp).toString()} s still to wait (until after ${iso(nextTs)})` : `timestamp ${latest.timestamp}`);
  checkAddr("strategy.nextImplementation()", next, impl);
  checkAddr("vault.nextImplementation()", vaultNext, ZERO);
  await checkLinkedLibrary(provider, impl);

  // The reference for tx 2: what the vault reports once the proxy points at the new impl,
  // computed against the current storage. The new impl's investedUnderlyingBalance() is
  // live NAV net of the fee it would book, which is exactly what preInteract() + upgrade()
  // leave behind.
  const [ppfsNow, previewNow] = await Promise.all([
    vault.getPricePerFullShare({ blockTag: latest.number }), vault.previewRedeem(ONE, { blockTag: latest.number }),
  ]);
  const expected = await vaultViewsWithImpl(provider, vault, impl, latest.number);
  console.log(`\n  At block ${latest.number}:`);
  console.log(`    old impl: getPricePerFullShare ${ppfsNow}  previewRedeem(1e18) ${previewNow}`);
  console.log(`    new impl (stateDiff override of the strategy impl slot):`);
  console.log(`              getPricePerFullShare ${expected.ppfs}  previewRedeem(1e18) ${expected.preview}`);
  console.log(`    move inside Safe tx 2: ${bps(expected.ppfs, ppfsNow)} on ppfs, ${bps(expected.preview, previewNow)} on previewRedeem`);
  console.log("\n  The share price moves inside Safe tx 2 BY DESIGN: the old impl reports a cached balance,");
  console.log("  and the tx books the carry accrued since the last vault interaction (plus its fee). The");
  console.log("  override value above is the reference for that move, not the rehearsal's -7.6 bp.");
  console.log("  Deposits and hard works during the 12h window move totalAssets legitimately, which is why");
  console.log("  the reference is the share price. Re-run this right before signing.");
  console.log(`\n  EXPECTED_PPFS=${expected.ppfs.toString()}`);
  console.log(`  EXPECTED_PREVIEW_REDEEM=${expected.preview.toString()}`);
  console.log(`  EXPECTED_PPFS_AT=${latest.timestamp}`);
  console.log("  (informational for after-upgrade only; its pass/fail continuity check is UPGRADE_TX)");
}

async function afterUpgrade(ctx) {
  const { provider, strategy, vault, pt, impl } = ctx;
  const latest = await provider.getBlockNumber();
  const at = { blockTag: latest };
  console.log(`  reading at block ${latest}`);
  checkAddr("strategy.implementation()", await strategy.implementation(at), impl);
  checkAddr("strategy.nextImplementation()", await strategy.nextImplementation(at), ZERO);
  if (eqAddr(impl, LIVE_STRATEGY_IMPL)) {
    // Rollback to the old impl: it has none of these getters (they would revert).
    console.log("  SKIP  leverFlashPremiumBps / deleverFlashPremiumBps / feeFloor: STRATEGY_IMPL is the old live impl (rollback)");
  } else {
    checkUint("strategy.leverFlashPremiumBps()", await strategy.leverFlashPremiumBps(at), ethers.constants.Zero);
    const delever = await strategy.deleverFlashPremiumBps(at);
    checkUint("strategy.deleverFlashPremiumBps()", delever, ethers.constants.Zero);
    if (!delever.isZero()) console.log("        (non-zero means Morpho holds less WETH than the strategy's debt: delever falls back to Aave's premium)");
    checkUint("strategy.feeFloor()", await strategy.feeFloor(at), FEE_FLOOR);
  }
  checkAddr("vault.implementation() (unchanged)", await vault.implementation(at), LIVE_VAULT_IMPL);
  checkUint("vault.depositCap()", await vault.depositCap(at), DEPOSIT_CAP);
  const [ibt, preview, ppfs] = await Promise.all([pt.getIBTRate(at), vault.previewRedeem(ONE, at), vault.getPricePerFullShare(at)]);
  console.log(`  vault.getPricePerFullShare() ${ppfs}  previewRedeem(1e18) ${preview}`);
  checkUint("Spectra PT getIBTRate() (previewRedeem(1e18) * 1e9)", ibt, preview.mul(1e9));

  const upgradeTx = process.env.UPGRADE_TX;
  if (upgradeTx) {
    if (!ethers.utils.isHexString(upgradeTx, 32)) die(`UPGRADE_TX=${upgradeTx} is not a tx hash`);
    const r = await safeExecReceipt(provider, upgradeTx, "UPGRADE_TX");
    const txBlock = r.blockNumber;
    // The proxy's own evidence that THIS tx swapped the impl to STRATEGY_IMPL.
    const upgraded = r.logs.filter((l) => eqAddr(l.address, STRATEGY_PROXY) && l.topics[0] === UPGRADED);
    const upgradedTo = upgraded.map((l) => ethers.utils.getAddress(ethers.utils.hexDataSlice(l.topics[1], 12)));
    check(`UPGRADE_TX has the strategy proxy's Upgraded(${impl}) event`, upgradedTo.some((a) => eqAddr(a, impl)),
      upgradedTo.length ? `Upgraded to ${upgradedTo.join(", ")}` : "no Upgraded event from the strategy proxy in this receipt");
    const [implBefore, implAfter] = await Promise.all([
      strategy.implementation({ blockTag: txBlock - 1 }), strategy.implementation({ blockTag: txBlock }),
    ]);
    check(`strategy.implementation() at block ${txBlock - 1} != STRATEGY_IMPL`, !eqAddr(implBefore, impl), `actual ${implBefore}`);
    checkAddr(`strategy.implementation() at block ${txBlock}`, implAfter, impl);

    const [ppfsAfter, previewAfter] = await Promise.all([
      vault.getPricePerFullShare({ blockTag: txBlock }), vault.previewRedeem(ONE, { blockTag: txBlock }),
    ]);
    if (eqAddr(impl, LIVE_STRATEGY_IMPL)) {
      // Rollback: the old impl reports a cached balance, so an override at txBlock-1 cannot
      // reproduce what it reports after tx 2. Print the move only.
      const [ppfsBefore, previewBefore] = await Promise.all([
        vault.getPricePerFullShare({ blockTag: txBlock - 1 }), vault.previewRedeem(ONE, { blockTag: txBlock - 1 }),
      ]);
      console.log(`  share price across the rollback tx 2 (block ${txBlock}), informational (rollback: no continuity pass/fail):`);
      console.log(`    block ${txBlock - 1} (new impl, before): ppfs ${ppfsBefore}  previewRedeem(1e18) ${previewBefore}`);
      console.log(`    block ${txBlock} (old impl, after):  ppfs ${ppfsAfter}  previewRedeem(1e18) ${previewAfter}`);
      console.log(`    move: ${bps(ppfsAfter, ppfsBefore, 4)} on ppfs, ${bps(previewAfter, previewBefore, 4)} on previewRedeem`);
    } else {
      // The override runs on txBlock-1 STATE at txBlock's number and TIME: the new impl's
      // NAV accrues with block.timestamp (~-1.5e-8 per 2 s block), so an unaligned
      // comparison is off by construction.
      const txB = await provider.getBlock(txBlock);
      const blockOverrides = { number: ethers.utils.hexValue(txBlock), time: ethers.utils.hexValue(txB.timestamp) };
      let before;
      let aligned = true;
      try {
        before = await vaultViewsWithImpl(provider, vault, impl, txBlock - 1, blockOverrides);
      } catch (e) {
        aligned = false;
        console.log(`  WARN  the RPC rejected eth_call block overrides (${rpcError(e)}).`);
        console.log(`        Falling back to the override at block ${txBlock - 1}'s own timestamp: tolerance-only comparison.`);
        before = await vaultViewsWithImpl(provider, vault, impl, txBlock - 1);
      }
      const tol = tolerance(ppfsAfter);
      const diff = ppfsAfter.sub(before.ppfs).abs();
      console.log(`  share-price continuity across Safe tx 2 (block ${txBlock}, timestamp ${txB.timestamp}):`);
      console.log(`    block ${txBlock - 1} state with the new impl (override${aligned ? `, at block ${txBlock}'s time` : ", NOT time-aligned"}):`);
      console.log(`                          ppfs ${before.ppfs}  previewRedeem(1e18) ${before.preview}`);
      console.log(`    block ${txBlock} (after tx 2): ppfs ${ppfsAfter}  previewRedeem(1e18) ${previewAfter}`);
      check(`|ppfs after tx 2 - override at txBlock-1| <= max(1 wei, 1e-6 relative = 0.01 bp) = ${tol} wei`
        + (aligned ? " (time-aligned override)" : " (override NOT time-aligned: provider rejected block overrides)"),
        diff.lte(tol),
        `diff ${ppfsAfter.sub(before.ppfs)} wei (${bps(ppfsAfter, before.ppfs, 4)}); previewRedeem diff ${previewAfter.sub(before.preview)} wei (${bps(previewAfter, before.preview, 4)}).`
        + (diff.gt(tol) ? " If another tx touched the vault or strategy in the same block, compare against it before concluding." : ""));
    }
  } else if (process.env.EXPECTED_PPFS) {
    const exp = ethers.BigNumber.from(process.env.EXPECTED_PPFS);
    console.log("  EXPECTED_PPFS comparison, INFORMATIONAL ONLY (no pass/fail): live NAV drifts every block.");
    console.log("  The pass/fail share-price continuity check is UPGRADE_TX=<Safe tx 2 execution hash>.");
    const at = process.env.EXPECTED_PPFS_AT;
    const now = (await provider.getBlock(latest)).timestamp;
    console.log(`    elapsed since the before-upgrade read: ${at ? `${now - Number(at)} s (EXPECTED_PPFS_AT ${at} -> block ${latest} at ${now})` : "unknown (set EXPECTED_PPFS_AT from before-upgrade)"}`);
    console.log(`    current ppfs ${ppfs}, EXPECTED_PPFS ${exp}, diff ${ppfs.sub(exp)} wei (${bps(ppfs, exp, 4)})`);
  } else {
    console.log("  (no UPGRADE_TX or EXPECTED_PPFS: share-price continuity not checked, current ppfs printed above.");
    console.log("   UPGRADE_TX=<Safe tx 2 execution hash> is the pass/fail path.)");
  }
}

// --- main -----------------------------------------------------------------------------

const PHASES = { "after-schedule": afterSchedule, "before-upgrade": beforeUpgrade, "after-upgrade": afterUpgrade };

async function main() {
  const phase = arg("phase");
  if (!PHASES[phase]) die(`usage: node scripts/fold-upgrade-check.js --phase ${Object.keys(PHASES).join("|")}`);
  const impl = requireAddress("STRATEGY_IMPL");
  const url = process.env.RPC_URL
    || (process.env.ALCHEMEY_KEY && `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`);
  if (!url) die("set ALCHEMEY_KEY in .env (or RPC_URL)");
  const provider = new ethers.providers.StaticJsonRpcProvider(url, 8453);
  const { chainId } = await provider.getNetwork();
  if (chainId !== 8453) die(`RPC is chain ${chainId}, not Base (8453)`);
  if ((await provider.getCode(impl)) === "0x") die(`STRATEGY_IMPL ${impl} has no code on Base`);

  console.log(`=== fold upgrade check: ${phase} ===`);
  console.log(`  strategy proxy ${STRATEGY_PROXY}, vault proxy ${VAULT_PROXY}, STRATEGY_IMPL ${impl}\n`);
  const ctx = {
    provider, impl,
    strategy: new ethers.Contract(STRATEGY_PROXY, strategyAbi, provider),
    vault: new ethers.Contract(VAULT_PROXY, vaultAbi, provider),
    pt: new ethers.Contract(SPECTRA_PT, ptAbi, provider),
  };
  await PHASES[phase](ctx);

  if (failures.length) {
    console.error(`\nFAILED ${failures.length} check(s) in ${phase}:`);
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log(`\nAll ${phase} checks passed.`);
}

main().catch((e) => {
  console.error(redact(e && e.stack ? `${e.stack}${e.body ? `\n  body ${e.body}` : ""}` : e));
  process.exit(1);
});
