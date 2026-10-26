// The governance plan for upgrading the LIVE Aave cbETH/WETH fold deployment on Base,
// shared by scripts/16-prepare-fold-upgrade.js (prints it and writes the Transaction
// Builder files), scripts/fold-upgrade-check.js (constants) and
// test/aave/fold/upgrade-rehearsal-fork.js (executes it through the real Safe on a fork).
// Keeping one source means the runbook's calldata is exactly the calldata that was rehearsed.
// strategyOnlyPlan() is the rollout that ships (strategyOnlyFiles() maps it to the
// Transaction Builder files); governancePlan() (strategy + vault) is kept for the earlier
// rehearsal history.
//
// No hardhat import: plain ethers v5, so it can be required from scripts and tests alike.

const { ethers } = require("ethers");

const STRATEGY_PROXY = "0xcfd2f32E6d533653cEd5Ba7E5fe1a76C3c626757";
const VAULT_PROXY = "0xE78285A51f51916F2311B7017Db036D8351F3Cf9";
// Gnosis Safe 1.4.1 (2-of-3): governance of both proxies, the Controller and ChainlinkChecker.
const SAFE = "0x920b1aCb7618B553324aa0F71620226FA2e09870";
// Canonical MultiSendCallOnly 1.4.1. The Safe delegatecalls it (operation 1); it only
// performs plain calls, so every inner call runs with msg.sender == SAFE.
const MULTISEND_CALL_ONLY = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
const CONTROLLER = "0xF90FF0F7c8Db52bF1bF869F74226eAD125EFa745";
// CLChainlinkChecker: its governance is the ULOwner EOA (own Storage 0x8dE4B34D), NOT the
// Safe. Any call to it inside a Safe batch reverts the whole batch.
const CL_CHECKER = "0xaba4ba582E04B729ABCd2Bae0d7c14fe21C9F510";
const UL_OWNER = "0x6a74649aCFD7822ae8Fb78463a9f2192752E5Aa2";
// ChainlinkChecker (governance = SAFE, a Controller hardWorker): the keeper whose
// performUpkeep forwards Controller.doHardWork payloads, which is what the fold
// strategy's checker() returns.
const CHAINLINK_CHECKER = "0x81c733905e2Fd878fda137802E7bF578E3CDfbF7";
// Spectra PT-fWETH(WETH)-2027/04/19: holds vault shares and reads vault.previewRedeem(1e18)
// as its IBT rate. Any drop of that value permanently scales its ptRate down.
const SPECTRA_PT = "0xb43326e29631891d069ed21970b09fca0b624cee";

// The library linked into impl 0x74ae6e11. It has no AaveReserveLib.flash, so a strategy
// linked to it reverts every lever and delever, i.e. every deposit and withdrawal.
const STALE_LIB = "0x2B19aB8A9b31798f2536c440B596816e2aa10033";
const LIB_FQN = "contracts/strategies/aave/fold/AaveReserveLib.sol:AaveReserveLib";
const STRATEGY_NAME = "Aave2AssetFoldStrategyMainnet_ETH_cbETH";
const LIVE_STRATEGY_IMPL = "0x74ae6e11a89ae6dfe3a304f7881b67a93187ed3f";
const LIVE_VAULT_IMPL = "0x4942b35fdad915e6ec6c700b0d377beb4639eab8";
// EIP-1967 implementation slot: where both proxies keep their impl. An eth_call stateDiff
// override of it on the strategy proxy previews the new impl against live storage.
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// Transaction Builder version stamped into the JSON files (same as scripts/keeper).
const TX_BUILDER_VERSION = "1.16.5";

const iface = new ethers.utils.Interface([
  "function scheduleUpgrade(address impl)",
  "function upgrade()",
  "function preInteract()",
  "function removeVault(address v)",
  "function addVault(address v)",
  "function multiSend(bytes transactions)",
]);

