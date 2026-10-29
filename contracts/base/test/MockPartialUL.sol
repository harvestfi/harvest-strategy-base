// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interface/IUniversalLiquidator.sol";

/// @notice Test-only Universal Liquidator that forwards to the real one but refuses to produce one
/// specific output token. It reproduces a state this project has already seen in production: a UL
/// route that reverts for a single pair (the EURC/USDC path did exactly that until `setTickSpacing`
/// was re-called on the adapter) while every other route keeps working.
///
/// The strategy swallows a failed reward swap on purpose, so this leaves idle sitting on ONE side
/// only — which is the state that makes an unguarded fold into an out-of-range position mint zero
/// liquidity and revert.
contract MockPartialUL {
    address public immutable real;
    address public immutable blockedOut;

    constructor(address _real, address _blockedOut) {
        real = _real;
        blockedOut = _blockedOut;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256)
    {
        require(tokenOut != blockedOut, "MOCK: route down");
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).approve(real, 0);
        IERC20(tokenIn).approve(real, amountIn);
        return IUniversalLiquidator(real).swap(tokenIn, tokenOut, amountIn, minOut, to);
    }
}
