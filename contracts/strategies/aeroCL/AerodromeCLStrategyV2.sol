//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/utils/ERC721HolderUpgradeable.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/upgradability/BaseUpgradeableStrategyCL.sol";
import "../../base/interface/aerodrome/ICLGaugeV3.sol";
import "../../base/interface/ICLVaultV2.sol";
import "../../base/interface/concentrated-liquidity/INonfungiblePositionManager.sol";
import "../../base/CLRebalanceLibV2.sol";
import "../../base/interface/ICLRebalanceHelper.sol";

/// @notice Strategy half of the twin-position design, for gauges with an early-exit penalty.
///
/// Deliberately NOT derived from `AerodromeCLStrategy`: that contract's `doHardWork` and its
/// staking internals are non-virtual, and inheriting them would leave a callable path that
/// unstakes inside the forfeit window — precisely the failure this design exists to prevent.
///
/// Targets the post-merger Aero V3 CL gauges (`ICLGaugeV3`). Their window is block-based and per
/// tokenId; see that interface for the verified semantics.
///
/// What changes versus V1:
///   * `doHardWork` is gated on being clear of the gauge window. A claim inside it forfeits ALL of
///     the position's accrued emissions, so harvesting there would burn them.
///   * The gate FAILS CLOSED: if the window cannot be read, `stakeWindowEnd` reports "inside" and the
///     harvest is skipped rather than claiming blind.
///   * Compounded rewards go into the vault's BUFFER position, not the staked one. Adding to the
///     staked position is impossible anyway — the position manager only lets the gauge touch a
///     staked NFT — and routing to the buffer keeps the cushion topped up without an unstake. The
///     buffer is never staked, so it has no window of its own to re-arm.
///   * The window is always read live (`depositBlock` plus the factory's `effectivePenaltyConfig`).
///     It is 7–150 blocks today, but the PENALTY_ADMIN can raise it to 90000 blocks retroactively,
///     so nothing may cache or hardcode it.
///   * A tx whose claim failed never goes on to stake: `unstake(true)` reverts instead, and every
///     caller of it re-stakes in the same tx.
///   * Exit paths (`unstake(false)`, `emergencyExit`) are never window-gated. They fall back to the
///     gauge's `emergencyWithdraw` if its claiming `withdraw` reverts.
contract AerodromeCLStrategyV2 is BaseUpgradeableStrategyCL, ERC721HolderUpgradeable {
  using SafeERC20 for IERC20;

  /// @dev Same strategist address V1 uses; declared here rather than inherited because V2
  /// deliberately does not derive from AerodromeCLStrategy.
  address public constant harvestMSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);

  address[] public rewardTokens;
  mapping(address => uint256) public minRewardToCompound;

  /// @notice Reward already charged its profit share but not yet swapped — the residue a swallowed
  /// `_swap` leaves behind. Tracked so the next cycle does not charge it a second time.
  uint256 public unprocessedReward;
  mapping(address => bool) public rewardTokenAllowed;

  /// @dev Emergency lanes, mirroring V1. `pausedInvesting` lives in the base storage; these two do
  /// not, so they are declared here.
  bool public harvestPaused;
  bool public withdrawOnlyMode;

  /// @dev DEPRECATED, as in V1: never read by any code path. Reward swaps go out with minOut = 1
  /// and are guarded by `minRewardToCompound`; the REBALANCE bound is the vault's, passed in as a
  /// parameter. Do NOT wire this into `_minOutFor` without a real quote — see the note there.
  ///
  /// Retained because it occupies slot 156 on the live proxies and `swapSkippedCount` (157) and
  /// `lastSwapSkippedAt` (158) sit behind it, so deleting it would shift both under every
  /// deployed vault. (It does NOT reproduce V1's layout — V1 orders these members differently and
  /// has no `unprocessedReward` — so V1 parity is not a reason to keep it. Slot stability is.)
  uint256 public maxSlippageBps;
  uint256 public swapSkippedCount;
  uint256 public lastSwapSkippedAt;

  event HarvestSkippedInsideWindow(uint256 windowEndBlock, uint256 blockNumber);
  event ClaimFailed(address gauge);
  event EmergencyStateUpdated(bool pauseInvesting, bool pauseHarvesting, bool withdrawOnly);
  event GaugeUpdated(address oldGauge, address newGauge);
  event CompoundedIntoBuffer(uint256 amount0, uint256 amount1, uint128 liquidity);

  error ErrInsideStakeWindow(uint256 windowEnd);
  error ErrNotStaked();
  error ErrNotVault();
  error ErrBadSlippage();
  error ErrZeroGauge();
  error ErrClaimFailed();

  /// @dev Both position NFTs live here — the staked one (lent to the gauge while staked) and the
  /// unstaked buffer. Keeping them under one owner means every NFT mutation has a single caller,
  /// so `decreaseLiquidity`/`collect`/`burn`/`mint`, which are all ownership-checked, never need
  /// the token to change hands mid-operation.
  modifier onlyVault() {
    if (msg.sender != vault()) revert ErrNotVault();
    _;
  }

  function bufferPosId() public view returns (uint256) {
    return ICLVaultV2(vault()).bufferPosId();
  }

  constructor() {}

  function initializeBaseStrategy(
    address _storage,
    address _vault,
    address _rewardPool,
    address _rewardToken
  ) public initializer {
    BaseUpgradeableStrategyCL.initialize(_storage, _vault, _rewardPool, _rewardToken, harvestMSIG);
    rewardTokens = [_rewardToken];
    rewardTokenAllowed[_rewardToken] = true;
    minRewardToCompound[_rewardToken] = 1e16;
    maxSlippageBps = 10_000;
  }

  // --------------------------------------------------------------------------------------------
  // window state — the whole point of V2
  // --------------------------------------------------------------------------------------------

  /// @notice The block at which the staked position leaves the forfeit window: the gauge's
  /// `depositBlock` plus the factory's live `minStakeBlocks`. Zero when nothing is staked or the
  /// gauge's penalty is switched off, which reads as "outside".
  ///
  /// FAILS CLOSED: if the gauge or its factory cannot be read, this returns `type(uint256).max`, so
  /// the harvest gate skips instead of claiming into an unknown window. Low-level calls rather than
  /// try/catch, because try/catch does not catch a return that fails to decode. Exit paths read this
  /// only for reporting, so a failed read can never hold up a withdrawal.
  function stakeWindowEnd() public view returns (uint256) {
    if (!_nftStaked()) return 0;
    address gauge = rewardPool();
    (bool ok, bytes memory ret) = gauge.staticcall(abi.encodeCall(ICLGaugeV3.gaugeFactory, ()));
    if (!ok || ret.length < 32) return type(uint256).max;
    (ok, ret) = abi.decode(ret, (address)).staticcall(
      abi.encodeCall(ICLGaugeFactoryV3.effectivePenaltyConfig, (gauge))
    );
    if (!ok || ret.length < 64) return type(uint256).max;
    (uint256 minStakeBlocks, uint256 penaltyRate) = abi.decode(ret, (uint256, uint256));
    // Mirrors the gauge's own `_applyPenalty` condition.
    if (penaltyRate == 0 || minStakeBlocks == 0) return 0;
    (ok, ret) = gauge.staticcall(abi.encodeCall(ICLGaugeV3.depositBlock, (posId())));
    if (!ok || ret.length < 32) return type(uint256).max;
    uint256 depositBlock = abi.decode(ret, (uint256));
    if (depositBlock > type(uint256).max - minStakeBlocks) return type(uint256).max;
    return depositBlock + minStakeBlocks;
  }

  function isOutsideStakeWindow() public view returns (bool) {
    return block.number >= stakeWindowEnd();
  }

  /// @notice What a claim right now would pay, as reported by the gauge, including any deferred
  /// emissions. `earned()` is penalty-adjusted, so it reads 0 for the position while inside.
  function claimableNow() external view returns (uint256) {
    if (!_nftStaked()) return 0;
    uint256[] memory ids = new uint256[](1);
    ids[0] = posId();
    try ICLGaugeV3(rewardPool()).earned(address(this), ids) returns (uint256 v) {
      return v;
    } catch {
      return 0;
    }
  }

  // --------------------------------------------------------------------------------------------
  // staking
  // --------------------------------------------------------------------------------------------

  function _nftStaked() internal view returns (bool) {
    return INonfungiblePositionManager(posManager()).ownerOf(posId()) == rewardPool();
  }

  function stakePosition() external restricted {
    if (pausedInvesting()) return;
    uint256 id = posId();
    if (INonfungiblePositionManager(posManager()).ownerOf(id) != address(this)) return;
    // The gauge rejects an empty position — it reaches through to Position.update, which reverts
    // 'NP' on a zero liquidity delta. That happens after a 100%-of-supply redemption has drained
    // the staked side, and because re-staking is the last step of `withdraw`, the revert would
    // take the whole redemption with it and leave the final holder permanently unable to exit.
    // There is nothing to stake in that state, so treat it as a no-op.
    (,,,,,,, uint128 liq,,,,) = INonfungiblePositionManager(posManager()).positions(id);
    if (liq == 0) return;
    IERC721(posManager()).approve(rewardPool(), id);
    ICLGaugeV3(rewardPool()).deposit(id);
  }

  /// @notice Pull the staked position out of the gauge. It stays HERE rather than going to the
  /// vault: this contract owns both positions, so the ownership-checked NPM calls that follow
  /// (decrease/collect/burn/mint) can all be made without moving anything.
  ///
  /// Callers only reach this from paths that have already accepted the forfeit (a withdrawal
  /// larger than the buffer) or that are gated on the window having elapsed.
  ///
  /// With `compound`, the claim must succeed: every caller that compounds (a range rebalance, a
  /// strategy swap) re-stakes later in the same tx, and staking after a failed claim is what this
  /// design must never do. If the claim keeps failing, `emergencyExit` unstakes without claiming.
  function unstake(bool compound) public restricted {
    if (compound && isOutsideStakeWindow()) {
      _claimAndCompound(true);
    }
    if (_nftStaked()) {
      _gaugeWithdraw();
    }
  }

  /// @dev `withdraw` claims on the way out (deferring the emissions if their mint fails), so the
  /// emissions side of the gauge can still make it revert. An exit must not depend on that, so fall
  /// back to `emergencyWithdraw`, which drops the accrual but returns the NFT. It only works while
  /// the gauge factory allows it; if it does not, its revert is the one that surfaces.
  function _gaugeWithdraw() internal {
    address gauge = rewardPool();
    uint256 id = posId();
    try ICLGaugeV3(gauge).withdraw(id) {} catch {
      ICLGaugeV3(gauge).emergencyWithdraw(id);
    }
  }

  /// @dev Kept for IStrategy compatibility (the controller and vault interface both declare it).
  /// Same behaviour as `unstake`: the NFTs stay with this contract by design.
  function withdrawAllToVault(bool compound) public restricted {
    unstake(compound);
  }

  // --------------------------------------------------------------------------------------------
  // position mutation — only the owner may do these, and the owner is this contract
  // --------------------------------------------------------------------------------------------

  /// @notice Add liquidity to the buffer from tokens the vault has already sent here.
  function increaseBuffer(uint256 amount0, uint256 amount1) external onlyVault returns (uint128 liq) {
    if (amount0 == 0 && amount1 == 0) return 0;
    address pm = posManager();
    _approveNpm(token0(), pm, amount0);
    _approveNpm(token1(), pm, amount1);
    uint256 used0;
    uint256 used1;
    (liq, used0, used1) = INonfungiblePositionManager(pm).increaseLiquidity(
      INonfungiblePositionManager.IncreaseLiquidityParams({
        tokenId: bufferPosId(),
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0,
        amount1Min: 0,
        deadline: block.timestamp
      })
    );
    // Hand back exactly what the position did not take. The vault forwards the depositor's whole
    // amount, and a range almost never consumes both sides fully, so without this the remainder
    // would sit here unaccounted — invisible to totalLiquidity() and unwithdrawable by anyone.
    // Refunding the precise delta (rather than the whole balance) leaves any pre-existing idle,
    // e.g. un-compounded reward dust, untouched.
    if (amount0 > used0) IERC20(token0()).safeTransfer(msg.sender, amount0 - used0);
    if (amount1 > used1) IERC20(token1()).safeTransfer(msg.sender, amount1 - used1);
  }

  /// @notice Remove liquidity from the buffer and send the proceeds to `to`.
  function decreaseBuffer(uint128 liquidity, uint256 min0, uint256 min1, address to)
    external
    onlyVault
    returns (uint256 amount0, uint256 amount1)
  {
    if (liquidity == 0) return (0, 0);
    address pm = posManager();
    uint256 id = bufferPosId();
    address t0 = token0();
    address t1 = token1();
    (uint256 principal0, uint256 principal1) = INonfungiblePositionManager(pm).decreaseLiquidity(
      INonfungiblePositionManager.DecreaseLiquidityParams({
        tokenId: id,
        liquidity: liquidity,
        amount0Min: min0,
        amount1Min: min1,
        deadline: block.timestamp
      })
    );
    // decreaseLiquidity only credits tokensOwed; collect moves it. collect(max) necessarily sweeps
    // the position's ENTIRE uncollected fee balance, not just this withdrawer's share — so pay out
    // only the principal the burn released and leave the fees here, where the next compound folds
    // them back into the buffer for every holder. Paying out the collected total instead would let
    // one exit drain the fees everyone else earned.
    INonfungiblePositionManager(pm).collect(
      INonfungiblePositionManager.CollectParams({
        tokenId: id,
        recipient: address(this),
        amount0Max: type(uint128).max,
        amount1Max: type(uint128).max
      })
    );
    amount0 = principal0;
    amount1 = principal1;
    if (amount0 > 0) IERC20(t0).safeTransfer(to, amount0);
    if (amount1 > 0) IERC20(t1).safeTransfer(to, amount1);
  }

  /// @notice Shift liquidity between the two positions. Valid only because their ranges are
  /// identical, so what one releases is exactly what the other consumes at any price.
  function moveLiquidity(uint256 from, uint256 to, uint256 liquidity) external onlyVault {
    CLRebalanceLibV2.moveLiquidity(
      posManager(), token0(), token1(), from, to, liquidity
    );
  }

  /// @notice Burn both positions and mint a replacement pair on `newLower`/`newUpper`, split by
  /// `targetStakedBps`. Runs the library under DELEGATECALL so this contract stays the NFT owner.
  ///
  /// `slippageBps` is deliberately NOT this contract's `maxSlippageBps` slot, and is named apart
  /// from it so the two cannot be confused. The VAULT owns the rebalance bound and passes its own
  /// `_maxSlippageBps()` in; the slot here is a deprecated leftover that nothing reads.
  function rebalanceRanges(
    address pool,
    address helper,
    int24 newLower,
    int24 newUpper,
    uint256 burnMin0,
    uint256 burnMin1,
    uint256 targetStakedBps,
    uint256 maxSwapBps,
    uint256 slippageBps,
    uint32 twapWindow,
    uint256 maxTwapDeviationBps
  ) external onlyVault returns (uint256 newStaked, uint256 newBuffer) {
    return CLRebalanceLibV2.rebalanceBoth(
      CLRebalanceLibV2.Ctx({
        posManager: posManager(),
        token0: token0(),
        token1: token1(),
        pool: pool,
        helper: helper,
        universalLiquidator: IController(controller()).universalLiquidator(),
        tickSpacing: ICLVaultV2(vault()).tickSpacing(),
        twapWindow: twapWindow,
        maxSwapBps: maxSwapBps,
        maxSlippageBps: slippageBps,
        maxTwapDeviationBps: maxTwapDeviationBps,
        targetStakedBps: targetStakedBps
      }),
      posId(),
      bufferPosId(),
      newLower,
      newUpper,
      burnMin0,
      burnMin1
    );
  }

  /// @notice Hand both positions to the incoming strategy during a governance strategy swap.
  /// They move together — a split ownership would break the vault's accounting invariant.
  function migratePositions(address to) external onlyVault {
    if (to == address(0)) return;
    address pm = posManager();
    uint256 a = posId();
    uint256 b = bufferPosId();
    if (INonfungiblePositionManager(pm).ownerOf(a) == address(this)) {
      IERC721(pm).safeTransferFrom(address(this), to, a);
    }
    if (INonfungiblePositionManager(pm).ownerOf(b) == address(this)) {
      IERC721(pm).safeTransferFrom(address(this), to, b);
    }
    // The NFTs are not the whole balance sheet. Unstaking claims the accrued AERO to this
    // contract, and compounding leaves token0/token1 dust behind, so a migration that moved only
    // the positions would strand that value on a decommissioned strategy — permanently, because
    // the reward token and both pool tokens are all in `unsalvagableTokens` and cannot be
    // recovered by governance either.
    _sweepTo(to, token0());
    _sweepTo(to, token1());
    uint256 n = rewardTokens.length;
    for (uint256 i = 0; i < n; i++) {
      _sweepTo(to, rewardTokens[i]);
    }
  }

  function _sweepTo(address to, address token) private {
    if (token == address(0)) return;
    uint256 bal = IERC20(token).balanceOf(address(this));
    if (bal > 0) IERC20(token).safeTransfer(to, bal);
  }

  function _approveNpm(address token, address spender, uint256 amount) private {
    IERC20(token).safeApprove(spender, 0);
    IERC20(token).safeApprove(spender, amount);
  }

  // --------------------------------------------------------------------------------------------
  // harvest
  // --------------------------------------------------------------------------------------------

  /// @notice Claim AERO and compound it into the vault's buffer position.
  ///
  /// Claiming does NOT move the gauge's `depositBlock` (verified in the gauge source), so this never
  /// extends the window — it only has to wait for the window to pass so the claim actually pays.
  /// The window is re-read here, in the claiming tx, so a retroactive raise is always honoured.
  function doHardWork() external onlyNotPausedInvesting restricted {
    if (harvestPaused || withdrawOnlyMode) return;
    uint256 end = stakeWindowEnd();
    if (block.number < end) {
      // Not an error: the keeper is expected to retry. Reverting would make a routine, expected
      // condition look like a failure in every monitoring surface.
      emit HarvestSkippedInsideWindow(end, block.number);
      return;
    }
    _claimAndCompound(false);
  }

  /// @dev Claim the staked position's emissions plus anything the gauge deferred for us. Callers
  /// must already be outside the window. Returns false, without reverting, if the claim failed.
  function _claimEmissions() internal returns (bool) {
    address gauge = rewardPool();
    bool staked = _nftStaked();
    uint256[] memory ids = new uint256[](staked ? 1 : 0);
    if (staked) {
      ids[0] = posId();
    } else {
      // The gauge reverts 'NS' on an empty claim; with nothing staked or deferred there is nothing
      // to claim, which is not a failure.
      try ICLGaugeV3(gauge).deferredEmissions(address(this)) returns (uint256 d) {
        if (d == 0) return true;
      } catch {
        return true;
      }
    }
    try ICLGaugeV3(gauge).claimEmissions(address(this), address(this), ids) {
      return true;
    } catch {
      emit ClaimFailed(gauge);
      return false;
    }
  }

  function _claimAndCompound(bool requireClaim) internal {
    if (!_claimEmissions() && requireClaim) revert ErrClaimFailed();
    // Collect the BUFFER's accrued swap fees so they compound too. Only the buffer earns them —
    // the staked side's fees go to voters via the gauge — and left uncollected they sit as
    // tokensOwed: outside totalLiquidity(), outside NAV, and earning nothing.
    try INonfungiblePositionManager(posManager()).collect(
      INonfungiblePositionManager.CollectParams({
        tokenId: bufferPosId(),
        recipient: address(this),
        amount0Max: type(uint128).max,
        amount1Max: type(uint128).max
      })
    ) {} catch {}
    // Fold even when reward selling is off: collected fees are not a reward sale. But fold WITHOUT
    // swapping — `setSell(false)` is the rapid-exit switch, and in V1 it returned before any
    // liquidator interaction at all. Letting the fold's planner swap here would mean governance
    // could no longer stop the strategy touching a broken or manipulated UL route.
    if (!sell()) {
      _absorbIdleIntoBuffer(false);
      return;
    }

    address _rewardToken = rewardToken();
    uint256 balance = IERC20(_rewardToken).balanceOf(address(this));
    if (balance < minRewardToCompound[_rewardToken]) {
      // Below the compound gate there is no reward worth swapping, but idle token0/token1 may
      // still be sitting here — collected fees from a withdrawal, a move whose increase was
      // absorbed, leftovers from a prior cycle. `totalLiquidity()` counts NFT liquidity only, so
      // that idle is value the vault owns but does not report and no one can withdraw. Fold it in
      // regardless, which is what V1's `_absorbIdleIntoPosition` did on every cycle.
      _absorbIdleIntoBuffer(true);
      return;
    }

    // `_swap` deliberately swallows a failed reward swap, so `balance` can include reward that a
    // previous cycle already charged. Charging the profit share on the whole balance again would
    // bill the same tokens twice over.
    uint256 fresh = balance > unprocessedReward ? balance - unprocessedReward : 0;
    if (fresh > 0) _notifyProfitInRewardToken(_rewardToken, fresh);
    uint256 remaining = IERC20(_rewardToken).balanceOf(address(this));
    if (remaining == 0) {
      unprocessedReward = 0;
      return;
    }

    address _vault = vault();
    address t0 = ICLVaultV2(_vault).token0();
    address t1 = ICLVaultV2(_vault).token1();

    // Convert the whole reward into ONE pool token and let the planner in `_absorbIdleIntoBuffer`
    // size the second leg. Splitting 50/50 here was the bug: the correct ratio depends on where
    // spot sits inside the range and is rarely half, so a fixed split strands whichever side the
    // position cannot take. Skip the swap entirely when the reward already IS a pool token.
    if (_rewardToken != t0 && _rewardToken != t1) {
      _swap(_rewardToken, t0, remaining);
    }

    // Fold the swapped proceeds in through the SAME guarded path the below-gate branch uses. It
    // has to be guarded here too: when the pool sits outside the range only ONE token contributes
    // liquidity, so a cycle whose swap left nothing on that side would mint zero and revert — and
    // a reverting compound bricks every harvest, with the dust that caused it never clearing.
    _absorbIdleIntoBuffer(true);

    // Whatever is STILL held after the fold is reward that was charged but never converted, and is
    // what the next cycle must not charge again. This has to be read after the fold, not before:
    // when the reward token IS one of the pool tokens the fold consumes it, and recording the
    // pre-fold balance would carry a phantom credit forward and undercharge the fee every cycle.
    unprocessedReward = IERC20(_rewardToken).balanceOf(address(this));
  }

  /// @notice Fold any idle token0/token1 held here into the buffer position. Never reverts: a
  /// dust-sized balance can mint zero liquidity, and that must not brick a harvest.
  function _absorbIdleIntoBuffer(bool allowSwap) internal {
    address t0 = token0();
    address t1 = token1();
    uint256 b0 = IERC20(t0).balanceOf(address(this));
    uint256 b1 = IERC20(t1).balanceOf(address(this));
    if (b0 == 0 && b1 == 0) return;

    // Size a swap so the (b0, b1) ratio matches what pool.mint will ACTUALLY consume at the current
    // spot, using the same range-aware planner the rebalance path uses. Without this the deposit is
    // whatever ratio the reward swaps happened to produce, and the position takes only the smaller
    // side: observed on-chain leaving 44,527 of 67,883 USDC (66%) unconsumed on a single compound.
    // V1 did exactly this in `_absorbIdleIntoPosition`; V2 had dropped it.
    address _vault = vault();
    address helper = ICLVaultV2(_vault).rebalanceHelper();
    if (allowSwap && helper != address(0)) {
      // Both helper calls sit INSIDE try/catch. `poolAddressFor` was previously outside it, so a
      // helper fault would revert every harvest rather than degrading to an unplanned fold.
      try ICLRebalanceHelper(helper).poolAddressFor(
        posManager(), t0, t1, ICLVaultV2(_vault).tickSpacing()
      ) returns (address pool) {
        try ICLRebalanceHelper(helper).planSwapForMint(
          pool,
          ICLVaultV2(_vault).tickLower(),
          ICLVaultV2(_vault).tickUpper(),
          b0,
          b1,
          10000,
          100,
          0,
          0
        ) returns (ICLRebalanceHelper.RebalanceSwapPlan memory plan) {
          // minOut == 0 means the helper could not price the leg; CLRebalanceLibV2 refuses the swap
          // in that case and so does this. Swapping unpriced is what the bound exists to prevent.
          if (plan.shouldSwap && plan.amountIn > 0 && plan.minOut > 0) {
            if (plan.zeroForOne) {
              _swapBounded(t0, t1, plan.amountIn, plan.minOut);
            } else {
              _swapBounded(t1, t0, plan.amountIn, plan.minOut);
            }
          }
        } catch {}
      } catch {}
      b0 = IERC20(t0).balanceOf(address(this));
      b1 = IERC20(t1).balanceOf(address(this));
      if (b0 == 0 && b1 == 0) return;
    }

    address pm = posManager();
    _approveNpm(t0, pm, b0);
    _approveNpm(t1, pm, b1);
    try INonfungiblePositionManager(pm).increaseLiquidity(
      INonfungiblePositionManager.IncreaseLiquidityParams({
        tokenId: bufferPosId(),
        amount0Desired: b0,
        amount1Desired: b1,
        amount0Min: 0,
        amount1Min: 0,
        deadline: block.timestamp
      })
    ) returns (uint128 liq, uint256 used0, uint256 used1) {
      // Report what the position actually took, not what was offered.
      emit CompoundedIntoBuffer(used0, used1, liq);
    } catch {
      _approveNpm(t0, pm, 0);
      _approveNpm(t1, pm, 0);
    }
  }

  function _swap(address tokenIn, address tokenOut, uint256 amountIn) internal {
    if (amountIn == 0 || tokenIn == tokenOut) return;
    address ul = IController(controller()).universalLiquidator();
    IERC20(tokenIn).safeApprove(ul, 0);
    IERC20(tokenIn).safeApprove(ul, amountIn);
    // A failed reward swap must never brick a harvest: swallow it, record it, and let the next
    // cycle retry with the accumulated balance.
    try IUniversalLiquidator(ul).swap(tokenIn, tokenOut, amountIn, _minOutFor(amountIn), address(this)) {}
    catch {
      IERC20(tokenIn).safeApprove(ul, 0);
      swapSkippedCount += 1;
      lastSwapSkippedAt = block.timestamp;
    }
  }

  /// @notice Swap with a REAL, quote-derived minimum, for the token0<->token1 fold leg.
  ///
  /// `_swap` deliberately passes 1 because reward liquidation has no quote to bound against (see
  /// `_minOutFor`). The fold leg is different: `planSwapForMint` already returns `minOut` priced off
  /// the pool, in raw tokenOut units, so the bound is available and dimensionally correct. V1 passed
  /// it (`_swapWithBound(..., plan.minOut)`) and CLRebalanceLibV2 passes it; this restoration
  /// initially dropped it, which left up to 100% of the idle balance swapping at amountOutMin = 1 —
  /// unbounded against route quality or price impact, and silent because a bad-price swap still
  /// succeeds. If the bound cannot be met the UL reverts, this records a skip, and the fold degrades
  /// to leaving the idle for the next cycle: strictly the pre-fix behaviour, never worse.
  function _swapBounded(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut) internal {
    if (amountIn == 0 || tokenIn == tokenOut || minOut == 0) return;
    address ul = IController(controller()).universalLiquidator();
    IERC20(tokenIn).safeApprove(ul, 0);
    IERC20(tokenIn).safeApprove(ul, amountIn);
    try IUniversalLiquidator(ul).swap(tokenIn, tokenOut, amountIn, minOut, address(this)) {}
    catch {
      IERC20(tokenIn).safeApprove(ul, 0);
      swapSkippedCount += 1;
      lastSwapSkippedAt = block.timestamp;
    }
  }

  /// @dev Mirrors V1's `_boundedMinOutFromIn`, which returns 1: reward liquidation is protected by
  /// the size gate (`minRewardToCompound`) rather than a per-swap bound.
  ///
  /// An earlier version of this scaled `amountIn` by `maxSlippageBps` and passed the result as
  /// `amountOutMin`. That is dimensionally wrong — `amountIn` is denominated in tokenIn and
  /// `amountOutMin` in tokenOut — so for AERO->WETH (both 18dp, AERO ~2e-4 WETH) even a very loose
  /// 9900 bps demanded roughly 50x the swap's true output, and for AERO->cbBTC (18dp -> 8dp) it was
  /// off by a further 1e10. Every swap would revert; `_swap` catches that, so harvests would keep
  /// reporting success while AERO silently accumulated and never compounded.
  ///
  /// Deliberately kept at 1 rather than re-derived here. A real bound needs a quote, not a ratio of
  /// the input: `ICLRebalanceHelper` already exposes the TWAP machinery to price the leg, and that
  /// is the shape any future bound should take.
  function _minOutFor(uint256) internal pure returns (uint256) {
    return 1;
  }

  // --------------------------------------------------------------------------------------------
  // emergency + operational controls (ported from V1 — their absence would leave governance with
  // no way to stop a misbehaving strategy or recover a stray token)
  // --------------------------------------------------------------------------------------------

  /// @notice Pull the position out of the gauge and stop all discretionary activity.
  ///
  /// Deliberately does NOT wait for the forfeit window: an emergency is exactly the case where
  /// losing the position's accrued AERO is preferable to staying in the gauge. Whether that costs
  /// anything is visible up-front: `claimableNow()` reads 0 while `isOutsideStakeWindow()` is false.
  function emergencyExit() public onlyGovernance {
    if (_nftStaked()) {
      _gaugeWithdraw();
    }
    _setPausedInvesting(true);
    harvestPaused = true;
    withdrawOnlyMode = true;
    emit EmergencyStateUpdated(true, true, true);
  }

  function continueInvesting() public onlyGovernance {
    _setPausedInvesting(false);
    harvestPaused = false;
    withdrawOnlyMode = false;
    emit EmergencyStateUpdated(false, false, false);
  }

  function setEmergencyState(bool _pauseInvesting, bool _pauseHarvesting, bool _withdrawOnly)
    external
    onlyGovernance
  {
    _setPausedInvesting(_pauseInvesting);
    harvestPaused = _pauseHarvesting;
    withdrawOnlyMode = _withdrawOnly;
    emit EmergencyStateUpdated(_pauseInvesting, _pauseHarvesting, _withdrawOnly);
  }

  /// @notice Tokens that may never be salvaged: the reward token, both pool tokens, and anything
  /// on the reward allowlist. Without this, salvage would be a governance drain of user funds.
  function unsalvagableTokens(address token) public view returns (bool) {
    return (token == rewardToken() || token == token0() || token == token1() || rewardTokenAllowed[token]);
  }

  function salvage(address recipient, address token, uint256 amount) external onlyControllerOrGovernance {
    require(!unsalvagableTokens(token), "token is defined as not salvagable");
    IERC20(token).safeTransfer(recipient, amount);
  }

  /// @notice Move to a different gauge. Unstakes first; claims only when that is free, since a
  /// migration inside the window would otherwise burn the accrued AERO on the way out.
  function setGauge(address _newGauge) external onlyGovernance {
    if (_newGauge == address(0)) revert ErrZeroGauge();
    address old = rewardPool();
    if (isOutsideStakeWindow()) {
      _claimAndCompound(false);
    }
    if (_nftStaked()) {
      _gaugeWithdraw();
    }
    _setRewardPool(_newGauge);
    emit GaugeUpdated(old, _newGauge);
  }

  function setSell(bool s) public onlyGovernance {
    _setSell(s);
  }

  function removeRewardToken(address _token) external onlyGovernance {
    rewardTokenAllowed[_token] = false;
    uint256 n = rewardTokens.length;
    for (uint256 i = 0; i < n; i++) {
      if (rewardTokens[i] == _token) {
        rewardTokens[i] = rewardTokens[n - 1];
        rewardTokens.pop();
        return;
      }
    }
  }

  // --------------------------------------------------------------------------------------------
  // admin
  // --------------------------------------------------------------------------------------------

  /// @notice Absorb any token0/token1 left sitting here into the buffer position.
  ///
  /// V1's `preInteract` swept idle tokens to the vault; in V2 the strategy owns the positions, so
  /// the correct analogue is to fold the dust into the buffer where it becomes counted liquidity.
  /// Left un-absorbed it would be value the vault owns but does not report, and therefore cannot
  /// be withdrawn.
  function preInteract() external restricted {
    address t0 = token0();
    address t1 = token1();
    address pm = posManager();

    // Fold whatever the buffer can actually take, so value stays productive rather than sitting
    // idle. Whatever the position consumes is by definition the two-sided portion.
    if (!withdrawOnlyMode) {
      uint256 a0 = IERC20(t0).balanceOf(address(this));
      uint256 a1 = IERC20(t1).balanceOf(address(this));
      if (a0 > 0 || a1 > 0) {
        _approveNpm(t0, pm, a0);
        _approveNpm(t1, pm, a1);
        try INonfungiblePositionManager(pm).increaseLiquidity(
          INonfungiblePositionManager.IncreaseLiquidityParams({
            tokenId: bufferPosId(),
            amount0Desired: a0,
            amount1Desired: a1,
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp
          })
        ) {} catch {}
        _approveNpm(t0, pm, 0);
        _approveNpm(t1, pm, 0);
      }
    }

    // Then SWEEP the remainder to the vault, exactly as V1's preInteract did. This is not optional
    // bookkeeping: `underlyingBalanceWithInvestment()` counts this balance and the vault prices every
    // mint on it, but `withdraw()` can only pay out the VAULT's own balance — so anything left here
    // is charged to depositors and payable to nobody. A one-sided remainder is the NORMAL state after
    // a range rebalance re-mints at the range's ratio, not an edge case, and at the current price it
    // is unfoldable by construction: whatever the fold above could take, it took.
    //
    // Left on the strategy it silently mispriced every deposit and withdrawal by strategyIdle/NAV
    // (measured at 599bps after one ordinary rebalance) and survived a 100%-of-supply redemption
    // with nothing able to reach it — salvage() and sweepStrayToken() both refuse the pool tokens.
    uint256 r0 = IERC20(t0).balanceOf(address(this));
    uint256 r1 = IERC20(t1).balanceOf(address(this));
    address v = vault();
    if (r0 > 0) IERC20(t0).safeTransfer(v, r0);
    if (r1 > 0) IERC20(t1).safeTransfer(v, r1);
  }

  function setMaxSlippageBps(uint256 v) external onlyGovernance {
    if (v > 10_000) revert ErrBadSlippage();
    maxSlippageBps = v;
  }

  function setMinRewardToCompound(address _token, uint256 _threshold) external onlyGovernance {
    minRewardToCompound[_token] = _threshold;
  }

  function addRewardToken(address _token) public onlyGovernance {
    rewardTokens.push(_token);
    rewardTokenAllowed[_token] = true;
  }

  function finalizeUpgrade() external virtual onlyGovernance {
    _finalizeUpgrade();
  }
}
