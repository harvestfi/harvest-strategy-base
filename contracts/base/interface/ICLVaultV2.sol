//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./ICLVault.sol";

/// @notice Twin-position CL vault. `posId()` is the STAKED position (in the gauge, earning AERO);
/// `bufferPosId()` is the UNSTAKED buffer on the same pool with an identical range, which absorbs
/// every deposit and serves every withdrawal so that user flow never touches the gauge.
interface ICLVaultV2 is ICLVault {
    function bufferPosId() external view returns (uint256);

    function stakedLiquidity() external view returns (uint256);

    function bufferLiquidity() external view returns (uint256);

    /// @notice stakedLiquidity + bufferLiquidity. Exact because both positions share a range, so a
    /// unit of liquidity means the same thing in either one.
    function totalLiquidity() external view returns (uint256);

    /// @notice Current staked share of total liquidity, in bps.
    function stakedRatioBps() external view returns (uint256);

    function targetStakedBps() external view returns (uint256);

    function stakeRatioBandBps() external view returns (uint256);

    /// @notice True when the staked position is clear of the gauge's forfeit window (plus the
    /// configured safety margin), i.e. when discretionary operations may unstake for free.
    function isOutsideStakeWindow() external view returns (bool);

    function stakeWindowEnd() external view returns (uint256);

}
