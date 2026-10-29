// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interface/IUniversalLiquidator.sol";

/// @notice Test-only Universal Liquidator that executes the real swap but delivers only a fraction
/// of the proceeds, simulating a badly-routed or high-impact path. It still enforces the caller's
/// `minBuyAmount` exactly as a real UL does, so a caller that passes a meaningful bound is protected
/// and a caller that passes 1 is not.
///
/// This exists to prove the fold leg's bound actually bites: with `plan.minOut` threaded through,
/// a lossy route must be REFUSED; with the old `amountOutMin = 1`, it would execute silently.
contract MockLossyUL {
    address public immutable real;
    uint256 public immutable keepBps; // share of the output withheld

    constructor(address _real, uint256 _keepBps) {
        real = _real;
        keepBps = _keepBps;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minBuyAmount, address to)
        external
        returns (uint256)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).approve(real, 0);
        IERC20(tokenIn).approve(real, amountIn);
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IUniversalLiquidator(real).swap(tokenIn, tokenOut, amountIn, 1, address(this));
        uint256 got = IERC20(tokenOut).balanceOf(address(this)) - before;
        uint256 delivered = (got * (10_000 - keepBps)) / 10_000;
        require(delivered >= minBuyAmount, "MOCK: below minOut");
        IERC20(tokenOut).transfer(to, delivered);
        return delivered;
    }
}
