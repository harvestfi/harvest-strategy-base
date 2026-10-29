// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

/// @notice Test-only stand-in for a Uniswap V3 pool's oracle. observe([window, 0]) returns cumulatives that
/// differ by `delta`, so UniV3TwapFeed sees a mean tick of delta / window, including ticks no live pool sits
/// at and deltas that do not divide evenly (to exercise the rounding).
contract MockObservePool {
    address public token0;
    address public token1;
    int56 public delta;

    constructor(address _token0, address _token1) {
        (token0, token1) = _token0 < _token1 ? (_token0, _token1) : (_token1, _token0);
    }

    function setDelta(int56 _delta) external {
        delta = _delta;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; i++) {
            tickCumulatives[i] = secondsAgos[i] == 0 ? delta : int56(0);
        }
    }
}
