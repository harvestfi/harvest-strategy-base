// Builds the governance transactions that move Base keeper work onto KeeperChecker.
// READ-ONLY: it reads live state and writes Safe Transaction Builder JSON files. It sends nothing.
//
//   KEEPER_CHECKER=0x... KEEPER_ACCOUNTS=0xbotEOA[,0xcreReceiver] OUT=./out \
//     node scripts/keeper/build-migration-batch.js
//
// Needs ALCHEMEY_KEY (from .env or the environment).
//
// Entries come from CLChainlinkChecker, the only checker in use. The hard-work ChainlinkChecker
// (0x81c7) is retired; its entries are not migrated. Each entry is classified from the target's own
// checker() payload:
//   rebalanceCurrentTick / rebalanceStakeRatio  -> CL_REBALANCE, priority 1
//   doHardWork(address) and a fold strategy     -> HARD_WORK,    priority 0 (leverage safety)
//   doHardWork(address) otherwise               -> HARD_WORK,    priority 2 (routine harvest)
// Deviation and cooldown are read live per vault and passed back unchanged to setRebalanceConfig,
// so re-pointing the executor changes nothing else. Re-run right before signing.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config();

const CONTROLLER = "0xF90FF0F7c8Db52bF1bF869F74226eAD125EFa745";
const MSIG = "0x920b1aCb7618B553324aa0F71620226FA2e09870";
const OLD_CL = "0xaba4ba582E04B729ABCd2Bae0d7c14fe21C9F510";
const OLD_HW = "0x81c733905e2Fd878fda137802E7bF578E3CDfbF7"; // retired off-chain, still a hardWorker
// Fold strategies registered whether or not CLChainlinkChecker still lists them, so taking one out of
// the old checker first (as the interim fix did) cannot silently drop its leverage-safety entry.
const FOLD_STRATEGIES = ["0xcfd2f32E6d533653cEd5Ba7E5fe1a76C3c626757"];
const SLOT = {
  executor: "0x2b03419b0a75317010c2c9c6753d475bd595f74113c0ba88f0af572c718b3fda",
  deviation: "0xef14df50012225a4f04edea124bcd8271c46dcca17ab80e5f8f189e352fa097a",
  cooldown: "0xd18f22707e82220d6b5763ef48685930876ed861e77af969d83d53007e049af9",
};
const SEL = {
  rebalance: ethers.utils.id("rebalanceCurrentTick(uint256)").slice(0, 10),
  stakeRatio: ethers.utils.id("rebalanceStakeRatio()").slice(0, 10),
  hardWork: ethers.utils.id("doHardWork(address)").slice(0, 10),
};
const KIND = { CL_REBALANCE: 1, HARD_WORK: 2 };

const iface = new ethers.utils.Interface([
  "function vaults(uint256) view returns (address)",
  "function removeVaults(address[])",
  "function checker() view returns (bool, bytes)",
  "function governance() view returns (address)",
  "function symbol() view returns (string)",
  "function targetWidth() view returns (uint256)",
  "function vault() view returns (address)",
  "function borrowTargetFactorNumerator() view returns (uint256)",
  "function setRebalanceConfig(uint256,uint256,address)",
  "function addHardWorker(address)",
  "function removeHardWorker(address)",
  "function hardWorkers(address) view returns (bool)",
  "function addEntries(address[],uint8[],uint8[])",
  "function setKeeper(address,bool)",
  "function targetCount() view returns (uint256)",
]);

