// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "./interface/ICLRebalanceHelper.sol";
import "./interface/IUniversalLiquidator.sol";
import "./interface/concentrated-liquidity/INonfungiblePositionManager.sol";
import "./interface/concentrated-liquidity/IPool.sol";
import "./interface/concentrated-liquidity/IFactory.sol";
import "./interface/concentrated-liquidity/TickMath.sol";
import "./interface/concentrated-liquidity/LiquidityAmounts.sol";

/// @notice The NFT choreography of a twin-position range rebalance, moved out of `CLVaultV2` to
/// stay under the 24,576-byte deploy limit.
///
/// These are `external` library functions, so they are deployed once, linked, and reached by
/// DELEGATECALL — meaning `address(this)` is the STRATEGY while they run. That matters: the
/// strategy holds BOTH position NFTs (staked and buffer alike) and stays the caller the position
/// manager sees, so nothing has to be transferred to make this work.
///
/// The library deliberately takes everything it needs as parameters and returns the new tokenIds
/// rather than reaching into vault storage. Storage stays the vault's business; this is only the
/// burn/swap/mint sequence.
library CLRebalanceLibV2 {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @dev Boxed to keep the delegatecall's stack under the 16-slot limit.
    struct Ctx {
        address posManager;
        address token0;
        address token1;
        address pool;
        address helper;
        address universalLiquidator;
        int24 tickSpacing;
        uint32 twapWindow;
        uint256 maxSwapBps;
        uint256 maxSlippageBps;
        uint256 maxTwapDeviationBps;
        uint256 targetStakedBps;
    }

    uint256 private constant _BPS = 10_000;

    /// @notice Burn both old positions, swap the freed tokens toward the new range's ratio, and
    /// mint the replacement pair split by `targetStakedBps`.
    ///
    /// Both positions must end on the SAME range — that invariant is what makes the vault's
    /// `stakedLiquidity + bufferLiquidity` a valid measure of what it owns, so the two mints here
    /// are never allowed to diverge.
    function rebalanceBoth(
        Ctx memory ctx,
        uint256 stakedPosId,
        uint256 bufferPosId,
        int24 newLower,
        int24 newUpper,
        uint256 burnMin0,
        uint256 burnMin1
    ) external returns (uint256 newStaked, uint256 newBuffer) {
        // Burn mins were quoted against the two positions combined, so apportion them by the
        // current split instead of applying the whole figure to each burn (which would revert).
        uint256 stakedL = _liquidityOf(ctx.posManager, stakedPosId);
        uint256 totalL = stakedL + _liquidityOf(ctx.posManager, bufferPosId);
        uint256 shareBps = totalL == 0 ? 0 : (stakedL * _BPS) / totalL;

        _burnPosition(ctx.posManager, stakedPosId, (burnMin0 * shareBps) / _BPS, (burnMin1 * shareBps) / _BPS);
        _burnPosition(
            ctx.posManager,
            bufferPosId,
            (burnMin0 * (_BPS - shareBps)) / _BPS,
            (burnMin1 * (_BPS - shareBps)) / _BPS
        );

        _swapIdleForRange(ctx, newLower, newUpper);

        // Splitting the token amounts by the target ratio splits the resulting liquidity in the
        // same ratio, because both mints use one range. No quoting needed to hit the target.
        uint256 b0 = IERC20Upgradeable(ctx.token0).balanceOf(address(this));
        uint256 b1 = IERC20Upgradeable(ctx.token1).balanceOf(address(this));
        uint256 s0 = (b0 * ctx.targetStakedBps) / _BPS;
        uint256 s1 = (b1 * ctx.targetStakedBps) / _BPS;

        newStaked = _mintAt(ctx, newLower, newUpper, s0, s1);
        newBuffer = _mintAt(ctx, newLower, newUpper, b0 - s0, b1 - s1);
    }

    /// @notice Move `liquidity` from one position to the other. Safe only because their ranges are
    /// identical: the tokens `from` releases are exactly what `to` consumes at any price, so
    /// nothing needs swapping and nothing is lost beyond rounding.
    function moveLiquidity(
        address posManager,
        address token0,
        address token1,
        uint256 from,
        uint256 to,
        uint256 liquidity
    ) external {
        if (liquidity == 0) return;
        // Ask BEFORE touching the source. The post-decrease check below is a safety net, but by the
        // time it fires the source has already been drained and the value is stranded as idle — and
        // at a range boundary that can be an arbitrarily large slice, not dust. Predicting the
        // released amounts with the same formula the pool uses lets the move decline cleanly and
        // leave the position exactly as it was.
        {
            (uint256 p0, uint256 p1) = _amountsFor(posManager, from, liquidity);
            if (_liquidityFor(posManager, to, p0, p1) == 0) return;
        }
        (uint256 a0, uint256 a1) = INonfungiblePositionManager(posManager).decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: from,
                liquidity: uint128(liquidity),
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            })
        );
        _collectAll(posManager, from);
        if (a0 == 0 && a1 == 0) return;

        // A move small enough that the destination would mint ZERO liquidity is rejected by the
        // NPM — 'NP' from Position.update when the destination is empty, and `require(amount > 0)`
        // in pool.mint otherwise. Either way it reverts the WHOLE caller, which for a 100%-of-supply
        // redemption means the last holder can never exit, and for a dust-sized shortfall means a
        // failure whose threshold widens as the two tokens' decimals converge.
        //
        // So ask the question directly rather than catching the revert. This reproduces exactly what
        // the NPM is about to compute — same formula, same sqrtPriceX96, no state change in between
        // — which matters because a blanket try/catch would ALSO swallow genuine failures and
        // silently strand real value as idle. Note this must not over-trigger: when the pool is
        // outside the range a single-sided move (one amount legitimately zero) still mints non-zero
        // liquidity and has to go through.
        if (_liquidityFor(posManager, to, a0, a1) == 0) {
            // The tokens stay with the strategy as idle and are folded back in by the next compound
            // (or by `preInteract`, which now runs before every deposit and withdrawal).
            //
            // Do NOT read the caller's clamp as making this whole: it only prevents a revert. The
            // skip is safe for the dust it was written for, but the same branch is reachable for an
            // ARBITRARILY LARGE move — park spot one wei inside the lower boundary and the released
            // amount1 floors to zero while amount0 is the entire value, so min(L0, 0) == 0. Serving
            // a withdrawal from the clamped buffer there would burn the caller's full shares and
            // hand the difference to whoever remains, which is why `CLVaultV2.withdraw` refuses a
            // materially uncovered shortfall outright rather than short-paying.
            return;
        }

        _approve(token0, posManager, a0);
        _approve(token1, posManager, a1);
        INonfungiblePositionManager(posManager).increaseLiquidity(
            INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId: to,
                amount0Desired: a0,
                amount1Desired: a1,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            })
        );
    }

    // ----------------------------------------------------------------------------------------

    /// @dev The token amounts `decreaseLiquidity(id, liquidity)` would release right now.
    function _amountsFor(address posManager, uint256 id, uint256 liquidity)
        private
        view
        returns (uint256, uint256)
    {
        (,, address t0, address t1, int24 ts, int24 tl, int24 tu,,,,,) =
            INonfungiblePositionManager(posManager).positions(id);
        address pool = IFactory(INonfungiblePositionManager(posManager).factory()).getPool(t0, t1, ts);
        (uint160 sqrtP,,,,,) = IPool(pool).slot0();
        return LiquidityAmounts.getAmountsForLiquidity(
            sqrtP, TickMath.getSqrtRatioAtTick(tl), TickMath.getSqrtRatioAtTick(tu), uint128(liquidity)
        );
    }

    /// @dev The liquidity `increaseLiquidity(to, a0, a1)` would mint right now.
    function _liquidityFor(address posManager, uint256 id, uint256 a0, uint256 a1)
        private
        view
        returns (uint128)
    {
        // Derive the pool from the POSITION ITSELF — its own tokens and tick spacing through the
        // position manager's factory. Taking it from the gauge instead would make this quote
        // silently depend on `setGauge` pointing at a matching pool; the position can never
        // disagree with itself.
        (,, address t0, address t1, int24 ts, int24 tl, int24 tu,,,,,) =
            INonfungiblePositionManager(posManager).positions(id);
        address pool = IFactory(INonfungiblePositionManager(posManager).factory()).getPool(t0, t1, ts);
        (uint160 sqrtP,,,,,) = IPool(pool).slot0();
        return LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtRatioAtTick(tl), TickMath.getSqrtRatioAtTick(tu), a0, a1
        );
    }

    function _liquidityOf(address posManager, uint256 id) private view returns (uint256) {
        if (id == 0) return 0;
        (,,,,,,, uint128 liq,,,,) = INonfungiblePositionManager(posManager).positions(id);
        return uint256(liq);
    }

    function _burnPosition(address posManager, uint256 id, uint256 min0, uint256 min1) private {
        uint256 liq = _liquidityOf(posManager, id);
        if (liq > 0) {
            INonfungiblePositionManager(posManager).decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: id,
                    liquidity: uint128(liq),
                    amount0Min: min0,
                    amount1Min: min1,
                    deadline: block.timestamp
                })
            );
        }
        _collectAll(posManager, id);
        INonfungiblePositionManager(posManager).burn(id);
    }

    function _collectAll(address posManager, uint256 id) private {
        INonfungiblePositionManager(posManager).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: id,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
    }

    function _swapIdleForRange(Ctx memory ctx, int24 lower, int24 upper) private {
        uint256 b0 = IERC20Upgradeable(ctx.token0).balanceOf(address(this));
        uint256 b1 = IERC20Upgradeable(ctx.token1).balanceOf(address(this));
        if (b0 == 0 && b1 == 0) return;

        ICLRebalanceHelper.RebalanceSwapPlan memory plan = ICLRebalanceHelper(ctx.helper).planSwapForMint(
            ctx.pool, lower, upper, b0, b1, ctx.maxSwapBps, ctx.maxSlippageBps, ctx.twapWindow, ctx.maxTwapDeviationBps
        );
        if (!plan.shouldSwap || plan.amountIn == 0 || plan.minOut == 0) return;

        (address tokenIn, address tokenOut) =
            plan.zeroForOne ? (ctx.token0, ctx.token1) : (ctx.token1, ctx.token0);
        _approve(tokenIn, ctx.universalLiquidator, plan.amountIn);
        IUniversalLiquidator(ctx.universalLiquidator).swap(
            tokenIn, tokenOut, plan.amountIn, plan.minOut, address(this)
        );
    }

    function _mintAt(Ctx memory ctx, int24 lower, int24 upper, uint256 amount0, uint256 amount1)
        private
        returns (uint256 tokenId)
    {
        (uint256 min0, uint256 min1) = ICLRebalanceHelper(ctx.helper).quoteMintMins(
            ctx.pool, ctx.twapWindow, lower, upper, amount0, amount1, ctx.maxSlippageBps
        );
        _approve(ctx.token0, ctx.posManager, amount0);
        _approve(ctx.token1, ctx.posManager, amount1);
        (tokenId,,,) = INonfungiblePositionManager(ctx.posManager).mint(
            INonfungiblePositionManager.MintParams({
                token0: ctx.token0,
                token1: ctx.token1,
                tickSpacing: ctx.tickSpacing,
                tickLower: lower,
                tickUpper: upper,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: min0,
                amount1Min: min1,
                recipient: address(this),
                deadline: block.timestamp + 900,
                sqrtPriceX96: 0
            })
        );
    }

    function _approve(address token, address spender, uint256 amount) private {
        IERC20Upgradeable(token).safeApprove(spender, 0);
        IERC20Upgradeable(token).safeApprove(spender, amount);
    }
}
