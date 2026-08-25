//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./AerodromeCLStrategy.sol";

/// @notice WETH/cbBTC (tickSpacing 100) on the FIRST Aerodrome Slipstream deployment
/// (factory 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A, position manager
/// 0x827922686190790b37229fd06084350E74485b72).
///
/// Distinct from `AerodromeCLStrategyMainnet_WETH_cbBTC`, which targets the tickSpacing-10 pool
/// on the SECOND deployment. That one is deeper and pays far more, but its gauge carries the
/// early-exit penalty (100% of accrued AERO forfeited when claiming inside `minStakeTime`).
/// This F1 gauge has no penalty surface at all — verified on-chain: `penaltyRate()`,
/// `minStakeTimes(address)` and `defaultMinStakeTime()` all revert on gauge factory
/// 0xD30677bd8dd15132F251Cb54CbDA552d2A05Fb08.
///
/// Note the pool's own fee tier is 0.25%, which makes frequent rebalancing expensive: at
/// posWidth=1 the swap cost alone runs to triple-digit APR. Wide ranges are strongly preferred
/// here — see scripts/config/weth-cbbtc-f1-w*.json.
contract AerodromeCLStrategyMainnet_WETH_cbBTC_F1 is AerodromeCLStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address gauge = address(0x41b2126661C673C2beDd208cC72E85DC51a5320a);
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