async function main() {
  const checker = ethers.utils.getAddress(required("KEEPER_CHECKER"));
  const keepers = (process.env.KEEPER_ACCOUNTS || "").split(",").map((s) => s.trim()).filter(Boolean).map(ethers.utils.getAddress);
  const out = process.env.OUT || ".";
  const p = new ethers.providers.JsonRpcProvider(`https://base-mainnet.g.alchemy.com/v2/${required("ALCHEMEY_KEY")}`);
  const block = await p.getBlockNumber();
  const c = (addr) => new ethers.Contract(addr, iface, p);
  const tryCall = async (addr, fn, ...args) => { try { return await c(addr)[fn](...args); } catch (e) { return undefined; } };
  const slot = async (addr, s) => ethers.BigNumber.from(await p.getStorageAt(addr, s));

  if ((await p.getCode(checker)) !== "0x") {
    const gov = await c(checker).governance();
    if (gov !== MSIG) throw new Error(`KeeperChecker governance is ${gov}, expected the msig ${MSIG}`);
    if (!(await c(checker).targetCount()).isZero()) console.warn("WARNING: KeeperChecker already has entries; addEntries will revert on duplicates");
  } else {
    console.warn(`WARNING: no code at ${checker} - building against a placeholder`);
  }

  const listOf = async (old) => { const l = []; for (let i = 0; i < 100; i++) { const a = await tryCall(old, "vaults", i); if (!a) break; l.push(a); } return l; };
  const oldCl = await listOf(OLD_CL);
  const unique = [...new Set([...FOLD_STRATEGIES, ...oldCl].map((a) => ethers.utils.getAddress(a)))];

  const entries = [];
  for (const t of unique) {
    const res = await tryCall(t, "checker");
    if (!res) throw new Error(`${t}: checker() reverts - decide by hand`);
    const sel = res[1].slice(0, 10);
    const label = (await tryCall(t, "symbol")) || `strategy for ${(await tryCall(t, "vault")) || "?"}`;
    const width = await tryCall(t, "targetWidth");
    const e = { target: t, label: width ? `${label} w${width}` : label };
    if (sel === SEL.rebalance || sel === SEL.stakeRatio) {
      e.kind = KIND.CL_REBALANCE; e.priority = 1;
      e.governance = await tryCall(t, "governance");
      e.deviation = await slot(t, SLOT.deviation);
      e.cooldown = await slot(t, SLOT.cooldown);
      e.executor = ethers.utils.getAddress("0x" + (await p.getStorageAt(t, SLOT.executor)).slice(26));
    } else if (sel === SEL.hardWork) {
      e.kind = KIND.HARD_WORK;
      e.priority = (await tryCall(t, "borrowTargetFactorNumerator")) !== undefined ? 0 : 2;
    } else {
      throw new Error(`${t}: unexpected checker() selector ${sel}`);
    }
    entries.push(e);
  }
  entries.sort((a, b) => a.priority - b.priority);

  const tx = (to, fn, args) => ({ to, value: "0", data: iface.encodeFunctionData(fn, args), contractMethod: null, contractInputsValues: null });
  const cl = entries.filter((e) => e.kind === KIND.CL_REBALANCE);
  const foreign = cl.filter((e) => e.governance !== MSIG);
  if (foreign.length) console.warn(`WARNING: ${foreign.length} CL vault(s) not governed by the msig - their setRebalanceConfig is listed separately`);

  // Batch 1 (msig, ONE MultiSend so no entry is ever registered before its vault accepts the checker).
  const wire = [];
  if (!(await c(CONTROLLER).hardWorkers(checker))) wire.push(tx(CONTROLLER, "addHardWorker", [checker]));
  for (const e of cl.filter((e) => e.governance === MSIG)) wire.push(tx(e.target, "setRebalanceConfig", [e.deviation, e.cooldown, checker]));
  wire.push(tx(checker, "addEntries", [entries.map((e) => e.target), entries.map((e) => e.kind), entries.map((e) => e.priority)]));
  for (const k of keepers) wire.push(tx(checker, "setKeeper", [k, true]));

  // Batch 2 (msig, optional hygiene): the retired hard-work checker still holds the hardWorker role.
  const decommission = [];
  if (await c(CONTROLLER).hardWorkers(OLD_HW)) decommission.push(tx(CONTROLLER, "removeHardWorker", [OLD_HW]));

  fs.mkdirSync(out, { recursive: true });
  const file = (name, description, transactions) => {
    const f = path.join(out, name);
    fs.writeFileSync(f, JSON.stringify({
      version: "1.0", chainId: "8453", createdAt: Date.now(),
      meta: { name, description: `${description} (built at block ${block})`, txBuilderVersion: "1.16.5", createdFromSafeAddress: MSIG },
      transactions,
    }, null, 2));
    console.log(`wrote ${f} (${transactions.length} txs)`);
  };
  file("keeper-1-wire.json", "KeeperChecker: hardWorker + rebalanceExecutor on every CL vault + entries + keepers", wire);
  if (decommission.length) file("keeper-2-hygiene.json", "Optional: revoke the retired ChainlinkChecker's Controller hardWorker role", decommission);

  console.log(`\nCLChainlinkChecker governance (EOA ${await c(OLD_CL).governance()}) - send after batch 1:`);
  console.log(`  to ${OLD_CL} data ${iface.encodeFunctionData("removeVaults", [oldCl])}`);
  for (const e of foreign) console.log(`  ${e.target} governance ${e.governance}: setRebalanceConfig data ${iface.encodeFunctionData("setRebalanceConfig", [e.deviation, e.cooldown, checker])}`);

  console.log(`\n| # | target | label | kind | prio | deviation | cooldown | executor now |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  entries.forEach((e, i) => console.log(`| ${i} | ${e.target} | ${e.label} | ${e.kind === 1 ? "CL_REBALANCE" : "HARD_WORK"} | ${e.priority} | ${e.deviation ?? ""} | ${e.cooldown ?? ""} | ${e.executor ?? ""} |`));
}

function required(k) {
  const v = (process.env[k] || "").replace(/"/g, "").trim();
  if (!v) throw new Error(`${k} is required`);
  return v;
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
