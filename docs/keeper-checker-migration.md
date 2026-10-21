# KeeperChecker: one keeper target for CL rebalances and fold safety

`contracts/base/KeeperChecker.sol` replaces both deployed Base checkers:

| Old checker | Address | Entries | Calls | Governance |
|---|---|---|---|---|
| CLChainlinkChecker | `0xaba4ba582E04B729ABCd2Bae0d7c14fe21C9F510` | 21 | `vault.rebalanceCurrentTick(width)` directly, as each vault's `rebalanceExecutor` | EOA `0x6a74…5Aa2` |
| ChainlinkChecker | `0x81c733905e2Fd878fda137802E7bF578E3CDfbF7` | 4 | `Controller.doHardWork(vault)`, as a whitelisted hardWorker | Safe `0x920b…9870` |

Both return only the FIRST eligible entry, and `performUpkeep` reverts when that entry's call fails. One
persistently failing entry therefore starves every entry behind it. Today the Aave fold strategy
`0xcfd2…6757` sits at index 7 of the CL checker. Its payload is `doHardWork(address)`, so the CL checker
rejects it with `BadSelector`. Whenever its deleverage condition fires, CL entries 8-20 stop being served,
and so does the fold deleverage itself.

## What the new contract does

- **Typed entries.** Each entry is `{target, kind, priority}`, and each kind can make exactly one call:
  - `CL_REBALANCE`: the target is a CL vault. The only call is `target.rebalanceCurrentTick(width)`, with the width taken from the vault's own `checker()`.
  - `HARD_WORK`: the target is a vault or a strategy. The only call is `Controller.doHardWork(entry.vault)`. `entry.vault` is fixed when the entry is added: it is the target itself, or `strategy.vault()`, and that vault's `strategy()` must point back at the target. The `checker()` payload must equal `doHardWork(entry.vault)` byte for byte. A strategy that stops being its vault's active strategy reports `STALE_STRATEGY` and is skipped.
  - No function takes a call target or calldata, so no other call is possible.
- **Failure isolation.** `performUpkeep(abi.encode(address[]))` re-evaluates every listed entry on chain and skips any that is no longer eligible. It runs each eligible one under a gas cap. A reverting entry emits `UpkeepFailed(target, kind, reason, failures, backoffUntil)` and goes into an exponential backoff (10 min, doubling, capped at 6 h). `checkUpkeep` skips it while backed off, and a success resets it. The transaction reverts (`NotNeeded`) only when nothing ran and nothing was recorded, so a keeper that loses a race fails cleanly in simulation.
- **Only keepers record failures.** Anyone may perform, as before. But a failure only goes into backoff when `msg.sender` is a registered keeper (`setKeeper`). Otherwise an attacker could, in a single transaction, make an entry revert and push it into backoff. One example: a flash loan that drains the Aave WETH reserve right before calling `performUpkeep`, so the fold deleverage fails for hours. `setKeepersOnly(true)` closes performing to keepers entirely. That also removes review finding 1 (anyone can force a rebalance), at the cost of permissionlessness.
- **Priority.** Entries are scanned by tier: 0 = fold/leverage safety, 1 = CL rebalances, 2 = routine harvests (`MAX_PRIORITY` 7). Within a tier the start point rotates with `block.number`, so an entry that stays eligible cannot starve its neighbours.
- **Sharding.** `checkData` can be empty, `abi.encode(rotation)` (like the old start index), or `abi.encode(rotation, shards, shard)`. With the last form a shard scans only targets where `uint160(target) % shards == shard`, and that split stays stable across add and remove.
- **Bounded gas.** A perform runs at most `maxPerPerform` entries (default 2, at most 5).
  - Each `checker()` read is capped at `checkGasLimit` (1M) and copies at most 0xa0 bytes, so a hostile checker cannot return-bomb the scan.
  - Each execution is capped at `callGasLimit[kind]` (4.5M for both kinds) and copies at most 256 bytes of revert data.
  - An entry is attempted only when the transaction can still forward its FULL cap. A short-gassed perform therefore skips the entry instead of failing it, and nothing is recorded.
- **Governance.** `Controllable(Storage)`. Deploy it on Storage `0x98E0…13F9`, whose governance is the msig and whose controller is the live Controller. Owner tooling: `addEntry`/`addEntries`, `removeEntry`/`removeEntries` (index-mapped swap-pop), `setPriority`/`setPriorities`, `clearBackoff`, `setKeeper`, `setKeepersOnly`, `setMaxPerPerform`, `setCallGasLimit`, `setCheckGasLimit`, `setBackoff`. For monitoring, `status(target)` returns one of `ELIGIBLE | NOT_REGISTERED | BACKED_OFF | CHECKER_FAILED | NOT_NEEDED | BAD_PAYLOAD | STALE_STRATEGY`, plus the exact call the entry would make.

