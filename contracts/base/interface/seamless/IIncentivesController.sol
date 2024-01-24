// SPDX-License-Identifier: AGPL-3.0
pragma solidity 0.6.12;

interface IIncentivesController {
  function claimAllRewards(address[] calldata assets, address to) external;
}