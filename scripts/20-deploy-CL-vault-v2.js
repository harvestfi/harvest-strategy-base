/**
 * Deploy a CLVaultV2 twin-position vault + AerodromeCLStrategyV2.
 *
 * Differences from scripts/12 (V1) that make a separate script necessary:
 *   1. TWO seed NFTs on one identical range, not one. Mint them with scripts/19-mint-cl-seed-v2.js.
 *   2. CLRebalanceLibV2 must be deployed and LINKED into the strategy before it can be deployed —
 *      the rebalance path lives in a delegatecall library to stay under EIP-170.
 *   3. The strategy is generic. V1 needed a per-pair contract; V2 takes the gauge and reward token
 *      as initializer arguments, so one implementation serves every pair.
 *   4. The vault carries stake-ratio config (target / band / window safety) from initialization.
 *
 * Usage:
 *   CL_CONFIG=scripts/config/usdc-aaplc-v2-w120.json \
 *     npx hardhat run --network mainnet scripts/20-deploy-CL-vault-v2.js
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { type2Transaction } = require("./utils.js");
const { verifyDeployment } = require("./21-verify-cl-vault-v2.js");

const VaultProxy = artifacts.require("VaultProxy");
const StrategyProxy = artifacts.require("StrategyProxy");
const CLProxyDeployer = artifacts.require("CLProxyDeployer");

// Deployed 2026-08-28 and bytecode-verified against this source tree. Used automatically, so the
// atomic deploy+initialize path needs no extra flags. Precedence: CL_DEPLOYER_HELPER env >
// config.reuse.proxyDeployer > this. Whichever wins is bytecode-checked before use, and a mismatch
// ABORTS — a helper that is not this contract could initialize the vault with anything.
const DEFAULT_PROXY_DEPLOYER = "0xa6a4851F496Ab8F0D49b833Fbc5E6Fd243D68b1E";
const Vault = artifacts.require("CLVaultV2");
const Strategy = artifacts.require("AerodromeCLStrategyV2");
const RebalanceLib = artifacts.require("CLRebalanceLibV2");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const IERC721 = artifacts.require("IERC721");
const CLWrapperV2 = artifacts.require("CLWrapperV2");
const Storage = artifacts.require("Storage");

const BN = web3.utils.toBN;

/// A LIBRARY's runtime bytecode embeds its OWN deploy address in the call-protection preamble
/// (`PUSH20 <self>; ADDRESS; EQ`), which the local artifact carries as 20 ZERO bytes — not as a
/// `__$..$__` link placeholder. Verified by diffing: exactly one differing run, 20 bytes at offset
/// 19. Substitute it before comparing, or every library looks stale.
function applySelfAddress(bytecode, address) {
  // Verified by inspecting the artifact: the preamble is ADDRESS(30) PUSH32(7f) <32-byte word> EQ(14),
  // with the 20-byte address RIGHT-ALIGNED in the PUSH32 word — not PUSH20 as one might assume.
  const addr = address.toLowerCase().replace(/^0x/, "");
  return bytecode.replace("307f" + "0".repeat(64), "307f" + "0".repeat(24) + addr);
}

/// Substitute a library address into an artifact's link placeholders so a LINKED contract's local
/// bytecode can be compared against what is actually on chain.
function linkBytecode(bytecode, libAddress) {
  return bytecode.replace(/__\$[0-9a-fA-F]{34}\$__/g, libAddress.toLowerCase().replace(/^0x/, ""));
}

/// Reusing a deployed implementation is only safe while its bytecode still matches this source
/// tree. This repo has already been bitten once by a stale implementation that silently predated a
/// fix, so a reused address is REJECTED unless it matches byte for byte. The metadata-only case is
/// called out separately because it usually means a different compiler run rather than different
/// logic — but it still aborts, because "probably the same" is not a basis for pointing a vault at
/// code you did not verify.
async function assertBytecodeMatches(artifactName, address, libAddress, isLibrary) {
  const artifact = await hre.artifacts.readArtifact(artifactName);
  let expected = artifact.deployedBytecode;
  if (libAddress) expected = linkBytecode(expected, libAddress);
  if (isLibrary) expected = applySelfAddress(expected, address);
  const onChain = await web3.eth.getCode(address);
  if (onChain === "0x" || onChain === "0x0") {
    throw new Error(`reuse ${artifactName}: no code at ${address}`);
  }
  if (onChain.toLowerCase() === expected.toLowerCase()) {
    console.log(`reusing ${artifactName.padEnd(20)} ${address}  (bytecode matches this source)`);
    return;
  }
  // Solidity appends a ~43-byte metadata blob; strip it to classify the difference.
  const strip = (b) => b.slice(0, Math.max(0, b.length - 86));
  const sameLogic = strip(onChain.toLowerCase()) === strip(expected.toLowerCase());
  throw new Error(
    `reuse ${artifactName}: bytecode at ${address} does NOT match this source tree.\n` +
    (sameLogic
      ? "  The difference is metadata only (different compiler run or settings). Still refusing:\n" +
        "  point at a matching build, or drop the reuse entry to deploy a fresh implementation."
      : "  The LOGIC differs — that address predates changes in this working tree.\n" +
        "  Deploying against it would run stale code. Drop the reuse entry to deploy fresh.")
  );
}

function loadConfig() {
  const p = process.env.CL_CONFIG;
  if (!p) throw new Error("CL_CONFIG is required (path to a deploy config json)");
  return JSON.parse(fs.readFileSync(path.resolve(p), "utf8"));
}

async function main() {
  if (typeof artifacts === "undefined") throw new Error("run via `npx hardhat run`");
  const config = loadConfig();
  const addresses = require(path.resolve(config.addressesPath || "test/test-config.js"));
  const [deployer] = await web3.eth.getAccounts();
  console.log(`deployer      ${deployer}`);
  console.log(`config        ${config.name}`);

  // ---- seed pair -------------------------------------------------------------------------
  const npm = await IPosManager.at(config.posManager);
  const stakedId = config.posId;
  const bufferId = config.bufferPosId;
  if (!stakedId || !bufferId) throw new Error("config needs both posId (staked) and bufferPosId");
  const a = await npm.positions(stakedId);
  const b = await npm.positions(bufferId);
  console.log(`staked seed   ${stakedId}  range [${a.tickLower},${a.tickUpper}]  L=${a.liquidity}`);
  console.log(`buffer seed   ${bufferId}  range [${b.tickLower},${b.tickUpper}]  L=${b.liquidity}`);
  // initializeVault checks this too, but a mismatch here means the seeds are unusable and the
  // deployer should stop before spending anything else.
  if (a.tickLower.toString() !== b.tickLower.toString() || a.tickUpper.toString() !== b.tickUpper.toString()) {
    throw new Error("seed positions do not share a range");
  }
  const nft = await IERC721.at(config.posManager);
  for (const id of [stakedId, bufferId]) {
    const owner = await nft.ownerOf(id);
    if (owner.toLowerCase() !== deployer.toLowerCase()) throw new Error(`seed ${id} is owned by ${owner}, not the deployer`);
  }

  // ---- bridge storage --------------------------------------------------------------------
  // Same mechanism as V1: the vault's setters are onlyGovernance, and the deployer is not real
  // governance, so configuration happens against a bridge Storage the deployer controls and the
  // whole stack is flipped to the real Storage at the end.
  const useSetup = config.useSetupStorage !== false;
  let storageAddr = addresses.Storage;
  if (useSetup) {
    const provided = config.setupStorageAddress || addresses.SetupStorage;
    if (!provided) throw new Error("useSetupStorage is on but no SetupStorage address is configured");
    const bridgeGov = await (await Storage.at(provided)).governance();
    if (bridgeGov.toLowerCase() !== deployer.toLowerCase()) {
      throw new Error(`bridge Storage ${provided} governance is ${bridgeGov}, not the deployer`);
    }
    storageAddr = provided;
    console.log(`bridge storage ${storageAddr}`);
  }

  // ---- library + implementations ---------------------------------------------------------
  // Implementations and the library are stateless and shared: redeploying them per vault is pure
  // cost. Any of the three may be pinned in config.reuse, and each pinned address is checked against
  // this source tree before it is used.
  const reuse = config.reuse || {};

  let libAddr = reuse.rebalanceLibrary;
  if (libAddr) {
    await assertBytecodeMatches("CLRebalanceLibV2", libAddr, null, true);
  } else {
    libAddr = (await type2Transaction(RebalanceLib.new)).creates;
    console.log(`CLRebalanceLibV2   ${libAddr}  (deployed)`);
  }
  // Hardhat's truffle5 plugin rejects link-by-name and requires a TruffleContract INSTANCE, and
  // type2Transaction returns an ethers tx (only `.creates` is meaningful) — so re-attach first.
  await Strategy.link(await RebalanceLib.at(libAddr));

  let vaultImplAddr = reuse.vaultImplementation;
  if (vaultImplAddr) {
    await assertBytecodeMatches("CLVaultV2", vaultImplAddr);
  } else {
    vaultImplAddr = (await type2Transaction(Vault.new)).creates;
    console.log(`CLVaultV2 impl     ${vaultImplAddr}  (deployed)`);
  }
  // ATOMIC BY DEFAULT. Deploying the proxy and initializing it as two transactions leaves it
  // sitting on-chain, uninitialized and public, for at least a block. `initializeVault` is
  // `initializer`-guarded but otherwise permissionless, so anyone can take it first and burn the
  // proxy. On Base that needs no mempool access — the creation is public the moment it lands and
  // the attacker takes the next block. Observed in production on 2026-08-28.
  // Set CL_ATOMIC=0 to fall back to the old two-step path.
  const atomic = process.env.CL_ATOMIC !== "0";
  let helper = null;
  if (atomic) {
    const given = process.env.CL_DEPLOYER_HELPER || (config.reuse || {}).proxyDeployer || DEFAULT_PROXY_DEPLOYER;
    if (given) {
      helper = await CLProxyDeployer.at(given);
      // NOT a library — passing isLibrary here would apply the call-protection self-address rewrite
      // to a contract that has no such preamble, and the check would fail on a correct deployment.
      await assertBytecodeMatches("CLProxyDeployer", given, null, false);
    } else {
      helper = await CLProxyDeployer.new();
      console.log(`CLProxyDeployer    ${helper.address}  (deployed — record it as reuse.proxyDeployer)`);
    }
  }

  let vaultAddr;
  if (atomic) {
    for (const id of [stakedId, bufferId]) await type2Transaction(nft.approve, helper.address, id, { from: deployer });
    const s2 = config.stake || {};
    const rc = await type2Transaction(helper.deployVault, vaultImplAddr, storageAddr, stakedId, bufferId,
      config.posManager, config.targetWidth, s2.targetStakedBps || 8000, s2.bandBps || 1000, s2.windowSafety || 30);
    const receipt = await web3.eth.getTransactionReceipt(rc.hash);
    const ev = receipt.logs.find(l => l.topics[0] === web3.utils.keccak256("VaultDeployed(address,address,uint256)"));
    if (!ev) throw new Error("atomic deploy: VaultDeployed not emitted");
    vaultAddr = web3.utils.toChecksumAddress("0x" + ev.topics[1].slice(26));
    console.log(`CLVaultV2 proxy    ${vaultAddr}  (deployed AND initialized in one tx)`);
  } else {
    const vaultProxyTx = await type2Transaction(VaultProxy.new, vaultImplAddr);
    vaultAddr = vaultProxyTx.creates;
    console.log(`CLVaultV2 proxy    ${vaultAddr}`);
  }
  const vault = await Vault.at(vaultAddr);

  // ---- initialize the vault with BOTH seeds ----------------------------------------------
  const s = config.stake || {};
  const targetBps = s.targetStakedBps || 8000;
  const bandBps = s.bandBps || 1000;
  const windowSafety = s.windowSafety || 30;
  if (!atomic) {
    for (const id of [stakedId, bufferId]) await type2Transaction(nft.approve, vaultAddr, id, { from: deployer });
    await type2Transaction(
      vault.initializeVault, storageAddr, stakedId, bufferId, config.posManager,
      config.targetWidth, targetBps, bandBps, windowSafety
    );
  }
  console.log(`initialized: targetWidth=${config.targetWidth} target=${targetBps}bps band=${bandBps}bps safety=${windowSafety}s`);

  // ---- rebalance configuration ------------------------------------------------------------
  const r = config.rebalance;
  await type2Transaction(vault.setRebalanceHelper, config.rebalanceHelper);
  await type2Transaction(vault.setRebalanceSafetyConfig, r.maxSwapBps, r.maxSlippageBps, r.twapWindow, r.maxTwapDeviationBps);
  await type2Transaction(vault.setRebalanceConfig, r.deviation, r.cooldown, r.executor);
  await type2Transaction(vault.setLanePause, false, false, false, false);
  console.log(`rebalance cfg: executor=${r.executor} cooldown=${r.cooldown}s deviation=${r.deviation}`);

  // ---- strategy ---------------------------------------------------------------------------
  let stratImplAddr = reuse.strategyImplementation;
  if (stratImplAddr) {
    // Linked contract: the on-chain bytecode carries the library address where the artifact has a
    // placeholder, so the comparison has to substitute it first.
    await assertBytecodeMatches("AerodromeCLStrategyV2", stratImplAddr, libAddr);
  } else {
    stratImplAddr = (await type2Transaction(Strategy.new)).creates;
    console.log(`StrategyV2 impl    ${stratImplAddr}  (deployed)`);
  }
  let strategyAddr;
  if (atomic) {
    const rc = await type2Transaction(helper.deployStrategy, stratImplAddr, storageAddr, vaultAddr,
      config.gauge, config.strategy.rewardToken);
    const receipt = await web3.eth.getTransactionReceipt(rc.hash);
    const ev = receipt.logs.find(l => l.topics[0] === web3.utils.keccak256("StrategyDeployed(address,address)"));
    if (!ev) throw new Error("atomic deploy: StrategyDeployed not emitted");
    strategyAddr = web3.utils.toChecksumAddress("0x" + ev.topics[1].slice(26));
  } else {
    const stratProxyTx = await type2Transaction(StrategyProxy.new, stratImplAddr);
    strategyAddr = stratProxyTx.creates;
    await type2Transaction((await Strategy.at(strategyAddr)).initializeBaseStrategy,
      storageAddr, vaultAddr, config.gauge, config.strategy.rewardToken);
  }
  const strategy = await Strategy.at(strategyAddr);
  console.log(`StrategyV2 proxy   ${strategyAddr}  gauge=${config.gauge}`);
  if (config.strategy.minRewardToCompound) {
    await type2Transaction(strategy.setMinRewardToCompound, config.strategy.rewardToken, config.strategy.minRewardToCompound);
  }

  await type2Transaction(vault.setStrategy, strategyAddr);
  // Hands both NFTs to the strategy and stakes the staked one. Until this runs the vault holds the
  // positions and nothing is earning AERO.
  await type2Transaction(vault.restakePosition);
  const stakedOwner = await nft.ownerOf(stakedId);
  if (stakedOwner.toLowerCase() !== config.gauge.toLowerCase()) {
    // stakePosition() returns early rather than reverting on several conditions, so a successful
    // transaction is NOT evidence the position reached the gauge.
    throw new Error(`restake did not land: posId ${stakedId} is owned by ${stakedOwner}, expected gauge ${config.gauge}`);
  }
  console.log(`staked: posId owner = ${stakedOwner} (gauge, confirmed)`);
  console.log(`totalLiquidity=${(await vault.totalLiquidity()).toString()} stakedBps=${(await vault.stakedRatioBps()).toString()}`);

  // ---- wrappers ---------------------------------------------------------------------------
  // Two single-asset (ERC4626-style) zap wrappers per vault, one per token side, exactly as V1.
  // Constructed against the BRIDGE storage like everything else, then flipped with the rest.
  let wrapper0 = null;
  let wrapper1 = null;
  if (config.wrappers && config.wrappers.deploy) {
    wrapper0 = await CLWrapperV2.at((await type2Transaction(CLWrapperV2.new, storageAddr, vaultAddr, true)).creates);
    wrapper1 = await CLWrapperV2.at((await type2Transaction(CLWrapperV2.new, storageAddr, vaultAddr, false)).creates);
    console.log(`CLWrapperV2 token0 ${wrapper0.address}  (asset = ${await wrapper0.asset()})`);
    console.log(`CLWrapperV2 token1 ${wrapper1.address}  (asset = ${await wrapper1.asset()})`);
    // previewSafetyBps now affects the ERC4626 DISPLAY views only. deposit/redeem derive their
    // execution floor from post-swap state, so a mis-tuned buffer can no longer make a call revert.
    // Still worth setting above the 25bps default: ERC4626 asks previewDeposit to return no more
    // than the actual mint, and on a pair with real swap impact 25bps does not cover it.
    const safety = (config.wrappers && config.wrappers.previewSafetyBps) || 100;
    for (const w of [wrapper0, wrapper1]) await type2Transaction(w.setPreviewSafetyBps, safety);
    console.log(`wrapper previewSafetyBps set to ${safety}`);
  }

  // ---- finalize to real storage -----------------------------------------------------------
  if (useSetup && config.finalizeStorage !== false) {
    if (storageAddr.toLowerCase() === addresses.Storage.toLowerCase()) throw new Error("nothing to finalize");
    const flip = [["vault", vault], ["strategy", strategy]];
    if (wrapper0) flip.push(["wrapper0", wrapper0], ["wrapper1", wrapper1]);
    for (const [label, c] of flip) {
      await type2Transaction(c.setStorage, addresses.Storage);
      console.log(`  ${label} storage -> ${addresses.Storage}`);
    }
    // Verify the flip actually took, rather than trusting the transactions succeeded.
    const expectedGov = web3.utils.toChecksumAddress(addresses.Governance);
    for (const [label, c] of flip) {
      const g = web3.utils.toChecksumAddress(await c.governance());
      if (g !== expectedGov) throw new Error(`finalize: ${label}.governance() = ${g}, expected ${expectedGov}`);
    }
    console.log("finalize verified: vault and strategy both resolve governance through the real Storage");
  } else {
    console.log("finalize SKIPPED — stack is still on the bridge Storage");
  }

  const snapshot = {
    name: config.name, chain: "base", deployedAt: new Date().toISOString(), deployer,
    vault: vaultAddr, vaultImplementation: vaultImplAddr,
    strategy: strategyAddr, strategyImplementation: stratImplAddr,
    rebalanceLibrary: libAddr, rebalanceHelper: config.rebalanceHelper,
    posManager: config.posManager, stakedPosId: stakedId, bufferPosId: bufferId,
    gauge: config.gauge, targetWidth: config.targetWidth,
    stake: { targetStakedBps: targetBps, bandBps, windowSafety },
    rebalance: r,
    wrappers: wrapper0 ? { token0: wrapper0.address, token1: wrapper1.address } : null,
    // The wrappers were CONSTRUCTED against the bridge storage, not addresses.Storage. Verification
    // needs the exact constructor arg, and getting this wrong is why V1's wrapper verification failed.
    wrapperConstructorStorage: storageAddr,
    setupStorage: useSetup ? storageAddr : null,
  };
  const out = config.snapshotPath || `scripts/deployments/cl/${config.name}.json`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2));
  console.log(`\nsnapshot -> ${out}`);

  // Verify last: the deployment is already durable and recorded by this point, so a flaky explorer
  // API can never cost a redeploy. Re-runnable standalone via scripts/21 with the same snapshot.
  if (config.verify) {
    console.log("");
    try {
      await verifyDeployment(snapshot);
    } catch (e) {
      console.log(`verification step failed: ${(e.message || "").slice(0, 200)}`);
      console.log(`re-run with: CL_SNAPSHOT=${out} npx hardhat run --network mainnet scripts/21-verify-cl-vault-v2.js`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