### Decisions to confirm

1. **V2 `rebalanceStakeRatio()` is not executed.** The brief allows `CL_REBALANCE` only `rebalanceCurrentTick`. A V2 vault whose `checker()` asks for a stake-ratio rebalance is therefore reported as `BAD_PAYLOAD` and skipped. It no longer wedges the others (review finding 4), but nobody executes it either. The function is permissionless, so a third kind (`CL_STAKE_RATIO`, exact 4-byte payload) would be a small addition if you want the keeper to run it. On 2026-10-21 all 13 V2 vaults returned the `rebalanceCurrentTick` payload.
2. **Storage choice.** Storage `0x98E0` puts entry management behind the 2-of-3 Safe. Storage `0x8dE4…B792` (EOA `0x6a74` governance, same Controller) would make operations faster. The checker's own powers are narrow: it can only make the allow-listed calls, and a CL vault only obeys it if that vault's governance named it executor. The Controller's hardWorker grant, however, is a Safe decision either way.
3. **The brief says the CL vaults "are governed by different accounts".** On chain all 20 report `governance() == 0x920b…` (the Safe), so step 2 below is one Safe batch. Only the old CL checker itself is governed by the EOA `0x6a74`.

## Test evidence

`test/keeper/keeper-checker-fork.js` forks Base at block 52,896,000 once, then uses `evm_snapshot` per test. It runs as one guarded hardhat process: 11 passing, peak RSS 1.5 GB, about 40 s.

