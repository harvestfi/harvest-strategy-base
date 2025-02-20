// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

interface IPotPool {
    function initializePotPool(
        address[] calldata _rewardTokens,
        address _lpToken,
        uint256 _duration,
        address[] calldata _rewardDistribution,
        address _storage
    ) external;

    function lpToken() external view returns (address);

    function duration() external view returns (uint256);

    function stakedBalanceOf(address _user) external view returns (uint256);

    function smartContractStakers(address _user) external view returns (bool);

    function rewardTokens(uint256 _index) external view returns (address);

    function getRewardTokens() external view returns (address[] memory);

    function periodFinishForToken(address _rewardToken) external view returns (uint256);

    function rewardRateForToken(address _rewardToken) external view returns (uint256);

    function lastUpdateTimeForToken(address _rewardToken) external view returns (uint256);

    function rewardPerTokenStoredForToken(address _rewardToken) external view returns (uint256);

    function userRewardPerTokenPaidForToken(address _rewardToken, address _user) external view returns (uint256);

    function rewardsForToken(address _rewardToken, address _user) external view returns (uint256);

    function lastTimeRewardApplicable(address _rewardToken) external view returns (uint256);

    function rewardPerToken(address _rewardToken) external view returns (uint256);

    function stake(uint256 _amount) external;

    function withdraw(uint256 _amount) external;

    function exit() external;

    /**
     * A push mechanism for accounts that have not claimed their rewards for a long time. The implementation is
     * semantically analogous to getReward(), but uses a push pattern instead of pull pattern.
     */
    function pushAllRewards(address _recipient) external;

    function getAllRewards() external;

    function getReward(address _rewardToken) external;

    function addRewardToken(address _rewardToken) external;

    function removeRewardToken(address _rewardToken) external;

    /**
     * @return If the return value is MAX_UINT256, it means that the specified reward token is not in the list
     */
    function getRewardTokenIndex(address _rewardToken) external view returns (uint256);

    function notifyTargetRewardAmount(address _rewardToken, uint256 _reward) external;

    function rewardTokensLength() external view returns (uint256);
}
