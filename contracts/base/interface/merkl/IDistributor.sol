//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

interface IDistributor {
    function toggleOperator(address user, address operator) external;
}
