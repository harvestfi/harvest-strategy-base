// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

interface IOptimismMintableERC20Factory {
    function createOptimismMintableERC20(address, string memory, string memory) external;
}
