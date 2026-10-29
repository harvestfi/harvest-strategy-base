//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

/// @notice The parts of the second-deployment ("F2") Aerodrome CL gauge that the V2 strategy needs
/// beyond `ICLGauge`, plus its factory's penalty configuration.
///
/// Verified on Base against gauge implementation 0x434BCcaB043311a20b16021C137EA81702790f7B and
/// gauge factory 0x385293CaE378C813F16f0C1334d774AdDDf56AbB:
///
///   * `penaltyRate()` is 10000 — a withdraw or claim inside the window forfeits 100% of accrued
///     AERO, not a fraction of it.
///   * `minStakeTimes(pool)` is the per-pool window. It is currently 300s in practice, but
///     `MAX_MIN_STAKE_TIME` is 604800 (7 days) and `notifyAdmin` can raise it in a single tx with
///     no notice, so nothing here may hardcode a duration — always read it live.
///   * `depositTimestamp(tokenId)` is set on `deposit()` and is NOT moved by `getReward()`. Only
///     unstake+restake restarts it. That is what makes harvesting safe to do freely and makes the
///     buffer refill the only clock-resetting maintenance operation.
///   * `earned()` reports the penalty-ADJUSTED claimable amount, so it reads 0 while inside the
///     window even though emissions are accruing.
interface ICLGaugeV2 {
    function deposit(uint256 tokenId) external;

    function withdraw(uint256 tokenId) external;

    function getReward(uint256 tokenId) external;

    function earned(address account, uint256 tokenId) external view returns (uint256);

    /// @notice Timestamp the position was staked. Reset on every re-stake, untouched by getReward.
    function depositTimestamp(uint256 tokenId) external view returns (uint256);

    function stakedContains(address depositor, uint256 tokenId) external view returns (bool);

    function gaugeFactory() external view returns (address);

    function pool() external view returns (address);
}

interface ICLGaugeFactoryV2 {
    /// @notice Per-pool minimum stake time in seconds. Mutable by the factory's notifyAdmin.
    function minStakeTimes(address pool) external view returns (uint256);

    function defaultMinStakeTime() external view returns (uint256);

    /// @notice Forfeit applied inside the window, in bps. Observed as 10000 (total forfeit).
    function penaltyRate() external view returns (uint256);

    function MAX_MIN_STAKE_TIME() external view returns (uint256);
}
