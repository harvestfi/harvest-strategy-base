/**
 * Resume a CLVaultV2 deployment that died part-way through scripts/20.
 *
 * Every step is IDEMPOTENT: the on-chain state is read first and only the missing work is done, so
 * this is safe to run repeatedly (e.g. if it runs out of gas money again). It never re-deploys
 * anything — a half-finished deploy has live contracts holding real positions, and deploying a
 * second set would strand the first.
 *
 * The step that matters most is the storage finalize. Until it runs, the vault, strategy and
 * wrappers are all governed by the DEPLOYER via the bridge Storage rather than by the multisig.
 * That is a deliberately temporary state and should not be left sitting.
 *
 *   CL_CONFIG=scripts/config/usdc-aaplc-v2-w120.json \
 *   CL_VAULT=0x… CL_WRAPPER0=0x… CL_WRAPPER1=0x… \
 *     npx hardhat run --network mainnet scripts/22-resume-cl-vault-v2.js
 *
 * CL_STRATEGY is read from the vault. Implementation/library addresses come from config.reuse
 * unless overridden with CL_VAULT_IMPL / CL_STRATEGY_IMPL / CL_LIB.
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { type2Transaction } = require("./utils.js");
const { verifyDeployment } = require("./21-verify-cl-vault-v2.js");

const Vault = artifacts.require("CLVaultV2");
const Strategy = artifacts.require("AerodromeCLStrategyV2");
const Wrapper = artifacts.require("CLWrapperV2");
const IERC721 = artifacts.require("IERC721");

function need(n) { const v = process.env[n]; if (!v) throw new Error(`${n} is required`); return v; }

async function main() {
  const config = JSON.parse(fs.readFileSync(path.resolve(need("CL_CONFIG")), "utf8"));
  const addresses = require(path.resolve(config.addressesPath || "test/test-config.js"));
  const [deployer] = await web3.eth.getAccounts();
  const realStorage = addresses.Storage;
  const realGov = web3.utils.toChecksumAddress(addresses.Governance);

  const vaultAddr = need("CL_VAULT");
  const vault = await Vault.at(vaultAddr);
  const strategyAddr = process.env.CL_STRATEGY || (await vault.strategy());
  const strategy = await Strategy.at(strategyAddr);
  const w0Addr = process.env.CL_WRAPPER0, w1Addr = process.env.CL_WRAPPER1;

  console.log(`resuming ${config.name}`);
  console.log(`  deployer ${deployer}  balance ${web3.utils.fromWei(await web3.eth.getBalance(deployer))} ETH`);
  console.log(`  vault    ${vaultAddr}`);
  console.log(`  strategy ${strategyAddr}`);

  // --- sanity: the core deploy must genuinely be complete before we finish the tail ------------
  if ((await vault.strategy()).toLowerCase() !== strategyAddr.toLowerCase()) {
    throw new Error("vault.strategy() does not match — the deploy did not get far enough to resume");
  }
  const nft = await IERC721.at(config.posManager);
  const owner = await nft.ownerOf(await vault.posId());
  if (owner.toLowerCase() !== config.gauge.toLowerCase()) {
    throw new Error(`staked position is at ${owner}, not the gauge — re-run the stake before finalizing`);
  }
  console.log(`  staked OK, totalLiquidity=${(await vault.totalLiquidity()).toString()} stakedBps=${(await vault.stakedRatioBps()).toString()}`);

  // Declared here rather than further down: the wrapper deploy below constructs against it,
  // and `const` is not hoisted — using it before this line would be a TDZ ReferenceError.
  const bridge = config.setupStorageAddress || addresses.SetupStorage;

  // --- wrappers: deploy the missing ones, then tune -------------------------------------------
  // A deploy that dies BEFORE the wrapper step leaves none to pass in, and this script used to only
  // tune wrappers it was handed — so that case could not be resumed at all. Deploy them here when
  // the config asks for them and none were supplied. Constructed against the BRIDGE storage, same
  // as scripts/20 does, so the finalize below flips them with everything else.
  const wrappers = [];
  let mkW0 = w0Addr, mkW1 = w1Addr;
  if (!mkW0 && !mkW1 && config.wrappers && config.wrappers.deploy) {
    console.log("  no wrappers supplied and config asks for them — deploying");
    mkW0 = (await type2Transaction(Wrapper.new, bridge, vaultAddr, true)).creates;
    mkW1 = (await type2Transaction(Wrapper.new, bridge, vaultAddr, false)).creates;
    console.log(`  CLWrapperV2 token0 ${mkW0}`);
    console.log(`  CLWrapperV2 token1 ${mkW1}`);
  }
  if (mkW0) wrappers.push(["wrapper0", await Wrapper.at(mkW0)]);
  if (mkW1) wrappers.push(["wrapper1", await Wrapper.at(mkW1)]);
  for (const [label, w] of wrappers) {
    const v = await w.vault();
    if (v.toLowerCase() !== vaultAddr.toLowerCase()) {
      throw new Error(`${label} points at ${v}, not ${vaultAddr}`);
    }
  }
  const safety = (config.wrappers && config.wrappers.previewSafetyBps) || 100;
  for (const [label, w] of wrappers) {
    const cur = (await w.previewSafetyBps()).toString();
    if (cur === String(safety)) { console.log(`  ${label} previewSafetyBps already ${cur}`); continue; }
    await type2Transaction(w.setPreviewSafetyBps, safety);
    console.log(`  ${label} previewSafetyBps ${cur} -> ${safety}`);
  }

  // --- storage finalize ------------------------------------------------------------------------
  if (config.finalizeStorage !== false) {
    const all = [["vault", vault], ["strategy", strategy], ...wrappers];
    for (const [label, c] of all) {
      const g = web3.utils.toChecksumAddress(await c.governance());
      if (g === realGov) { console.log(`  ${label} already finalized`); continue; }
      await type2Transaction(c.setStorage, realStorage);
      console.log(`  ${label} storage -> ${realStorage}`);
    }
    for (const [label, c] of all) {
      const g = web3.utils.toChecksumAddress(await c.governance());
      if (g !== realGov) throw new Error(`finalize: ${label}.governance() = ${g}, expected ${realGov}`);
    }
    console.log("  finalize verified: all contracts resolve governance through the real Storage");
  }

  // --- snapshot --------------------------------------------------------------------------------
  const reuse = config.reuse || {};
  const snapshot = {
    name: config.name, chain: "base", deployedAt: new Date().toISOString(), deployer,
    resumedBy: "scripts/22-resume-cl-vault-v2.js",
    vault: vaultAddr,
    vaultImplementation: process.env.CL_VAULT_IMPL || reuse.vaultImplementation,
    strategy: strategyAddr,
    strategyImplementation: process.env.CL_STRATEGY_IMPL || reuse.strategyImplementation,
    rebalanceLibrary: process.env.CL_LIB || reuse.rebalanceLibrary,
    rebalanceHelper: config.rebalanceHelper,
    posManager: config.posManager, stakedPosId: config.posId, bufferPosId: config.bufferPosId,
    gauge: config.gauge, targetWidth: config.targetWidth,
    stake: config.stake, rebalance: config.rebalance,
    wrappers: mkW0 && mkW1 ? { token0: mkW0, token1: mkW1 } : null,
    wrapperConstructorStorage: bridge,
    setupStorage: bridge,
  };
  const out = config.snapshotPath || `scripts/deployments/cl/${config.name}.json`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2));
  console.log(`\nsnapshot -> ${out}`);

  if (config.verify) {
    console.log("");
    try { await verifyDeployment(snapshot); }
    catch (e) {
      console.log(`verification failed: ${(e.message || "").slice(0, 200)}`);
      console.log(`re-run: CL_SNAPSHOT=${out} npx hardhat run --network mainnet scripts/21-verify-cl-vault-v2.js`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
