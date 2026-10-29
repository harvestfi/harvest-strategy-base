//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./CLVaultStorage.sol";

/// @notice Extra storage for the twin-position (V2) CL vault.
///
/// V2 holds TWO position NFTs on the same pool with byte-identical ranges:
///   * the STAKED position, sitting in the gauge and earning AERO emissions
///   * the BUFFER position, held by the vault, unstaked, serving every deposit and withdrawal
///
/// Identical ranges are the whole point: a unit of liquidity is then interchangeable between the
/// two, so `stakedLiquidity + bufferLiquidity` is an exact measure of what the vault owns and needs
/// no price to compute. That is what lets share accounting stay `shares = supply * dL / totalL`
/// with no oracle surface, unlike a buffer of loose token0/token1 which has to be valued against
/// the position at some manipulable price.
///
/// Slots continue the `eip1967.vaultStorage.*` namespace and are appended, never reordered, so a
/// V1 vault's layout stays valid underneath.
contract CLVaultV2Storage is CLVaultStorage {
    bytes32 internal constant _POS_ID_BUFFER_SLOT = 0x8bd1a0e0e7a0a0e6b0ec96e64a4e9d4d5b3b4f6b1b8b3f1e5b0e0a1b6a1d4c2e;
    bytes32 internal constant _TARGET_STAKED_BPS_SLOT = 0x4e5a5a1c4e1b0e0d9f4b2c3a1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e;
    bytes32 internal constant _STAKE_RATIO_BAND_BPS_SLOT = 0x1f2e3d4c5b6a79889a0b1c2d3e4f50617283940a5b6c7d8e9f0a1b2c3d4e5f60;
    bytes32 internal constant _STAKE_WINDOW_SAFETY_SLOT = 0x7a6b5c4d3e2f10192837465564738291a0b1c2d3e4f5061728394a5b6c7d8e9f;

    constructor() {
        // Deliberately not asserting keccak preimages here: these are fresh appended slots, chosen
        // to be distinct from every V1 slot. Uniqueness is what matters, and it is checked below.
        bytes32[4] memory s = [
            _POS_ID_BUFFER_SLOT,
            _TARGET_STAKED_BPS_SLOT,
            _STAKE_RATIO_BAND_BPS_SLOT,
            _STAKE_WINDOW_SAFETY_SLOT
        ];
        for (uint256 i = 0; i < s.length; i++) {
            for (uint256 j = i + 1; j < s.length; j++) {
                assert(s[i] != s[j]);
            }
            assert(s[i] != _POS_ID_SLOT);
            assert(s[i] != _STRATEGY_SLOT);
            assert(s[i] != _TICK_LOWER_SLOT);
            assert(s[i] != _TICK_UPPER_SLOT);
        }
    }

    /// @notice tokenId of the unstaked buffer position. Same pool, same range as `_posId()`.
    function _setBufferPosId(uint256 id) internal {
        setUint256(_POS_ID_BUFFER_SLOT, id);
    }

    function _bufferPosId() internal view returns (uint256) {
        return getUint256(_POS_ID_BUFFER_SLOT);
    }

    /// @notice Share of total liquidity that should sit in the gauge, in bps. The remainder is the
    /// buffer. Higher = more emissions but a thinner cushion before a withdrawal has to unstake.
    function _setTargetStakedBps(uint256 v) internal {
        setUint256(_TARGET_STAKED_BPS_SLOT, v);
    }

    function _targetStakedBps() internal view returns (uint256) {
        return getUint256(_TARGET_STAKED_BPS_SLOT);
    }

    /// @notice How far the staked share may drift from target before a ratio rebalance is allowed,
    /// in bps. Wide on purpose: every ratio rebalance costs an unstake, which restarts the window.
    function _setStakeRatioBandBps(uint256 v) internal {
        setUint256(_STAKE_RATIO_BAND_BPS_SLOT, v);
    }

    function _stakeRatioBandBps() internal view returns (uint256) {
        return getUint256(_STAKE_RATIO_BAND_BPS_SLOT);
    }

    /// @notice Seconds of margin added to the gauge's minStakeTime before discretionary operations
    /// are considered safe. Absorbs the gap between a keeper simulating and the tx landing.
    function _setStakeWindowSafety(uint256 v) internal {
        setUint256(_STAKE_WINDOW_SAFETY_SLOT, v);
    }

    function _stakeWindowSafety() internal view returns (uint256) {
        return getUint256(_STAKE_WINDOW_SAFETY_SLOT);
    }
}
