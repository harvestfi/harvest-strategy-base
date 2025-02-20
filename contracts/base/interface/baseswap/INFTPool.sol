// SPDX-License-Identifier: MIT
pragma solidity 0.8.21;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface INFTPool is IERC721 {
    function exists(uint256 tokenId) external view returns (bool);
    function hasDeposits() external view returns (bool);
    function getPoolInfo()
        external
        view
        returns (
            address lpToken,
            address protocolToken,
            address xToken,
            uint256 lastRewardTime,
            uint256 accRewardsPerShare,
            uint256 accRewardsPerShareWETH,
            uint256 lpSupply,
            uint256 lpSupplyWithMultiplier,
            uint256 allocPoint,
            uint256 allocPointsWETH
        );
    function getStakingPosition(uint256 tokenId)
        external
        view
        returns (
            uint256 amount,
            uint256 amountWithMultiplier,
            uint256 startLockTime,
            uint256 lockDuration,
            uint256 lockMultiplier,
            uint256 rewardDebt,
            uint256 rewardDebtWETH,
            uint256 boostPoints,
            uint256 totalMultiplier
        );

    function boost(uint256 userAddress, uint256 amount) external;
    function unboost(uint256 userAddress, uint256 amount) external;

    function createPosition(uint256 amount, uint256 lockDuration) external;
    function addToPosition(uint256 tokenId, uint256 amountToAdd) external;
    function harvestPosition(uint256 tokenId) external;
    function withdrawFromPosition(uint256 tokenId, uint256 amountToWithdraw) external;
    function emergencyWithdraw(uint256 tokenId) external;

    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256);
}
