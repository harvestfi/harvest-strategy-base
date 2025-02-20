// SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;


interface IOptimismMintableERC20Factory {
    function createOptimismMintableERC20(address, string memory, string memory) external;
}
