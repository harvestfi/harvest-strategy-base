// SPDX-License-Identifier: AGPL-3.0
pragma solidity 0.6.12;

interface IIncentivesController {
  function claimAllRewards(address[] calldata assets, address to) external;
  function getUserRewards(address[] calldata assets, address user, address reward) external view returns (uint256);
}