// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

interface IFoldRecVault {
  function totalAssets() external view returns (uint256);
  function getPricePerFullShare() external view returns (uint256);
  function previewRedeem(uint256) external view returns (uint256);
}

interface IFoldRecStrategy {
  function storedBalance() external view returns (uint256);
  function pendingFee() external view returns (uint256);
}

interface IFoldRecProxy {
  function implementation() external view returns (address);
}

interface IFoldRecSpectraPT {
  function getIBTRate() external view returns (uint256);
}

/**
 * Test-only. The upgrade rehearsal puts calls to record() between the calls of a
 * Safe MultiSend batch, so the vault's values can be compared inside one
 * transaction (same block, same Aave interest, same oracle price) right before
 * and right after each upgrade step. It only reads; it is never part of the
 * batches in the runbook.
 */
contract FoldUpgradeRecorder {
  struct Snap {
    uint256 totalAssets;
    uint256 ppfs;
    uint256 previewRedeem;
    uint256 ibtRate;        // what the Spectra PT reads: previewRedeem(1e18) in ray
    uint256 storedBalance;
    uint256 pendingFee;
    address strategyImpl;
    address vaultImpl;
  }

  Snap[] public snaps;

  function record(address vault, address strategy, address pt) external {
    snaps.push(Snap({
      totalAssets: IFoldRecVault(vault).totalAssets(),
      ppfs: IFoldRecVault(vault).getPricePerFullShare(),
      previewRedeem: IFoldRecVault(vault).previewRedeem(1e18),
      ibtRate: IFoldRecSpectraPT(pt).getIBTRate(),
      storedBalance: IFoldRecStrategy(strategy).storedBalance(),
      pendingFee: IFoldRecStrategy(strategy).pendingFee(),
      strategyImpl: IFoldRecProxy(strategy).implementation(),
      vaultImpl: IFoldRecProxy(vault).implementation()
    }));
  }

  function count() external view returns (uint256) {
    return snaps.length;
  }
}
