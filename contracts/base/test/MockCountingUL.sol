// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interface/IUniversalLiquidator.sol";

/// @notice Test-only Universal Liquidator that forwards every swap to the real one and counts them.
/// Lets a test assert the ABSENCE of liquidator interaction, which no balance-based check can do
/// unambiguously: a swap that is skipped and a swap that returns nothing look identical from the
/// outside, and `swapSkippedCount` only moves when a swap was attempted AND failed.
contract MockCountingUL {
    address public immutable real;
    uint256 public swapCount;

    constructor(address _real) {
        real = _real;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256)
    {
        swapCount++;
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).approve(real, 0);
        IERC20(tokenIn).approve(real, amountIn);
        return IUniversalLiquidator(real).swap(tokenIn, tokenOut, amountIn, minOut, to);
    }
}
