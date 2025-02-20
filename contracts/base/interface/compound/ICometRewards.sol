// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

/**
 * @title Compound's CometRewards Contract
 * @notice Hold and claim token rewards
 * @author Compound
 */
interface ICometRewards {
    struct RewardOwed {
        address token;
        uint256 owed;
    }

    function claim(address comet, address src, bool accrue) external;
    function getRewardOwed(address comet, address account) external returns (RewardOwed memory);
}
