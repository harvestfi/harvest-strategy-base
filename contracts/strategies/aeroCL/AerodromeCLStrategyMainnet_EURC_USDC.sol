//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./AerodromeCLStrategy.sol";

/// @notice EURC/USDC (tickSpacing 50) on the first Aerodrome Slipstream deployment
/// (factory 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A, position manager
/// 0x827922686190790b37229fd06084350E74485b72) — the same deployment the cbETH/ETH1 and
/// tBTC/cbBTC vaults already use, and which has no gauge early-exit penalty.
///
/// One implementation serves every EURC/USDC vault: the gauge is fixed per pool, while the
/// position width is a per-vault parameter set from the seed NFT at `initializeVault`. Deploying
/// several `StrategyProxy` instances against this implementation (one per vault) is how the
/// side-by-side posWidth comparison is run.
contract AerodromeCLStrategyMainnet_EURC_USDC is AerodromeCLStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address gauge = address(0x1f6c9d116CE22b51b0BC666f86B038a6c19900B8);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    AerodromeCLStrategy.initializeBaseStrategy(
      _storage,
      _vault,
      gauge,
      aero
    );
    rewardTokens = [aero];
  }

  function finalizeUpgrade() external override onlyGovernance {
    _finalizeUpgrade();
    _reseedRewardTokens(address(0x940181a94A35A4569E4529A3CDfB74e38FD98631)); // AERO
  }
}
