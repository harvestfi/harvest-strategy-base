//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

interface ISwapPool {
  function token0() external view returns (address);
  function token1() external view returns (address);
  function swap(
    address recipient,
    bool zeroForOne,
    int256 amountSpecified,
    uint160 sqrtPriceLimitX96,
    bytes calldata data
  ) external returns (int256 amount0, int256 amount1);
}

interface IERC20Min {
  function transfer(address to, uint256 amount) external returns (bool);
  function balanceOf(address who) external view returns (uint256);
}

/// @notice Test-only helper that pushes a live Slipstream pool's spot price by swapping through it.
///
/// Without this, a fork rehearsal can only ever exercise the no-op rebalance path: the seed
/// position is minted centred on spot, so by the time `rebalanceCurrentTick` runs the recentred
/// range equals the current one and no burn/swap/mint happens. The interesting case — the one the
/// 50%-stranding bug lived in — is a position that has gone fully one-sided, and reaching it
/// requires actually moving the pool.
///
/// Fund this contract with the input token first; the swap callback pays out of its own balance.
contract CLPoolPriceMover {
  function move(
    address pool,
    bool zeroForOne,
    int256 amountSpecified,
    uint160 sqrtPriceLimitX96
  ) external returns (int256 amount0, int256 amount1) {
    return ISwapPool(pool).swap(address(this), zeroForOne, amountSpecified, sqrtPriceLimitX96, abi.encode(pool));
  }

  function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
    address pool = abi.decode(data, (address));
    require(msg.sender == pool, "CLPoolPriceMover: bad caller");
    if (amount0Delta > 0) IERC20Min(ISwapPool(pool).token0()).transfer(pool, uint256(amount0Delta));
    if (amount1Delta > 0) IERC20Min(ISwapPool(pool).token1()).transfer(pool, uint256(amount1Delta));
  }
}
