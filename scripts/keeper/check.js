// Read-only post-wiring check of a KeeperChecker (Phase 1.5 of aave-fold-execution-plan.md).
//
//   KEEPER_CHECKER=0x... [KEEPER_ACCOUNTS=0xE262...,0x...] node scripts/keeper/check.js
//
// Needs ALCHEMEY_KEY (from .env or the environment). Prints, and asserts:
//   - Controller.hardWorkers(checker) == true
//   - every registered entry: target, kind, priority, status(target), and (fold strategies) checker() canExec
//   - isKeeper(k) for every KEEPER_ACCOUNTS entry
// Exit code 1 when the fold strategy entry is missing or its status is BAD_PAYLOAD, STALE_STRATEGY or
// CHECKER_FAILED (NOT_NEEDED and ELIGIBLE are healthy; BACKED_OFF is reported as a failure too, since
// a leverage-safety entry must never be silenced), or when any assertion above fails. The fold entry
// must also be kind HARD_WORK, priority 0 and carry the fold vault (a wrong kind or priority would
// silently demote the leverage-safety upkeep).
const { ethers } = require("ethers");
require("dotenv").config();

const CONTROLLER = "0xF90FF0F7c8Db52bF1bF869F74226eAD125EFa745";
const MSIG = "0x920b1aCb7618B553324aa0F71620226FA2e09870";
const FOLD = "0xcfd2f32E6d533653cEd5Ba7E5fe1a76C3c626757";
const FOLD_VAULT = "0xE78285A51f51916F2311B7017Db036D8351F3Cf9";
// Order must match `enum Status` and `enum Kind` in contracts/base/KeeperChecker.sol.
const STATUS = ["ELIGIBLE", "NOT_REGISTERED", "BACKED_OFF", "CHECKER_FAILED", "NOT_NEEDED", "BAD_PAYLOAD", "STALE_STRATEGY"];
const KIND = ["NONE", "CL_REBALANCE", "HARD_WORK"];
const BAD = new Set(["BAD_PAYLOAD", "STALE_STRATEGY", "CHECKER_FAILED", "BACKED_OFF", "NOT_REGISTERED"]);

const KC_ABI = [
  "function governance() view returns (address)",
  "function controller() view returns (address)",
  "function targetCount() view returns (uint256)",
  "function getTargets() view returns (address[])",
  "function entries(address) view returns (uint8 kind, uint8 priority, uint8 failures, uint40 backoffUntil, address vault)",
  "function status(address) view returns (uint8, bytes)",
  "function isKeeper(address) view returns (bool)",
  "function keepersOnly() view returns (bool)",
  "function maxPerPerform() view returns (uint256)",
  "function checkUpkeep(bytes) view returns (bool, bytes)",
];
const CONTROLLER_ABI = ["function hardWorkers(address) view returns (bool)"];
const FOLD_ABI = ["function checker() view returns (bool, bytes)", "function vault() view returns (address)"];

async function main() {
  const required = (k) => { const v = (process.env[k] || "").replace(/"/g, "").trim(); if (!v) throw new Error(`${k} is required`); return v; };
  const checker = ethers.utils.getAddress(required("KEEPER_CHECKER"));
  const keepers = (process.env.KEEPER_ACCOUNTS || "").split(",").map((s) => s.trim()).filter(Boolean).map(ethers.utils.getAddress);
  const p = new ethers.providers.JsonRpcProvider(`https://base-mainnet.g.alchemy.com/v2/${required("ALCHEMEY_KEY")}`);
  const failures = [];
  const check = (ok, msg) => { console.log(`  [${ok ? "ok" : "FAIL"}] ${msg}`); if (!ok) failures.push(msg); };

  if ((await p.getCode(checker)) === "0x") throw new Error(`no code at ${checker}`);
  const kc = new ethers.Contract(checker, KC_ABI, p);
  const ctl = new ethers.Contract(CONTROLLER, CONTROLLER_ABI, p);
  console.log(`KeeperChecker ${checker} at block ${await p.getBlockNumber()}`);

  check((await kc.governance()) === MSIG, `governance() == msig (${await kc.governance()})`);
  check((await kc.controller()) === CONTROLLER, `controller() == Controller (${await kc.controller()})`);
  check(await ctl.hardWorkers(checker), "Controller.hardWorkers(checker) == true");

  const n = (await kc.targetCount()).toNumber();
  console.log(`\ntargetCount() = ${n}   keepersOnly = ${await kc.keepersOnly()}   maxPerPerform = ${await kc.maxPerPerform()}`);
  const targets = await kc.getTargets();
  let foldStatus, foldEntry;
  console.log(`\n| # | target | kind | prio | status | strategy checker() canExec | failures | backoffUntil |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const e = await kc.entries(t);
    const [s] = await kc.status(t);
    const name = STATUS[s];
    let canExec = "";
    try { canExec = String((await new ethers.Contract(t, FOLD_ABI, p).checker())[0]); } catch (err) { canExec = "n/a"; }
    if (t === FOLD) { foldStatus = name; foldEntry = e; }
    console.log(`| ${i} | ${t} | ${KIND[e.kind]} | ${e.priority} | ${name} | ${canExec} | ${e.failures} | ${e.backoffUntil} |`);
  }

  console.log("");
  check(foldStatus !== undefined, `the fold strategy ${FOLD} is registered`);
  if (foldStatus !== undefined) check(!BAD.has(foldStatus), `status(fold) is ${foldStatus} (want NOT_NEEDED or ELIGIBLE)`);
  if (foldEntry !== undefined) {
    check(KIND[foldEntry.kind] === "HARD_WORK", `entries(fold).kind is ${KIND[foldEntry.kind]} (want HARD_WORK)`);
    check(foldEntry.priority === 0, `entries(fold).priority is ${foldEntry.priority} (want 0)`);
    check(foldEntry.vault.toLowerCase() === FOLD_VAULT.toLowerCase(), `entries(fold).vault is ${foldEntry.vault} (want ${FOLD_VAULT})`);
  }
  const [up] = await kc.checkUpkeep("0x");
  console.log(`  checkUpkeep("0x") upkeepNeeded = ${up}`);

  for (const k of keepers) check(await kc.isKeeper(k), `isKeeper(${k}) == true`);
  if (!keepers.length) console.log("  (KEEPER_ACCOUNTS not set: keeper flags not checked)");

  if (failures.length) {
    console.error(`\n${failures.length} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
