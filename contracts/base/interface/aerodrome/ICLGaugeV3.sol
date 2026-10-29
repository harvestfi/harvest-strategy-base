//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

/// @notice The post-merger ("V3") Aero CL gauge, as far as the twin-position strategy needs it, plus
/// its factory's penalty configuration.
///
/// Verified on Base against the CLGauge implementation 0x89E91A960154b1ed6c093039a8f0725ab67d14e0
/// (cloned by CLGaugeFactory 0xf437f62053ACB121665b8fDBfeA8F214FB8E589d, LeafVoter
/// 0x382409fad8503FbCdbB27A4211551fa03e884078, position manager 0x4857DB576eE0e45F10525eC59527BfD10beeC60b):
///
///   * The window is BLOCK-based and per tokenId. `depositBlock(tokenId)` is written on every deposit,
///     deleted on withdraw, and never moved by `claimEmissions`.
///   * The penalty applies when `penaltyRate > 0 && minStakeBlocks > 0 && block.number < depositBlock
///     + minStakeBlocks`, with both values from `effectivePenaltyConfig(gauge)`, read live on every
///     claim. `penaltyRate` is in pips and is 1e6 (100%) today: a claim or withdraw inside the window
///     forfeits ALL of the position's accrued emissions. The PENALTY_ADMIN (a Safe, no timelock) can
///     raise `minStakeBlocks` up to `maxMinStakeBlocks` (90000) and the raise applies retroactively.
///   * There is no `isPenaltyActive` view on CL gauges; the window has to be computed from the above.
///   * `withdraw` always claims (deferring to `deferredEmissions` if the mint fails), so it is penalised
///     exactly like a claim. `emergencyWithdraw` does not claim and only works while the factory's
///     `emergencyWithdrawEnabled` flag is set.
///   * `earned` is penalty-adjusted: it reads 0 for a position inside the window.
interface ICLGaugeV3 {
    function deposit(uint256 tokenId) external;

    function withdraw(uint256 tokenId) external;

    function emergencyWithdraw(uint256 tokenId) external;

    /// @notice Claims `tokenIds` (all must be staked by `account`) plus the account's deferred emissions.
    /// Reverts 'NS' when `tokenIds` is empty and nothing is deferred.
    function claimEmissions(address account, address recipient, uint256[] calldata tokenIds) external;

    function earned(address account, uint256[] calldata tokenIds) external view returns (uint256);

    function deferredEmissions(address account) external view returns (uint256);

    /// @notice Block the position was last staked. Reset on every deposit, untouched by claims.
    function depositBlock(uint256 tokenId) external view returns (uint256);

    function stakedContains(address depositor, uint256 tokenId) external view returns (bool);

    function gaugeFactory() external view returns (address);

    function nft() external view returns (address);

    function pool() external view returns (address);
}

interface ICLGaugeFactoryV3 {
    struct PenaltyConfig {
        uint256 minStakeBlocks;
        uint256 penaltyRate;
    }

    /// @notice The config the gauge applies: the per-gauge minStakeBlocks override, or the factory
    /// default when the override is 0, plus the factory-wide penaltyRate.
    function effectivePenaltyConfig(address gauge) external view returns (PenaltyConfig memory);

    function emergencyWithdrawEnabled() external view returns (bool);

    function maxMinStakeBlocks() external view returns (uint256);
}