// MultiSend packing: operation (uint8) | to (address) | value (uint256) | data length (uint256) | data.
function encodeMultiSend(calls) {
  const packed = ethers.utils.hexConcat(calls.map((c) => ethers.utils.solidityPack(
    ["uint8", "address", "uint256", "uint256", "bytes"],
    [0, c.to, c.value || 0, ethers.utils.hexDataLength(c.data), c.data],
  )));
  return iface.encodeFunctionData("multiSend", [packed]);
}

function safeBatch(label, calls) {
  return { label, to: MULTISEND_CALL_ONLY, value: 0, operation: 1, data: encodeMultiSend(calls), calls };
}

function safeCall(label, call) {
  return { label, to: call.to, value: 0, operation: 0, data: call.data, calls: [call] };
}

// One inner call: target, human-readable description, calldata.
const c = (to, desc, fn, args = []) => ({ to, desc, data: iface.encodeFunctionData(fn, args) });

/**
 * The full rollout for the given new implementations.
 *  - safeTxs: the Safe transactions, in execution order. Each has the exact
 *    {to, value, operation, data} to propose, and its inner calls.
 *  - eoaTxs: transactions that must NOT go through the Safe.
 *  - optionalSafeTxs: not part of the upgrade; listed for a governance decision.
 */
function governancePlan({ strategyImpl, vaultImpl }) {
  const safeTxs = [
    safeBatch("Safe tx 1 (schedule both upgrades; starts the 12h timelock)", [
      c(STRATEGY_PROXY, `strategy.scheduleUpgrade(${strategyImpl})`, "scheduleUpgrade", [strategyImpl]),
      c(VAULT_PROXY, `vault.scheduleUpgrade(${vaultImpl})`, "scheduleUpgrade", [vaultImpl]),
    ]),
    safeBatch("Safe tx 2 (strictly after the 12h; ONE batch: accrue on the old impl, then swap the strategy)", [
      c(STRATEGY_PROXY, "strategy.preInteract()  [old impl books fee + resyncs storedBalance]", "preInteract"),
      c(STRATEGY_PROXY, "StrategyProxy.upgrade()  [runs finalizeUpgrade() as the Safe]", "upgrade"),
    ]),
    safeCall("Safe tx 3 (after Safe tx 2)", c(VAULT_PROXY, "VaultProxy.upgrade()  [runs finalizeUpgrade() as the Safe]", "upgrade")),
  ];
  const eoaTxs = [{
    label: "ULOwner EOA tx (separate signer, independent of the Safe txs and of their order)",
    from: UL_OWNER, to: CL_CHECKER, value: 0,
    desc: `CLChainlinkChecker.removeVault(${STRATEGY_PROXY})`,
    data: iface.encodeFunctionData("removeVault", [STRATEGY_PROXY]),
  }];
  const optionalSafeTxs = [
    safeCall("Optional Safe tx (decision, not part of the upgrade): give the strategy a keeper that can run its checker payload",
      c(CHAINLINK_CHECKER, `ChainlinkChecker.addVault(${STRATEGY_PROXY})`, "addVault", [STRATEGY_PROXY])),
  ];
  return { safeTxs, eoaTxs, optionalSafeTxs };
}

/**
 * The strategy-only rollout (the one that ships): the vault keeps its live impl 0x4942b35f
 * and nothing is scheduled on it, the CL checker entry is already gone, and the keeper is
 * wired separately (scripts/keeper). Same tx shape as governancePlan(), so the rehearsal
 * executes these objects as they are.
 *  - safeTxs[0]: a single call, schedules the strategy impl (starts the 12h timelock).
 *  - safeTxs[1]: ONE MultiSend batch, preInteract() on the old impl then upgrade(). Both
 *    calldatas are impl-independent, so the same batch also completes a rollback.
 *  - rollbackSafeTxs[0]: schedules the live impl again (then safeTxs[1] after 12h).
 */
