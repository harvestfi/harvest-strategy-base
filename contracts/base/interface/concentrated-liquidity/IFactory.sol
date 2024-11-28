// SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

interface IFactory {
    function getPool(address token0, address token1, int24 tickSpacing) external view returns (address);
}