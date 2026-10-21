// The governance plan for upgrading the LIVE Aave cbETH/WETH fold deployment on Base,
// shared by scripts/16-prepare-fold-upgrade.js (prints it) and
// test/aave/fold/upgrade-rehearsal-fork.js (executes it through the real Safe on a fork).
// Keeping one source means the runbook's calldata is exactly the calldata that was rehearsed.
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

/**
 * The full rollout for the given new implementations.
 *  - safeTxs: the Safe transactions, in execution order. Each has the exact
 *    {to, value, operation, data} to propose, and its inner calls.
 *  - eoaTxs: transactions that must NOT go through the Safe.
 *  - optionalSafeTxs: not part of the upgrade; listed for a governance decision.
 */
function governancePlan({ strategyImpl, vaultImpl }) {
  const c = (to, desc, fn, args = []) => ({ to, desc, data: iface.encodeFunctionData(fn, args) });
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

module.exports = {
  STRATEGY_PROXY, VAULT_PROXY, SAFE, MULTISEND_CALL_ONLY, CONTROLLER, CL_CHECKER, UL_OWNER,
  CHAINLINK_CHECKER, SPECTRA_PT, STALE_LIB, LIB_FQN, STRATEGY_NAME, LIVE_STRATEGY_IMPL, LIVE_VAULT_IMPL,
  encodeMultiSend, governancePlan, maskLibraryCode, assertLibraryMatchesBuild, linkedLibraries,
};