function strategyOnlyPlan({ strategyImpl }) {
  const impl = ethers.utils.getAddress(strategyImpl); // throws on a malformed address
  if (impl === ethers.constants.AddressZero) throw new Error("strategyImpl is the zero address");
  const safeTxs = [
    safeCall("Safe tx 1 (schedule the strategy upgrade; starts the 12h timelock)",
      c(STRATEGY_PROXY, `strategy.scheduleUpgrade(${impl})`, "scheduleUpgrade", [impl])),
    safeBatch("Safe tx 2 (strictly after the 12h; ONE batch: accrue on the old impl, then swap the strategy)", [
      c(STRATEGY_PROXY, "strategy.preInteract()  [old impl books fee + resyncs storedBalance]", "preInteract"),
      c(STRATEGY_PROXY, "StrategyProxy.upgrade()  [runs finalizeUpgrade() as the Safe]", "upgrade"),
    ]),
  ];
  const live = ethers.utils.getAddress(LIVE_STRATEGY_IMPL);
  const rollbackSafeTxs = [
    safeCall("Rollback: schedule the live impl again",
      c(STRATEGY_PROXY, `strategy.scheduleUpgrade(${live})`, "scheduleUpgrade", [live])),
  ];
  return { safeTxs, rollbackSafeTxs };
}

/**
 * The Transaction Builder files of the strategy-only rollout: [{ file, description, tx }],
 * in execution order, tx from strategyOnlyPlan(). The single source for the file -> tx
 * mapping: scripts/16 writes exactly these files and the rehearsal executes exactly these
 * txs, so a file can never carry a different call than the one that was rehearsed.
 */
function strategyOnlyFiles({ strategyImpl }) {
  const { safeTxs: [tx1, tx2], rollbackSafeTxs: [rollback] } = strategyOnlyPlan({ strategyImpl });
  const impl = ethers.utils.getAddress(strategyImpl);
  const live = ethers.utils.getAddress(LIVE_STRATEGY_IMPL);
  return [
    { file: "safe-tx-1-schedule.json",
      description: `Fold strategy: scheduleUpgrade(${impl}) on ${STRATEGY_PROXY}; starts the 12h timelock`, tx: tx1 },
    { file: "safe-tx-2-upgrade.json",
      description: `Fold strategy: preInteract() then upgrade() on ${STRATEGY_PROXY}, ONE batch, strictly after nextImplementationTimestamp`, tx: tx2 },
    { file: "safe-rollback-schedule.json",
      description: `Fold strategy rollback: scheduleUpgrade(${live}) on ${STRATEGY_PROXY}`, tx: rollback },
  ];
}

/**
 * Safe Transaction Builder JSON for one plan tx. It lists the RAW inner calls: for a
 * 2-call tx Builder itself wraps them in a delegatecall to MultiSendCallOnly. Never put a
 * pre-encoded multiSend(bytes) call here: Builder would send it with operation 0, the
 * inner calls would run with msg.sender == the MultiSend contract, and preInteract() and
 * upgrade() (both governance-only) would revert.
 */
function txBuilderFile(name, description, tx) {
  return {
    version: "1.0",
    chainId: "8453",
    createdAt: Date.now(),
    meta: { name, description, txBuilderVersion: TX_BUILDER_VERSION, createdFromSafeAddress: SAFE },
    transactions: tx.calls.map((call) => ({
      to: call.to, value: "0", data: call.data, contractMethod: null, contractInputsValues: null,
    })),
  };
}

// --- AaveReserveLib guards ------------------------------------------------------------

// A library's runtime code starts with PUSH20 <its own address> (call protection), which
// the artifact leaves zeroed. Mask those 20 bytes and the rest must match the build.
function maskLibraryCode(code) {
  const c = code.toLowerCase();
  return c.slice(0, 4) + "0".repeat(40) + c.slice(44);
}

