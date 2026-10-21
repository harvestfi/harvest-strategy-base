# Aave cbETH/WETH fold upgrade: mainnet runbook (Base)

Release branch `release/aave-fold-upgrade` = upstream `dev` (8168ec0)
+ `claude/aave-fold-zero-premium-flash` (live NAV 3171401, premium-free flashloans 2e20246, dev fee conventions e20b418)
+ `claude/fold-vault-preview-compliance` (FoldVaultV2 preview lens 5d3bb78, ef882d2).

Nothing on this branch has been pushed, deployed or proposed.

| | address |
|---|---|
| Strategy proxy | `0xcfd2f32E6d533653cEd5Ba7E5fe1a76C3c626757` (live impl `0x74ae6e11…`, lib `0x2B19aB8A…`) |
| Vault proxy (FoldVaultV2) | `0xE78285A51f51916F2311B7017Db036D8351F3Cf9` (live impl `0x4942b35f…`, depositCap 200 WETH) |
| Governance of both proxies, Controller, ChainlinkChecker | Safe 1.4.1 `0x920b1aCb7618B553324aa0F71620226FA2e09870`, 2-of-3, upgrade delay 43200 s |
| MultiSendCallOnly 1.4.1 | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` |
| CLChainlinkChecker (governance = ULOwner **EOA**) | `0xaba4ba582E04B729ABCd2Bae0d7c14fe21C9F510` |
| ULOwner EOA | `0x6a74649aCFD7822ae8Fb78463a9f2192752E5Aa2` |
| Spectra PT-fWETH(WETH)-2027/04/19 (holds vault shares) | `0xb43326e29631891d069ed21970b09fca0b624cee` |

## Gates before step 1 (open)

1. **External review** of the strategy diff (flash paths, Morpho callback, live NAV): the user still has to accept or defer it.
2. **Preview lens:** the hook ships in FoldVaultV2, but the lens stays **unset**. `setPreviewLens` is not part of this rollout. With a lens set, previewRedeem becomes pool-dependent and withdraw() is disabled. The Spectra PT reads previewRedeem(1e18) as its IBT rate and calls withdraw(), so anyone could depeg it permanently. Whether the hook ships at all is still the user's call.
3. **PR target** (fork master vs harvestfi dev): undecided.

## Step 0: deployer wallet (not governance)

```bash
npx hardhat run scripts/16-prepare-fold-upgrade.js --network mainnet
```

The script:
- deploys a fresh AaveReserveLib, the strategy impl linked to it, and the FoldVaultV2 impl;
- Basescan-verifies all three (the library too);
- reads the library address back out of the impl's runtime code and prints it;
- refuses (exit 1, before printing any governance step) any library whose bytecode is not this build's. That covers a supplied `AAVE_RESERVE_LIB`, a freshly deployed one, and the one embedded in a reused `STRATEGY_IMPL`.

A strategy linked to the stale `0x2B19aB8A` reverts every deposit and every exit (proven in the rehearsal). If verification fails, re-run it with `AAVE_RESERVE_LIB=… STRATEGY_IMPL=… VAULT_IMPL=… VERIFY_REUSED=1`. That redeploys nothing.

The script prints the transactions below with the real impl addresses filled in. It and the rehearsal test both take them from `scripts/fold-upgrade-plan.js`.

## Safe transactions, in this order

### Safe tx 1: schedule both upgrades (starts the 12h timelock)

| # | to | data |
|---|---|---|
| 1 | `0xcfd2f32E6d533653cEd5Ba7E5fe1a76C3c626757` | `0x0c80447a` + `<NEW_STRATEGY_IMPL>` left-padded to 32 bytes (`scheduleUpgrade(address)`) |
| 2 | `0xE78285A51f51916F2311B7017Db036D8351F3Cf9` | `0x0c80447a` + `<NEW_VAULT_IMPL>` left-padded to 32 bytes |

As one Safe transaction: to `0x9641d764fc13c8B624c04430C7356C1C7C8102e2`, value 0, **operation 1 (delegatecall)**, data = `multiSend(bytes)` of the two calls. scripts/16 prints the encoded data.

### Wait

The upgrade becomes possible only once `block.timestamp > nextImplementationTimestamp()`, i.e. strictly more than 43200 s after tx 1's block. Read `nextImplementationTimestamp()` on both proxies before proposing tx 2.

### Safe tx 2: ONE batch: accrue on the old impl, then swap the strategy

| # | to | data | call |
|---|---|---|---|
| 1 | `0xcfd2f32E6d533653cEd5Ba7E5fe1a76C3c626757` | `0xbd51aa1c` | `preInteract()` (old impl: books any fee, resyncs storedBalance) |
| 2 | `0xcfd2f32E6d533653cEd5Ba7E5fe1a76C3c626757` | `0xd55ec697` | `StrategyProxy.upgrade()` (runs `finalizeUpgrade()` as the Safe) |

As one Safe transaction (independent of the impl addresses, so this is exact): to `0x9641d764fc13c8B624c04430C7356C1C7C8102e2`, value 0, operation 1, data

```
0x8d80ff0a000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000b200cfd2f32e6d533653ced5ba7e5fe1a76c3c62675700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004bd51aa1c00cfd2f32e6d533653ced5ba7e5fe1a76c3c62675700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004d55ec6970000000000000000000000000000
```

Why one batch: finalizeUpgrade() resyncs storedBalance **without** booking a fee, so an upgrade without the preceding preInteract forgives the fee on any gain since the last interaction. Bundled, NAV, ppfs, previewRedeem(1e18) and the Spectra IBT rate are equal to the wei across `upgrade()`. Both proxies' `upgrade()` revert for anyone but governance (`finalizeUpgrade` is onlyGovernance), so no third party can run the upgrade unbundled.

**What the bundle does not do:** it does not avoid a one-off share-price move in this transaction. The old impl reports a cached balance, and the carry accrued since the last vault interaction is booked here either way (bundled: in preInteract; unbundled: in upgrade()). In the rehearsal (block 52896800 + 12h) that move was −7.64 bps, identical bundled and unbundled. It is P&L the position has already made or lost, and any deposit, withdrawal or hard work on the old impl would book it just the same. The Spectra PT will book that drop permanently whenever it is realised. The only way to shrink it is to book it earlier (for example a Controller.doHardWork shortly before tx 2), and that only moves it.

### Safe tx 3: upgrade the vault (after tx 2)

to `0xE78285A51f51916F2311B7017Db036D8351F3Cf9`, value 0, operation 0, data `0xd55ec697` (`VaultProxy.upgrade()`).

This leaves totalAssets, ppfs, previewRedeem(1e18) and the Spectra IBT rate unchanged to the wei. `previewLens()` stays `0x0`, and depositCap stays 200 WETH: it is storage, so no action is needed.

## Separate: ULOwner EOA transaction (never through the Safe)

The fold strategy is registered in CLChainlinkChecker at index 7. That checker executes the strategy's `checker()` payload against the strategy itself. The payload is `Controller.doHardWork(vault)`, so it can never execute there. Remove the strategy from that checker:

| from | to | data |
|---|---|---|
| `0x6a74649aCFD7822ae8Fb78463a9f2192752E5Aa2` | `0xaba4ba582E04B729ABCd2Bae0d7c14fe21C9F510` | `0xceb68c23000000000000000000000000cfd2f32e6d533653ced5ba7e5fe1a76c3c626757` (`removeVault(0xcfd2…)`) |

CLChainlinkChecker's governance is this EOA (its own Storage `0x8dE4B34D`), so inside a Safe batch this call reverts the whole batch (GS013, rehearsed). It does not depend on the Safe transactions or on their order.

## For a decision (not part of the upgrade)

After the removal, no keeper watches the strategy's `checker()` (deleverage when health drops below target). ChainlinkChecker (governance = Safe, already a Controller hardWorker) forwards exactly that payload:

to `0x81c733905e2Fd878fda137802E7bF578E3CDfbF7`, operation 0, data `0x256b5a02000000000000000000000000cfd2f32e6d533653ced5ba7e5fe1a76c3c626757` (`ChainlinkChecker.addVault(0xcfd2…)`). This was rehearsed: checkUpkeep still answers. Check with the unified-keeper-checker work before adding it.

## Post-upgrade checks

- `implementation()` on both proxies equals the new impls, and `nextImplementation()` is `0x0` on both.
- `leverFlashPremiumBps() == 0`, `deleverFlashPremiumBps() == 0` (while Morpho holds at least the strategy's debt in WETH), `feeFloor() == 1000`.
- `previewLens() == 0x0`, `depositCap() == 200e18`.
- PT `getIBTRate() == previewRedeem(1e18) * 1e9`.

## Rehearsal evidence

`test/aave/fold/upgrade-rehearsal-fork.js` at 52896800 sends exactly these transactions through the real Safe: owners' approved hashes, then execTransaction with MultiSendCallOnly as a delegatecall. 13/13 pass:
- NAV, ppfs, previewRedeem(1e18) and the Spectra IBT rate are equal to the wei across StrategyProxy.upgrade() (bundled) and across VaultProxy.upgrade().
- Unbundled (red), the -7.64 bps carry lands on upgrade() itself. With a gain pending, the unbundled path forgives 0.00484 WETH of fee.
- The exact runbook tx 2 leaves storage identical to the recorded run.
- Every one of the 31 strategy + 21 vault getters is unchanged. New getters: leverFlashPremiumBps 0, deleverFlashPremiumBps 0, feeFloor 1000, previewLens 0x0.
- Smoke: ERC-4626 and legacy deposit/exit of 1 WETH, the min-out overloads, and Controller.doHardWork as the Safe.
- Costs on 1 WETH: entry 17.88 bps, exit -2.71 bps.
- An impl linked to 0x2B19aB8A reverts deposit and redeem, and the guard refuses it.
- removeVault succeeds from the EOA and reverts (GS013) through the Safe.
- Only governance can run either upgrade().

scripts/16 was dry-run on an in-process fork (`--network hardhat`) at 52896800: it ran clean and printed this plan. With `AAVE_RESERVE_LIB=0x2B19…` it exits 1 before deploying anything.

Full matrix on the release tree, one guarded process at a time:

| suite | block | result |
|---|---|---|
| aave-reserve-lib / eth-cbeth / -resilience / -scenarios / -oracle-market | 44729683 | 17 / 10 / 21 / 8 / 7 pass |
| deposit-cap | 44729683 | 6 pass |
| upgrade-fork | 48297376 | 4 pass (after fixing a truffle overload clash with the new 4-arg redeem) |
| live-nav-fork | 52890976 / 52896800 | 7 / 7 pass |
| zero-premium-flash-fork | 52890976 / 52896800 | 19 / 19 pass (entry 17.52-22.73 bps, exit -2.53..-0.13 bps at 52890976) |
| fold-vault-preview (release strategy behind the proxy) | 52890976 / 52896800 | 30 / 30 pass |
| upgrade-rehearsal-fork | 52896800 | 13 pass |

## Not fixed here (pre-existing, carried)

- No high-water mark on fees (the daily CAPO sawtooth is charged on each up-leg).
- `_handleFee` borrows the whole fee with no try/catch, so a huge fee could revert doHardWork.
- The lever now depends on Aave mode-2 flashloans. The delever falls back to Aave mode 0 (with premium) when Morpho is short.
