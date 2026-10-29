// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "./interface/IChainlinkAggregator.sol";
import "./interface/concentrated-liquidity/TickMath.sol";

interface IUniV3PoolObservations {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/**
 * @title UniV3TwapFeed
 * @dev A Chainlink-shaped USD price for a token that has no Chainlink feed, read from Uniswap V3 pools on
 * this chain: the time-weighted average tick of each pool along `path`, ending in a token that does have a
 * feed (WETH and ETH/USD). RewardForwarderV2 reads it like any other feed, so its floor for a swap into or
 * out of the token becomes the Base market price over the last `window` seconds, less its tolerance.
 *
 * A TWAP cannot be moved inside one block, so a swap pushed just before ours does not move the floor. When a
 * pool cannot cover the window (too few observations), `latestRoundData` reverts and the forwarder skips
 * the swap instead of pricing it. `updatedAt` is the quote feed's, so the forwarder's maxAge also bounds the
 * age of the USD leg.
 */
contract UniV3TwapFeed is IChainlinkAggregator {
    /// @notice the token this feed prices
    address public immutable token;
    /// @notice the Chainlink USD feed of the last token in `path`
    address public immutable quoteFeed;
    /// @notice averaging window in seconds
    uint32 public immutable window;

    uint256 private immutable baseUnit;
    uint256 private immutable quoteUnit;
    uint256 private immutable quoteScale;
    address[] private _path;
    address[] private _pools;
    string public description;

    error PathMismatch(uint256 hop);

    /**
     * @param path_ token, intermediate tokens..., quote token (has `quoteFeed`)
     * @param pools_ the pool for each hop: pools_[i] holds path_[i] and path_[i + 1]
     * @param quoteFeed_ Chainlink USD feed of the quote token
     * @param window_ TWAP window in seconds
     */
    constructor(
        address[] memory path_,
        address[] memory pools_,
        address quoteFeed_,
        uint32 window_,
        string memory description_
    ) {
        require(pools_.length > 0 && path_.length == pools_.length + 1, "path length");
        require(window_ >= 300, "window");
        for (uint256 i; i < pools_.length; i++) {
            address t0 = IUniV3PoolObservations(pools_[i]).token0();
            address t1 = IUniV3PoolObservations(pools_[i]).token1();
            bool matches = (t0 == path_[i] && t1 == path_[i + 1]) || (t1 == path_[i] && t0 == path_[i + 1]);
            if (!matches) revert PathMismatch(i);
        }
        uint8 feedDecimals = IChainlinkAggregator(quoteFeed_).decimals();
        require(feedDecimals <= 18, "feed decimals");
        token = path_[0];
        quoteFeed = quoteFeed_;
        window = window_;
        baseUnit = 10 ** IERC20Metadata(path_[0]).decimals();
        quoteUnit = 10 ** IERC20Metadata(path_[path_.length - 1]).decimals();
        quoteScale = 10 ** (18 - feedDecimals);
        _path = path_;
        _pools = pools_;
        description = description_;
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function path() external view returns (address[] memory) {
        return _path;
    }

    function pools() external view returns (address[] memory) {
        return _pools;
    }

    /// @notice quote-token wei for one whole `token`, at each pool's average tick over `window`
    function twapQuote() public view returns (uint256 amount) {
        amount = baseUnit;
        for (uint256 i; i < _pools.length; i++) {
            int24 tick = _meanTick(_pools[i]);
            amount = _quoteAtTick(tick, amount, _path[i], _path[i + 1]);
        }
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        int256 quoteUsd;
        (roundId, quoteUsd, startedAt, updatedAt, answeredInRound) = IChainlinkAggregator(quoteFeed).latestRoundData();
        require(quoteUsd > 0, "quote feed");
        uint256 price = Math.mulDiv(twapQuote(), uint256(quoteUsd) * quoteScale, quoteUnit);
        // A pool pushed past its last liquidity reaches an extreme tick almost for free. Capping the answer
        // keeps the forwarder's floor arithmetic from overflowing outside its try/catch: such a price reverts
        // here, and the forwarder skips the swap instead of reverting its whole run.
        require(price > 0 && price <= type(uint128).max, "price");
        answer = int256(price);
    }

    /// @dev Uniswap's OracleLibrary.consult: the arithmetic mean tick, rounded towards negative infinity
    function _meanTick(address pool) internal view returns (int24 tick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        (int56[] memory cumulatives,) = IUniV3PoolObservations(pool).observe(secondsAgos);
        int56 delta = cumulatives[1] - cumulatives[0];
        tick = int24(delta / int56(uint56(window)));
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) tick--;
    }

    /// @dev Uniswap's OracleLibrary.getQuoteAtTick: `amountIn` of `tokenIn` priced in `tokenOut` at `tick`.
    /// OpenZeppelin's mulDiv, because the repo's FullMath runs its 512-bit path in checked arithmetic.
    function _quoteAtTick(int24 tick, uint256 amountIn, address tokenIn, address tokenOut)
        internal
        pure
        returns (uint256)
    {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            return tokenIn < tokenOut
                ? Math.mulDiv(ratioX192, amountIn, 1 << 192)
                : Math.mulDiv(1 << 192, amountIn, ratioX192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
        return tokenIn < tokenOut
            ? Math.mulDiv(ratioX128, amountIn, 1 << 128)
            : Math.mulDiv(1 << 128, amountIn, ratioX128);
    }
}