/** Throws unless `address` holds exactly this build's AaveReserveLib. */
async function assertLibraryMatchesBuild(provider, libArtifact, address) {
  const onchain = await provider.getCode(address);
  if (onchain === "0x") throw new Error(`AaveReserveLib ${address} has no code`);
  if (maskLibraryCode(onchain) !== libArtifact.deployedBytecode.toLowerCase()) {
    throw new Error(`AaveReserveLib ${address} is not this build's AaveReserveLib (stale library?). `
      + `A strategy linked to it would revert every deposit and withdrawal.`);
  }
}

/** The library addresses embedded in a deployed strategy impl's runtime code. */
function linkedLibraries(runtimeCode, strategyArtifact) {
  const out = {};
  for (const [file, libs] of Object.entries(strategyArtifact.deployedLinkReferences)) {
    for (const [name, refs] of Object.entries(libs)) {
      const addrs = new Set(refs.map(({ start, length }) =>
        ethers.utils.getAddress("0x" + runtimeCode.slice(2 + start * 2, 2 + (start + length) * 2))));
      if (addrs.size !== 1) throw new Error(`${file}:${name} is linked to ${addrs.size} different addresses`);
      out[`${file}:${name}`] = [...addrs][0];
    }
  }
  return out;
}

/**
 * `bytecode` (an artifact's deployedBytecode, placeholders in place of library addresses)
 * with `libs` ({ "file:Name": address }) written at every offset of `linkReferences`.
 * Throws when a referenced library has no address in `libs`.
 */
function linkBytecode(bytecode, linkReferences, libs) {
  let hex = bytecode.toLowerCase();
  for (const [file, names] of Object.entries(linkReferences || {})) {
    for (const [name, refs] of Object.entries(names)) {
      const addr = libs[`${file}:${name}`];
      if (!addr) throw new Error(`no address for linked library ${file}:${name}`);
      const a = ethers.utils.getAddress(addr).slice(2).toLowerCase();
      for (const { start, length } of refs) {
        if (length !== 20) throw new Error(`${file}:${name} link reference of length ${length}`);
        const at = 2 + start * 2;
        hex = hex.slice(0, at) + a + hex.slice(at + 40);
      }
    }
  }
  return hex;
}

/**
 * Throws unless `impl` holds exactly this build's strategy: its runtime code must equal the
 * artifact's deployedBytecode with the library addresses embedded in that code written at
 * every deployedLinkReferences offset. Returns those library addresses. The strategy has
 * no immutables, so nothing else may differ.
 */
async function assertImplMatchesBuild(provider, strategyArtifact, impl) {
  const onchain = (await provider.getCode(impl)).toLowerCase();
  if (onchain === "0x") throw new Error(`strategy impl ${impl} has no code`);
  if (onchain.length !== strategyArtifact.deployedBytecode.length) {
    throw new Error(`strategy impl ${impl} is not this build's ${strategyArtifact.contractName} `
      + `(runtime code is ${(onchain.length - 2) / 2} bytes, the build's ${(strategyArtifact.deployedBytecode.length - 2) / 2})`);
  }
  const libs = linkedLibraries(onchain, strategyArtifact);
  if (onchain !== linkBytecode(strategyArtifact.deployedBytecode, strategyArtifact.deployedLinkReferences, libs)) {
    throw new Error(`strategy impl ${impl} is not this build's ${strategyArtifact.contractName} `
      + "(runtime code differs outside the library link offsets: different source or compiler settings)");
  }
  return libs;
}

module.exports = {
  STRATEGY_PROXY, VAULT_PROXY, SAFE, MULTISEND_CALL_ONLY, CONTROLLER, CL_CHECKER, UL_OWNER,
  CHAINLINK_CHECKER, SPECTRA_PT, STALE_LIB, LIB_FQN, STRATEGY_NAME, LIVE_STRATEGY_IMPL, LIVE_VAULT_IMPL,
  IMPL_SLOT, encodeMultiSend, governancePlan, strategyOnlyPlan, strategyOnlyFiles, txBuilderFile,
  maskLibraryCode, assertLibraryMatchesBuild, linkedLibraries, linkBytecode, assertImplMatchesBuild,
};