| Test | Shows |
|---|---|
| old CLChainlinkChecker (red) | With the fold strategy eligible at index 7, `checkUpkeep` surfaces it for every start index 0-7 and `performUpkeep` reverts `BadSelector`. The eligible w16 CL vault behind it is never served. |
| old ChainlinkChecker (red) | A reverting entry ahead of the fold strategy: `performUpkeep` reverts `CallFailed`. The fold payload cannot be pushed past it either (`DataMismatch`). |
| batch isolation | One perform holds a real CL rebalance (new NFT, `Rebalanced`), a real fold `doHardWork` (Controller `SharePriceChangeLog` for vault `0xE782…`, condition cleared) and two reverting mocks. The two real calls execute; the mocks emit `UpkeepFailed` and back off. After expiry they reappear, and the second failure doubles the backoff. 3.0M gas. |
| one entry per perform | A broken first entry delays the CL vault by one perform only. |
| priority / re-prioritisation, sharding | The safety tier always comes first, across blocks. `setPriority` reorders. Shards split by address. |
| stranger | A stranger can perform and the good entry runs, but the stranger's failure is not recorded. `keepersOnly` blocks strangers. |
| short gas | Below the 4.5M cap the entry is skipped (`NotNeeded`), not failed. The fold deleverage costs 1.11M gas. |
| spoofing | Covered cases: a subject swapped to a real vault; non-rebalance selectors (`doHardWork`, `withdraw`, `rebalanceStakeRatio`); the fold strategy registered as CL (today's mistake); a stale strategy; an orphan strategy at registration; a non-governance `addEntry`; unregistered targets in performData; return-bomb, reverting and malformed checkers. None of them blocks the real CL vault. |
| migration rehearsal | All 25 live entries are registered and all 20 executors re-pointed with deviation and cooldown preserved. In a keeper loop the fold strategy and the CL vault run in one perform (2.95M gas), then the eligible `0x86b8` hard work runs (2.36M gas), then everything is quiet. The two old checkers are emptied. `checkUpkeep` over 25 entries costs about 0.78M gas. |

Mutation checks:
- Re-introducing revert-on-failure fails the 3 isolation tests.
- Checking only the selector (not the subject) fails the spoofing test.
- Removing the gas guard fails the short-gas test.

Run it from a worktree with only `ALCHEMEY_KEY` and `MNEMONIC` exported. Do NOT take `.env`'s `FORK_BLOCK`. Use `KEEPER_FORK_BLOCK` to move the block.

```bash
npx hardhat test test/keeper/keeper-checker-fork.js
```

## Migration runbook

Nothing below has been executed. Re-run the batch builder right before signing; it reads live deviation, cooldown and entry lists.

### Step 0: deploy (deployer EOA)

```bash
npx hardhat run scripts/keeper/deploy-keeper-checker.js --network mainnet
```

The contract has no initializer, so there is no front-run window. Check `governance() == 0x920b…9870` and `controller() == 0xF90F…a745`.

### Steps 1-3: one Safe MultiSend (`keeper-1-wire.json`)

```bash
KEEPER_CHECKER=<new address> KEEPER_ACCOUNTS=<bot EOA>[,<CRE receiver>] OUT=./out node scripts/keeper/build-migration-batch.js
```

Load `out/keeper-1-wire.json` into the Safe Transaction Builder for `0x920b…9870`. Steps 1-3 go in ONE batch. If entries were registered before the vaults accepted the checker, the first keeper performs would revert, record failures and back the entries off. If the vaults were re-pointed before entries existed, CL rebalances would stop in between.

1. `Controller(0xF90F…a745).addHardWorker(new)`.
2. `setRebalanceConfig(deviation, cooldown, new)` on each of the 20 CL vaults. Deviation and cooldown are read live and passed back unchanged. On 2026-10-21 these were deviation 0 on all, cooldown 5 s on the V1 vaults and 300 s on the V2 vaults.
3. `addEntries` with all 25 entries (table below), then `setKeeper(botEOA, true)`, plus the CRE receiver once it exists.

| # | target | label | kind | prio |
|---|---|---|---|---|
| 0 | `0xcfd2f32E6d533653cEd5Ba7E5fe1a76C3c626757` | Aave fold strategy → fWETH `0xE782…3Cf9` | HARD_WORK | 0 |
| 1 | `0xa2c8A60b0ac47e5b61250A7e1b17894a2948cffC` | Aave fold strategy → fWETH `0x0DA3…8381` | HARD_WORK | 0 |
| 2 | `0x7deC7048D9bB44B5bD0250186ce24371cEd34Fe4` | Aave fold strategy → fWETH `0x0e95…Db4A` | HARD_WORK | 0 |
| 3 | `0xF1d5630B646E2D3AfC1fC31F057df349620F48eC` | fCL_cbETH_WETH w1 | CL_REBALANCE | 1 |
| 4 | `0xF83648Df279004CdcEee1bEE3a92b9194Cd3b94E` | fCL_tBTC_cbBTC w1 | CL_REBALANCE | 1 |
| 5 | `0x83BD3E5688b0d52762A7c6D9b164C4F5A1Fe4DFb` | fCL_WETH_cbBTC w4 | CL_REBALANCE | 1 |
| 6 | `0x259795BD463b4B3C6683F3bB7A7760dAC85770E4` | fCL_WETH_cbBTC w8 | CL_REBALANCE | 1 |
| 7 | `0x58bfF80948b11F76066223cdF0B4956c5A584f3a` | fCL_WETH_cbBTC w16 | CL_REBALANCE | 1 |
| 8 | `0x9B63f58d50Cd8Eb840a274ee14B82D1404f7e59D` | fCL_EURC_USDC w1 | CL_REBALANCE | 1 |
| 9 | `0x13Cb63533ad04714f59DAf23be15655ed1B76b58` | fCL_EURC_USDC w2 | CL_REBALANCE | 1 |
| 10 | `0x28365BE1308838a71Fb4D36281EFeE141819e448` | fCLv2_USDC_AAPLc w60 | CL_REBALANCE | 1 |
| 11 | `0x4106bC8e6446EC6566eA9E9B9a3e4BbC6d2b4d3f` | fCLv2_USDC_AAPLc w120 | CL_REBALANCE | 1 |
| 12 | `0x21DFa5e1486BFe8D725f11D59B32B908e783FF36` | fCLv2_USDC_AAPLc w240 | CL_REBALANCE | 1 |
| 13 | `0xd7D53a0E4b5d0857D84cA8dff334C185F0ff78a3` | fCLv2_USDC_AAPLc w20 | CL_REBALANCE | 1 |
| 14 | `0x07c8Fa4deeaA17C54381bAfB312e8a94da2Fb243` | fCLv2_USDC_GOOGLc w20 | CL_REBALANCE | 1 |
| 15 | `0xa3D714a241e9D2F52DbBE90D9b6D44595A845852` | fCLv2_USDC_GOOGLc w40 | CL_REBALANCE | 1 |
| 16 | `0x8396bD130C519F7Dc2B00079D69Ee4563d343641` | fCLv2_USDC_GOOGLc w80 | CL_REBALANCE | 1 |
| 17 | `0xbceb64f40c503739019091f0A561b377AB1041EF` | fCLv2_USDC_METAc w20 | CL_REBALANCE | 1 |
| 18 | `0xD60B6ce9D04668ba13a505170a97808DA6Ba9D80` | fCLv2_USDC_METAc w40 | CL_REBALANCE | 1 |
| 19 | `0xe893A09Dd4a0d9429389de4A3B74f7e9Fe820B62` | fCLv2_USDC_METAc w80 | CL_REBALANCE | 1 |
| 20 | `0x10882A14EfC2320650D29e221051ffc7864d477E` | fCLv2_USDC_NVDAc w20 | CL_REBALANCE | 1 |
| 21 | `0x7D46B4Dd91975055eC7267FDfAEbd39a1071D0aa` | fCLv2_USDC_NVDAc w40 | CL_REBALANCE | 1 |
| 22 | `0x16ddd4e78dF104ac9da7e2aaC57C999d03Eed635` | fCLv2_USDC_NVDAc w80 | CL_REBALANCE | 1 |
| 23 | `0x86b8E5fc263e3760A44886fD50E9279e31eDdF4F` | fCL_tBTC_cbBTC (old-style CL vault, harvest) | HARD_WORK | 2 |
| 24 | `0x8611053A05080914E72D0C84fF95a11d10EdF36E` | fCL_cbETH_WETH (old-style CL vault, harvest) | HARD_WORK | 2 |

All 20 CL vaults (rows 3-22) are governed by the Safe `0x920b…`, and their executor today is the old CL checker `0xaba4…F510`. Entries 1, 2, 23 and 24 come from the hard-work checker. Entry 0 comes from the CL checker, or from the hard-work checker if the interim fix was applied; the builder handles both cases.

After the batch:
- `status(t)` is `NOT_NEEDED` or `ELIGIBLE` for every entry. It must never be `BAD_PAYLOAD` or `STALE_STRATEGY`.
- `Controller.hardWorkers(new)` is true.
- The executor slot of every vault holds the new address.

Then switch the keeper bot over (below) and watch the first performs.

### Step 4: decommission the old checkers

- Safe, `keeper-2-decommission.json`: `ChainlinkChecker.removeVaults(all 4)` and `Controller.removeHardWorker(0x81c7…DfbF7)`.
- EOA `0x6a74`: `CLChainlinkChecker.removeVaults(all 21)`. The builder prints the calldata. This is hygiene only, because after step 2 no CL vault accepts the old checker any more.
- Cancel or stop anything that still targets the old addresses: the keeper bot's `cl-rebalance` and `hard-work` targets, the not-yet-deployed CRE `cl-rebalance` and `harvest-hard-work` configs, and any leftover Automation upkeeps.

### Rollback

- Safe: `setRebalanceConfig(deviation, cooldown, 0xaba4…F510)` on the vaults, and `Controller.removeHardWorker(new)`.
- Bot: `ENABLED_TARGETS=cl-rebalance,hard-work,fee-distribution`.

The old checkers keep working as long as step 4 has not run.

### Interim fix (if applied first)

The interim fix moves the fold strategy from the CL checker to the hard-work checker and enables the bot's `hard-work` target. It is compatible with all of the above. The builder classifies entries by each target's own `checker()` payload, so the generated batch is the same.

## Keeper bot and CRE

The keeper-bot change is prepared on branch `keeper-checker-target` in `harvestfi/harvest-cre`. It is based on the unmerged `keeper-name-vault`, which introduced `subject.ts`. It is not merged and not deployed.
- New `keeper` target: address from `KEEPER_CHECKER_ADDRESS`, gas limit 10M (two 4.5M caps plus the scan), `subjectEncoding: "list"`, off by default.
- Boot fails if the target is enabled without an address.
- After a successful perform, the bot reads `UpkeepFailed` events from the receipt and alerts per entry. A KeeperChecker transaction succeeds even when one of its entries failed.
- Cut-over: set `KEEPER_CHECKER_ADDRESS` and `ENABLED_TARGETS=keeper,fee-distribution`, and register the bot EOA with `setKeeper`.

The two CRE workflows collapse into one:
- Keep `cl-rebalance` and point it at KeeperChecker (`targetAddress`). Raise `writeGasLimit` to about 9.8M: 2 × 4.5M caps fit under the 10M CRE write cap. An entry that does not fit in a perform's gas is deferred to the next perform, never failed.
- Delete `harvest-hard-work`. That frees one of the three org-quota workflow slots.
- The receiver's allowlist becomes `performUpkeep` on KeeperChecker, with a minimum gas of about 9.5M. Register the receiver with `setKeeper` so its failures back entries off too.
- `fee-distribution` is unchanged.
