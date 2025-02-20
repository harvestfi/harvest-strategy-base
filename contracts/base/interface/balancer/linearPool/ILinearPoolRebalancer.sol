// SPDX-License-Identifier: Unlicense

pragma solidity 0.8.21;

interface ILinearPoolRebalancer {
    function rebalance(address recipient) external;
    function rebalanceWithExtraMain(address recipient, uint256 extraMain) external;
}
