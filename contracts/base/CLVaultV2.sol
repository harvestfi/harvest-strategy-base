// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/IERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/utils/ERC721HolderUpgradeable.sol";
import "./interface/IStrategy.sol";
import "./interface/IController.sol";
import "./interface/IUpgradeSource.sol";
import "./interface/ICLRebalanceHelper.sol";
import "./interface/IUniversalLiquidator.sol";
import "./inheritance/ControllableInit.sol";
import "./CLVaultV2Storage.sol";
import "./interface/concentrated-liquidity/INonfungiblePositionManager.sol";

/// @notice Twin-position CL vault for gauges that penalise early unstaking.
///
/// The second Aerodrome deployment's gauges forfeit 100% of accrued AERO on any withdraw or claim
/// made inside `minStakeTime` of the last stake. V1 unstakes on EVERY deposit and withdraw, so on
/// such a gauge every user interaction both forfeits the accrued rewards and restarts the window —
/// which is trivially grief-able.
///
/// V2 splits the vault's liquidity across two position NFTs on the same pool with byte-identical
/// ranges:
///
///   * `_posId()`        STAKED   — sits in the gauge, earns AERO emissions
///   * `_bufferPosId()`  BUFFER   — held here, unstaked, absorbs deposits and serves withdrawals
///
/// Because the ranges are identical, a unit of liquidity is interchangeable between them, so
/// `stakedLiquidity + bufferLiquidity` is an exact measure of what the vault owns and share
/// accounting stays `shares = supply * dL / totalL` with no price anywhere in it. A buffer of loose
/// token0/token1 would instead have to be valued against the position at some quoted price, which
/// is a manipulation surface; this design removes it rather than hardening it.
///
/// Consequences that shape the rest of this contract:
///   * Deposits and withdrawals touch ONLY the buffer, so they never enter the gauge, never
///     forfeit, and never restart the window.
///   * `getReward()` does not move the gauge's `depositTimestamp` (verified on-chain), so
///     compounding is free of clock effects — it only has to wait out the window to avoid the
///     forfeit itself.
///   * Every operation that unstakes DOES restart the window, so all of them are gated on being
///     outside it, and each takes the opportunity to re-split to the target ratio.
///   * A withdrawal larger than the buffer is the one exception: it is allowed to unstake and eat
///     the forfeit, because a vault that can refuse withdrawals is worse than one that loses a few
///     minutes of emissions. At the ~300s windows in practice that cost is negligible.
contract CLVaultV2 is ERC20Upgradeable, ERC721HolderUpgradeable, IUpgradeSource, ControllableInit, CLVaultV2Storage {
  using SafeERC20Upgradeable for IERC20Upgradeable;

  uint256 private constant _BPS_DENOMINATOR = 10_000;

  /// @dev Locals for `rebalanceCurrentTick`, boxed to stay under the EVM's 16-slot stack limit.
  struct RebalanceCache {
    address pool;
    uint32 window;
    uint256 slip;
    uint256 liquidityBefore;
    int24 newLower;
    int24 newUpper;
    uint256 burnMin0;
    uint256 burnMin1;
    uint256 oldStaked;
    uint256 oldBuffer;
    uint256 shareBps;
    uint256 b0;
    uint256 b1;
    uint256 s0;
    uint256 s1;
    uint256 newStaked;
    uint256 newBuffer;
  }

  event Deposit(address indexed sender, address indexed receiver, uint256 amount0, uint256 amount1, uint256 shares);
  event Withdraw(address indexed sender, address indexed receiver, uint256 amount0, uint256 amount1, uint256 shares);
  /// @notice Emitted when a withdrawal was larger than the buffer and had to unstake inside the
  /// forfeit window. `liquidityFromStaked` is how much had to come out of the gauge position.
  event ForcedUnstake(uint256 liquidityFromStaked, uint256 stakeWindowEnd, uint256 timestamp);
  event StakeRatioRebalanced(uint256 stakedLiquidity, uint256 bufferLiquidity, uint256 stakedBps);
  event StakeConfigUpdated(uint256 targetStakedBps, uint256 bandBps, uint256 windowSafety);
  event BufferPositionSet(uint256 bufferPosId);
  event StrategyAnnounced(address newStrategy, uint256 time);
  event StrategyChanged(address newStrategy, address oldStrategy);
  event RangeRebalanced(
    uint256 oldStakedPosId,
    uint256 oldBufferPosId,
    uint256 newStakedPosId,
    uint256 newBufferPosId,
    uint256 liquidityBefore,
    uint256 liquidityAfter
  );

  error ErrZeroAddress();
  error ErrZeroShares();
  error ErrTotalSupply();
  error ErrSlippage();
  error ErrStrategyUndefined();
  error ErrRangeMismatch();
  error ErrInsideStakeWindow();
  error ErrRatioInBand();
  error ErrBadConfig();
  error ErrPositionNotInVault();
  error ErrNotRebalanceExecutor();
  error ErrRebalancePaused();
  error ErrRebalanceCooldown();
  error ErrHarvestPaused();
  error ErrWithdrawOnly();
  error ErrProtectedToken();
  error ErrTimelock();
  error ErrDepositWithdrawPaused();
  error ErrVault();
  /// @dev A shortfall cover did not land: the buffer is still materially short of what the
  /// withdrawal owes, so paying the clamped amount would quietly hand the difference to the
  /// remaining holders.
  error ErrShortfallNotCovered(uint256 owed, uint256 available);

  // --------------------------------------------------------------------------------------------
  // init
  // --------------------------------------------------------------------------------------------

  /// @param _stakedPosId the position that will live in the gauge
  /// @param _bufferPosId a second position on the SAME pool with the SAME range, which stays
  ///        unstaked. Both are transferred in here; the caller is credited for the sum of their
  ///        liquidity, which is well defined precisely because the ranges match.
  function initializeVault(
    address _storage,
    uint256 _stakedPosId,
    uint256 _bufferPosId,
    address _posManager,
    uint256 _targetWidth,
    uint256 _targetStakedBps,
    uint256 _bandBps,
    uint256 _windowSafety
  ) public initializer {
    ControllableInit.initialize(_storage);
    if (_targetStakedBps == 0 || _targetStakedBps >= _BPS_DENOMINATOR) revert ErrBadConfig();
    if (_bandBps >= _BPS_DENOMINATOR) revert ErrBadConfig();

    IERC721Upgradeable(_posManager).transferFrom(msg.sender, address(this), _stakedPosId);
    IERC721Upgradeable(_posManager).transferFrom(msg.sender, address(this), _bufferPosId);

    (,, address _t0, address _t1, int24 _ts, int24 _lower, int24 _upper, uint256 _liqA,,,,) =
      INonfungiblePositionManager(_posManager).positions(_stakedPosId);
    (,,,,, int24 _lowerB, int24 _upperB, uint256 _liqB,,,,) =
      INonfungiblePositionManager(_posManager).positions(_bufferPosId);
    if (_lower != _lowerB || _upper != _upperB) revert ErrRangeMismatch();

    uint256 positionWidth = uint256(int256(_upper) - int256(_lower)) / uint256(uint24(_ts));
    if (_targetWidth > positionWidth) revert ErrBadConfig();

    CLVaultStorage.initialize(_stakedPosId, _posManager, positionWidth, _targetWidth);
    _setBufferPosId(_bufferPosId);
    _setTargetStakedBps(_targetStakedBps);
    _setStakeRatioBandBps(_bandBps);
    _setStakeWindowSafety(_windowSafety);

    string memory name = string(
      abi.encodePacked("fCLv2_", ERC20Upgradeable(_t0).symbol(), "_", ERC20Upgradeable(_t1).symbol())
    );
    __ERC20_init(name, name);

    _setToken0(_t0);
    _setToken1(_t1);
    _setTickSpacing(_ts);
    _setTickLower(_lower);
    _setTickUpper(_upper);

    _mint(msg.sender, _liqA + _liqB);

    // The tick comparison above is not sufficient on its own: two positions on DIFFERENT pools can
    // carry identical tick bounds, and their liquidity would not be fungible. Now that token0,
    // token1 and tickSpacing are set, run the same full invariant every other mutating path uses.
    _assertRangesMatch();
  }

  // --------------------------------------------------------------------------------------------
  // upgrade source
  // --------------------------------------------------------------------------------------------

  function _nextImplementationDelay() internal view returns (uint256) {
    return IController(controller()).nextImplementationDelay();
  }

  function scheduleUpgrade(address impl) public onlyGovernance {
    _setNextImplementation(impl);
    _setNextImplementationTimestamp(block.timestamp + _nextImplementationDelay());
  }

  function shouldUpgrade() external view override returns (bool, address) {
    return (
      _nextImplementationTimestamp() != 0
        && block.timestamp > _nextImplementationTimestamp()
        && _nextImplementation() != address(0),
      _nextImplementation()
    );
  }

  function finalizeUpgrade() external override onlyGovernance {
    _setNextImplementation(address(0));
    _setNextImplementationTimestamp(0);
  }

  // --------------------------------------------------------------------------------------------
  // views
  // --------------------------------------------------------------------------------------------

  // The strategy, wrappers, checker and the off-chain API all read the vault through these; they
  // live in CLVault.sol rather than the storage contract, so V2 has to restate them. Omitting them
  // does not fail to compile — interface calls are unchecked — it fails at runtime, which is how
  // this was missed in the first draft.
  function token0() external view returns (address) {
    return _token0();
  }

  function token1() external view returns (address) {
    return _token1();
  }

  function posManager() external view returns (address) {
    return _posManager();
  }

  function tickSpacing() external view returns (int24) {
    return _tickSpacing();
  }

  function tickLower() external view returns (int24) {
    return _tickLower();
  }

  function tickUpper() external view returns (int24) {
    return _tickUpper();
  }

  function targetWidth() external view returns (uint256) {
    return _targetWidth();
  }

  function posWidth() external view returns (uint256) {
    return _posWidth();
  }

  function strategy() external view returns (address) {
    return _strategy();
  }

  function rebalanceHelper() external view returns (address) {
    return _rebalanceHelper();
  }

  function getSqrtPriceX96() public view returns (uint160) {
    return ICLRebalanceHelper(_rebalanceHelper()).spotSqrtPriceX96(_poolAddress());
  }

  /// @notice Token amounts across BOTH positions. The API and wrappers use this to value the
  /// vault, so it has to cover the buffer as well as the staked side or it under-reports.
  function getCurrentTokenAmounts() external view returns (uint256, uint256) {
    ICLRebalanceHelper rh = ICLRebalanceHelper(_rebalanceHelper());
    address pool = _poolAddress();
    (uint256 a0, uint256 a1) = rh.getCurrentTokenAmounts(pool, _posManager(), _posId(), _tickLower(), _tickUpper());
    (uint256 b0, uint256 b1) =
      rh.getCurrentTokenAmounts(pool, _posManager(), _bufferPosId(), _tickLower(), _tickUpper());
    return (a0 + b0, a1 + b1);
  }

  /// @notice Value split between token0 and token1 at the current price.
  ///
  /// A weight is a function of price and range, not of size, and both positions share a range — so
  /// either one reports the same split as the pair. Read whichever is non-empty: quoting an EMPTY
  /// position returns (0, 0), and `CLWrapper._computeSwapPortion` treats that as un-splittable and
  /// blocks the deposit with WrapperSwapBelowPrecision. The staked side can legitimately be empty,
  /// for instance after an emergency exit.
  function getCurrentTokenWeights() external view returns (uint256, uint256) {
    uint256 id = stakedLiquidity() > 0 ? _posId() : _bufferPosId();
    return ICLRebalanceHelper(_rebalanceHelper()).getCurrentTokenWeights(
      _poolAddress(), _posManager(), id, _tickLower(), _tickUpper()
    );
  }

  /// @notice Chainlink/Gelato checker covering BOTH maintenance actions.
  ///
  /// Reports false while inside the forfeit window, and while rebalancing is paused, even when work is
  /// outstanding: neither call can succeed in those states, and a checker that keeps returning true for
  /// a call that would revert just burns upkeep funds.
  ///
  /// When both are due the RANGE rebalance is offered first. Every maintenance action costs a gauge
  /// window restart, and a range rebalance re-splits to target on its way out — so taking it first
  /// clears both conditions for the price of one restart, where the reverse order spends two.
  function checker() external view returns (bool canExec, bytes memory execPayload) {
    // Default payload preserves the historical shape for any caller that reads it without `canExec`.
    execPayload = abi.encodeWithSelector(this.rebalanceCurrentTick.selector, _targetWidth());
    if (_pauseRebalance() || !isOutsideStakeWindow()) return (false, execPayload);

    address helper = _rebalanceHelper();
    if (
      helper != address(0)
        && ICLRebalanceHelper(helper).shouldRebalance(
          _poolAddress(),
          _tickLower(),
          _tickUpper(),
          _tickSpacing(),
          _posWidth(),
          _targetWidth(),
          _lastRebalance(),
          _rebalanceCooldown(),
          _rebalanceDeviation(),
          block.timestamp
        )
    ) {
      return (true, execPayload);
    }

    // Deposits land in the buffer and drag the staked share down without unstaking, so this drift
    // accumulates between range rebalances and nothing corrects it inline.
    uint256 target = _targetStakedBps();
    uint256 current = stakedRatioBps();
    uint256 drift = current > target ? current - target : target - current;
    if (drift > _stakeRatioBandBps()) {
      return (true, abi.encodeWithSelector(this.rebalanceStakeRatio.selector));
    }
  }

  function posId() external view returns (uint256) {
    return _posId();
  }

  function bufferPosId() external view returns (uint256) {
    return _bufferPosId();
  }

  function stakedLiquidity() public view returns (uint256) {
    return _liquidityOf(_posId());
  }

  function bufferLiquidity() public view returns (uint256) {
    return _liquidityOf(_bufferPosId());
  }

  /// @notice The vault's whole position, in liquidity units. Exact only because both NFTs share a
  /// range — do not reuse this shape if that invariant is ever relaxed.
  function totalLiquidity() public view returns (uint256) {
    return stakedLiquidity() + bufferLiquidity();
  }

  /// @notice NAV in liquidity terms, INCLUDING idle token0/token1 held by this vault or by the
  /// strategy. V1 counted idle here and `CLWrapper.previewDeposit` prices against this figure, so
  /// dropping it would make every wrapper preview overstate the shares a deposit will mint — the
  /// vault would then reject its own wrapper's minimum whenever idle was non-zero.
  ///
  /// Idle is real value the vault owns but that `totalLiquidity()` (NFT liquidity only) cannot see,
  /// e.g. fees collected by a withdrawal, or the proceeds of a reward leg whose swap was swallowed.
  function underlyingBalanceWithInvestment() public view returns (uint256) {
    address t0 = _token0();
    address t1 = _token1();
    uint256 idle0 = IERC20Upgradeable(t0).balanceOf(address(this));
    uint256 idle1 = IERC20Upgradeable(t1).balanceOf(address(this));
    address strat = _strategy();
    if (strat != address(0)) {
      idle0 += IERC20Upgradeable(t0).balanceOf(strat);
      idle1 += IERC20Upgradeable(t1).balanceOf(strat);
    }
    // Both positions share a range, so their liquidity is fungible and one quote covers the pair.
    return ICLRebalanceHelper(_rebalanceHelper()).quoteUnderlyingBalanceWithInvestment(
      getSqrtPriceX96(), _tickLower(), _tickUpper(), uint128(totalLiquidity()), idle0, idle1
    );
  }

  function stakedRatioBps() public view returns (uint256) {
    uint256 total = totalLiquidity();
    if (total == 0) return 0;
    return (stakedLiquidity() * _BPS_DENOMINATOR) / total;
  }

  function targetStakedBps() external view returns (uint256) {
    return _targetStakedBps();
  }

  function stakeRatioBandBps() external view returns (uint256) {
    return _stakeRatioBandBps();
  }

  /// @notice End of the gauge's forfeit window for the staked position, plus the safety margin.
  /// Reads `minStakeTime` live from the gauge factory: it is governance-mutable upstream (300s
  /// today, 604800s maximum) so it must never be cached or assumed.
  function stakeWindowEnd() public view returns (uint256) {
    address s = _strategy();
    if (s == address(0)) return 0;
    return IStrategyCLV2(s).stakeWindowEnd() + _stakeWindowSafety();
  }

  function isOutsideStakeWindow() public view returns (bool) {
    return block.timestamp >= stakeWindowEnd();
  }

  /// @notice Share price on the same idle-inclusive basis as the mint and the payout, matching V1.
  /// Reporting it on `totalLiquidity()` alone would understate the share whenever idle is non-zero.
  function getPricePerFullShare() public view returns (uint256) {
    uint256 supply = totalSupply();
    return supply == 0
      ? _underlyingUnit()
      : (_underlyingUnit() * underlyingBalanceWithInvestment()) / supply;
  }

  // --------------------------------------------------------------------------------------------
  // deposit / withdraw — buffer only, never touches the gauge
  // --------------------------------------------------------------------------------------------

  function deposit(uint256 amount0, uint256 amount1, uint256 amountOutMin, address receiver)
    external
    nonReentrantV2
    returns (uint256 minted)
  {
    if (_pauseDepositWithdraw()) revert ErrDepositWithdrawPaused();
    if (_withdrawOnly()) revert ErrWithdrawOnly();
    if (receiver == address(0)) revert ErrZeroAddress();

    address t0 = _token0();
    address t1 = _token1();

    // Fold any idle the strategy is holding into the buffer FIRST. totalLiquidity() counts NFT
    // liquidity only, so idle -- collected fees from an earlier withdrawal, proceeds of a reward
    // leg that was swallowed, a move whose increase was skipped -- is value the vault owns but does
    // not report. Pricing a deposit against that understated figure mints the newcomer too many
    // shares and hands them a pro-rata slice of it the moment it is folded in, at the expense of
    // everyone already here. This is V2's analogue of V1's preInteract sweep.
    _flushIdle();

    // Measured BEFORE the caller's tokens arrive, exactly as V1: reading it afterwards would count
    // the depositor's own contribution as vault-owned and silently transfer value to everyone else.
    //
    // The basis must be the idle-INCLUSIVE figure, matching V1's `liquidityBefore =
    // underlyingBalanceWithInvestment()`. Pricing the mint on `totalLiquidity()` while NAV and the
    // withdrawal payout both count idle lets a depositor buy a claim on idle they were never charged
    // for: deposit 100x the vault, withdraw immediately, and walk away with ~99% of any idle that was
    // sitting here. That is permissionless, flash-loanable, and scales with TVL.
    uint256 liquidityBefore = underlyingBalanceWithInvestment();
    uint256 balance0Before = IERC20Upgradeable(t0).balanceOf(address(this));
    uint256 balance1Before = IERC20Upgradeable(t1).balanceOf(address(this));

    IERC20Upgradeable(t0).safeTransferFrom(msg.sender, address(this), amount0);
    IERC20Upgradeable(t1).safeTransferFrom(msg.sender, address(this), amount1);

    uint128 liq = _increaseBuffer(amount0, amount1);

    uint256 toMint = totalSupply() == 0 ? uint256(liq) : (uint256(liq) * totalSupply()) / liquidityBefore;
    if (toMint == 0) revert ErrZeroShares();
    if (toMint < amountOutMin) revert ErrSlippage();

    _mint(receiver, toMint);
    emit Deposit(msg.sender, receiver, amount0, amount1, toMint);

    _returnUnused(receiver, t0, t1, balance0Before, balance1Before);
    return toMint;
  }

  function withdraw(uint256 shares, uint256 amount0OutMin, uint256 amount1OutMin)
    external
    nonReentrantV2
    returns (uint256 amount0, uint256 amount1)
  {
    if (_pauseDepositWithdraw()) revert ErrDepositWithdrawPaused();
    uint256 supply = totalSupply();
    if (supply == 0) revert ErrTotalSupply();
    if (shares == 0) revert ErrZeroShares();

    // Same reason as on deposit, mirrored: without this the exiting holder forfeits their share of
    // any unreported idle to whoever remains.
    _flushIdle();

    // Pro-rata share of any token0/token1 sitting on the VAULT itself, exactly as V1 paid it.
    // `_flushIdle` folds the STRATEGY's idle into the buffer, but nothing moves the vault's own
    // balance, and `sweepStrayToken` refuses the pool tokens — so without this a donation here is
    // stranded forever. It also keeps the payout consistent with
    // `underlyingBalanceWithInvestment()`, which counts this balance, and with the wrapper's
    // `previewRedeem`, which credits it: if NAV and the preview include it but the payout does not,
    // a donation of more than ~25bps of NAV makes every wrapper redeem revert WrapperSlippage.
    // Sampled BEFORE `_decreaseBuffer` brings the withdrawal's own proceeds into this contract.
    uint256 idleShare0 = (IERC20Upgradeable(_token0()).balanceOf(address(this)) * shares) / supply;
    uint256 idleShare1 = (IERC20Upgradeable(_token1()).balanceOf(address(this)) * shares) / supply;

    uint256 total = totalLiquidity();
    uint256 owed = (total * shares) / supply;
    _burn(msg.sender, shares);

    uint256 buffered = bufferLiquidity();
    bool unstaked = false;
    if (owed > buffered) {
      // The buffer is short. Withdrawals are never refused, so pull the difference out of the
      // gauge even if that means forfeiting accrued AERO.
      //
      // Only the shortfall is moved here, and the re-split is deliberately deferred until AFTER
      // the payout: re-splitting first would push liquidity straight back into the staked position
      // and leave the buffer short again for the very withdrawal that triggered the unstake.
      _coverShortfallFromStaked(owed - buffered);
      unstaked = true;
    }

    // Round-tripping liquidity between the two positions loses a few wei: decreaseLiquidity rounds
    // the token amounts down, then increaseLiquidity rounds the resulting liquidity down again. So
    // after covering a shortfall the buffer can hold marginally less than `owed`, and asking for
    // the full figure would revert on the very withdrawal we just unstaked to serve. Clamp to what
    // is actually there — the difference is dust, and paying it out is better than failing.
    uint256 available = bufferLiquidity();
    if (available < owed) {
      // The clamp above exists for the few wei that a decrease/increase round trip rounds away.
      // A MATERIAL shortfall means something else: the cover did not land. That happens when the
      // move would mint zero liquidity at the destination -- reachable deliberately, by putting
      // spot just inside a range boundary so one released side rounds to zero while the other is
      // arbitrarily large. Paying the clamped amount there would burn the caller's full shares and
      // hand the difference to the remaining holders. Fail loudly; the caller can retry.
      if (owed - available > owed / 1e6 + _DUST_LIQUIDITY) revert ErrShortfallNotCovered(owed, available);
    }
    uint128 take = owed > available ? uint128(available) : uint128(owed);
    (amount0, amount1) = _decreaseBuffer(take, amount0OutMin, amount1OutMin);
    amount0 += idleShare0;
    amount1 += idleShare1;
    _safeTransferIfPositive(_token0(), msg.sender, amount0);
    _safeTransferIfPositive(_token1(), msg.sender, amount1);
    emit Withdraw(msg.sender, msg.sender, amount0, amount1, shares);

    if (unstaked) {
      // The window has already been restarted by the unstake, so restoring the target split now is
      // free — this is what makes the buffer self-healing after a large exit.
      _splitToTarget();
      _restake();
    }
  }

  // --------------------------------------------------------------------------------------------
  // buffer plumbing
  // --------------------------------------------------------------------------------------------

  /// @notice Hand the staked position to the strategy and stake it.
  ///
  /// The gauge takes ownership of whatever it is given, and the strategy must own the NFT in order
  /// to give it — so the vault transfers it across first. The BUFFER never makes this trip: it
  /// stays owned by this vault so a withdrawal can always decrease it without asking anyone.
  function _restake() internal {
    address s = _strategy();
    if (s == address(0)) revert ErrStrategyUndefined();
    IStrategyCLV2(s).stakePosition();
  }

  /// @notice Stake the position after initialisation, or recover one left unstaked by a failed
  /// maintenance call. Idempotent — a no-op when it is already in the gauge.
  function restakePosition() external {
    if (!(msg.sender == governance() || msg.sender == controller() || msg.sender == _rebalanceExecutor())) {
      revert ErrNotRebalanceExecutor();
    }
    _restake();
  }


  /// @dev Both NFTs are owned by the strategy, so the vault forwards the tokens and lets the
  /// strategy do the ownership-checked call.
  function _increaseBuffer(uint256 amount0, uint256 amount1) internal returns (uint128 liq) {
    if (amount0 == 0 && amount1 == 0) return 0;
    address s = _strategy();
    if (s == address(0)) revert ErrStrategyUndefined();
    if (amount0 > 0) IERC20Upgradeable(_token0()).safeTransfer(s, amount0);
    if (amount1 > 0) IERC20Upgradeable(_token1()).safeTransfer(s, amount1);
    liq = IStrategyCLV2(s).increaseBuffer(amount0, amount1);
  }

  function _decreaseBuffer(uint128 liquidity, uint256 amount0Min, uint256 amount1Min)
    internal
    returns (uint256 amount0, uint256 amount1)
  {
    if (liquidity == 0) return (0, 0);
    return IStrategyCLV2(_strategy()).decreaseBuffer(liquidity, amount0Min, amount1Min, address(this));
  }

  /// @notice Unstake and move exactly `liquidity` from the staked position into the buffer, so a
  /// withdrawal larger than the buffer can still be served. Restarts the gauge window and, inside
  /// it, forfeits the accrued AERO — the caller has already decided that is the lesser evil.
  ///
  /// Leaves the position UNSTAKED and the split untouched; the caller re-splits and re-stakes once
  /// the payout is done.
  function _coverShortfallFromStaked(uint256 liquidity) internal {
    address s = _strategy();
    if (s == address(0)) revert ErrStrategyUndefined();
    uint256 end = stakeWindowEnd();

    IStrategyCLV2(s).unstake(false); // leaves both NFTs with the strategy
    _moveLiquidity(_posId(), _bufferPosId(), liquidity);
    if (block.timestamp < end) emit ForcedUnstake(liquidity, end, block.timestamp);
  }

  /// @notice Re-split total liquidity between the two positions to hit `targetStakedBps`. Assumes
  /// the staked NFT is currently held by this vault (i.e. already unstaked by the caller).
  function _splitToTarget() internal {
    uint256 total = totalLiquidity();
    if (total == 0) return;
    uint256 wantStaked = (total * _targetStakedBps()) / _BPS_DENOMINATOR;
    uint256 haveStaked = stakedLiquidity();
    // After a full redemption `total` is dust and the staked side is empty; attempting to move
    // that residue would revert and take the redemption with it. Nothing meaningful is lost by
    // skipping — the dust is folded in on the next compound.
    if (wantStaked > haveStaked) {
      _moveLiquidity(_bufferPosId(), _posId(), wantStaked - haveStaked);
    } else if (haveStaked > wantStaked) {
      _moveLiquidity(_posId(), _bufferPosId(), haveStaked - wantStaked);
    }
    emit StakeRatioRebalanced(stakedLiquidity(), bufferLiquidity(), stakedRatioBps());
  }

  /// @notice Shift liquidity between the two positions. Delegated to the library; safe only
  /// because their ranges are identical, so the tokens released by `from` are exactly what `to`
  /// consumes at any price and nothing has to be swapped.
  /// @notice Absolute floor below which a liquidity discrepancy is rounding, not a failed move.
  uint256 private constant _DUST_LIQUIDITY = 1000;

  /// @notice Fold strategy-held idle token0/token1 into the buffer so `totalLiquidity()` reports
  /// everything the vault owns before it is used to price a share.
  function _flushIdle() internal {
    address s = _strategy();
    if (s != address(0)) IStrategyCLV2(s).preInteract();
  }

  function _moveLiquidity(uint256 from, uint256 to, uint256 liquidity) internal {
    if (liquidity == 0) return;
    IStrategyCLV2(_strategy()).moveLiquidity(from, to, liquidity);
  }


  // --------------------------------------------------------------------------------------------
  // maintenance — all gated on being clear of the forfeit window
  // --------------------------------------------------------------------------------------------

  /// @notice Restore the staked/buffer split to target. Only callable once the staked position is
  /// clear of the window, and only when the ratio has actually drifted outside the band — every
  /// call costs an unstake, which restarts the window for the whole staked balance.
  function rebalanceStakeRatio() external nonReentrantV2 {
    // Gated like every other maintenance entry point. Left open, an attacker could call this on a
    // loop to keep restarting the gauge window and permanently starve the vault of both harvests
    // and range rebalances, at no cost beyond gas.
    if (!(msg.sender == governance() || msg.sender == controller() || msg.sender == _rebalanceExecutor())) {
      revert ErrNotRebalanceExecutor();
    }
    if (_pauseRebalance()) revert ErrRebalancePaused();
    if (!isOutsideStakeWindow()) revert ErrInsideStakeWindow();
    uint256 target = _targetStakedBps();
    uint256 band = _stakeRatioBandBps();
    uint256 current = stakedRatioBps();
    uint256 drift = current > target ? current - target : target - current;
    if (drift <= band) revert ErrRatioInBand();

    address s = _strategy();
    if (s == address(0)) revert ErrStrategyUndefined();
    IStrategy(s).withdrawAllToVault(false);
    _splitToTarget();
    _restake();
  }

  /// @notice Both positions must always describe the same range; this is the invariant every other
  /// piece of accounting leans on. Checked after any operation that could desynchronise them.
  function _assertRangesMatch() internal view {
    address pm = _posManager();
    uint256 a = _posId();
    uint256 b = _bufferPosId();
    // Distinctness matters as much as the range: one id in both slots would double-count the same
    // liquidity in totalLiquidity() and inflate every share.
    if (a == b) revert ErrRangeMismatch();
    (,, address t0A, address t1A, int24 tsA, int24 lowerA, int24 upperA,,,,,) =
      INonfungiblePositionManager(pm).positions(a);
    (,, address t0B, address t1B, int24 tsB, int24 lowerB, int24 upperB,,,,,) =
      INonfungiblePositionManager(pm).positions(b);
    // Same pool as well as same range — matching ticks on a DIFFERENT pool would still break the
    // fungibility that all of this vault's accounting depends on.
    if (lowerA != lowerB || upperA != upperB || t0A != t0B || t1A != t1B || tsA != tsB) {
      revert ErrRangeMismatch();
    }
    if (t0A != _token0() || t1A != _token1()) revert ErrRangeMismatch();
  }

  // --------------------------------------------------------------------------------------------
  // harvest
  // --------------------------------------------------------------------------------------------

  /// @notice Trigger the strategy's harvest. Unlike V1 this does NOT hand the NFT to the strategy:
  /// the staked position stays in the gauge and the strategy compounds into the buffer, so a
  /// harvest never unstakes and never restarts the window.
  function doHardWork() external nonReentrantV2 {
    if (_pauseHarvest()) revert ErrHarvestPaused();
    if (_withdrawOnly()) revert ErrWithdrawOnly();
    address s = _strategy();
    if (s == address(0)) revert ErrStrategyUndefined();
    if (!(msg.sender == governance() || msg.sender == controller())) revert ErrNotRebalanceExecutor();
    IStrategy(s).doHardWork();
  }

  /// @notice Recover an unrelated ERC20 sent here by mistake. Never the pool tokens: those are
  /// vault property and are accounted for by the positions.
  function sweepStrayToken(address token, address to) external onlyGovernance {
    if (token == _token0() || token == _token1()) revert ErrProtectedToken();
    if (to == address(0)) revert ErrZeroAddress();
    uint256 bal = IERC20Upgradeable(token).balanceOf(address(this));
    if (bal > 0) IERC20Upgradeable(token).safeTransfer(to, bal);
  }

  // --------------------------------------------------------------------------------------------
  // range rebalance — both positions move together, always
  // --------------------------------------------------------------------------------------------

  /// @notice Recentre BOTH positions on the current tick at `_newPosWidth`.
  ///
  /// A position NFT's range is immutable, so a range change means burning both and minting two
  /// fresh ones. They must move in the same transaction: the identical-range invariant is what
  /// makes `stakedLiquidity + bufferLiquidity` a valid measure, and a vault caught with two
  /// different ranges would mis-price every share until it was repaired.
  ///
  /// Gated on the forfeit window because it has to unstake. That is the unavoidable cost of this
  /// gauge design: when the price leaves the range mid-window the choice is to forfeit accrued
  /// AERO or to sit out of range until the window passes. At the ~300s windows seen in practice
  /// waiting is nearly free, which is why this reverts rather than forfeiting — unlike a
  /// withdrawal, a rebalance can always wait.
  function rebalanceCurrentTick(uint256 _newPosWidth)
    external
    onlyRebalanceExecutor
    whenRebalanceEnabledV2
    nonReentrantV2
  {
    if (_newPosWidth == 0 || _newPosWidth > _posWidth()) revert ErrBadConfig();
    if (block.timestamp < _lastRebalance() + _rebalanceCooldown()) revert ErrRebalanceCooldown();
    if (!isOutsideStakeWindow()) revert ErrInsideStakeWindow();

    address s = _strategy();
    if (s == address(0)) revert ErrStrategyUndefined();

    // Outside the window, so claiming is free — take the accrued AERO before unstaking rather
    // than leaving it to be swept later.
    IStrategyCLV2(s).unstake(true);

    ICLRebalanceHelper rh = ICLRebalanceHelper(_rebalanceHelper());
    RebalanceCache memory c;
    c.pool = _poolAddress();
    c.window = _twapWindow();
    c.slip = _maxSlippageBps();
    c.liquidityBefore = totalLiquidity();

    (c.newLower, c.newUpper, c.burnMin0, c.burnMin1) = rh.prepareRebalance(
      c.pool,
      c.window,
      _maxTwapDeviationBps(),
      c.slip,
      int24(int256(_newPosWidth)),
      _tickSpacing(),
      _tickLower(),
      _tickUpper(),
      uint128(c.liquidityBefore)
    );

    if (c.newLower == _tickLower() && c.newUpper == _tickUpper()) {
      // Recentring landed on the range we already have — reachable in production when the price
      // drifts back between the checker seeing it and the tx landing. Re-stake so the position is
      // not left idle out of the gauge, and leave the cooldown untouched.
      _restake();
      return;
    }

    c.oldStaked = _posId();
    c.oldBuffer = _bufferPosId();

    // Burn/swap/mint runs in the library via DELEGATECALL from the STRATEGY, which owns both
    // position NFTs and stays the caller the position manager sees. Only the storage writes and
    // the new tokenIds come back here.
    (c.newStaked, c.newBuffer) = IStrategyCLV2(s).rebalanceRanges(
      c.pool,
      address(rh),
      c.newLower,
      c.newUpper,
      c.burnMin0,
      c.burnMin1,
      _targetStakedBps(),
      _maxSwapBps(),
      c.slip,
      c.window,
      _maxTwapDeviationBps()
    );

    _setPosId(c.newStaked);
    _setBufferPosId(c.newBuffer);
    _setTickLower(c.newLower);
    _setTickUpper(c.newUpper);
    _setPosWidth(_newPosWidth);
    if (_newPosWidth < _targetWidth()) _setTargetWidth(_newPosWidth);
    _setLastRebalance(block.timestamp);

    _assertRangesMatch();
    _restake();
    emit RangeRebalanced(c.oldStaked, c.oldBuffer, c.newStaked, c.newBuffer, c.liquidityBefore, totalLiquidity());
  }




  // --------------------------------------------------------------------------------------------
  // admin
  // --------------------------------------------------------------------------------------------

  function setRebalanceHelper(address helper) external onlyGovernance {
    if (helper == address(0)) revert ErrZeroAddress();
    _setRebalanceHelper(helper);
  }

  function setRebalanceConfig(uint256 deviation, uint256 cooldown, address executor) external onlyGovernance {
    if (executor == address(0)) revert ErrZeroAddress();
    _setRebalanceDeviation(deviation);
    _setRebalanceCooldown(cooldown);
    _setRebalanceExecutor(executor);
  }

  function setRebalanceSafetyConfig(
    uint256 maxSwapBps,
    uint256 maxSlippageBps,
    uint32 twapWindow,
    uint256 maxTwapDeviationBps
  ) external onlyGovernance {
    if (maxSwapBps > _BPS_DENOMINATOR || maxSlippageBps > _BPS_DENOMINATOR) revert ErrBadConfig();
    _setMaxSwapBps(maxSwapBps);
    _setMaxSlippageBps(maxSlippageBps);
    _setTwapWindow(twapWindow);
    _setMaxTwapDeviationBps(maxTwapDeviationBps);
  }

  /// @dev First set is free (bootstrapping the vault); every later change needs the announcement
  /// to have been made and its timelock to have elapsed.
  function _canUpdateStrategy(address candidate) internal view returns (bool) {
    bool notSetYet = _strategy() == address(0);
    bool timelockPassed = _nextStrategyTimestamp() != 0 && block.timestamp > _nextStrategyTimestamp();
    return notSetYet || (candidate == _nextStrategy() && timelockPassed);
  }

  /// @notice Start the timelock on a strategy swap. Same two-step flow as V1: a strategy change
  /// can move every position, so it must not be a single unannounced transaction.
  function announceStrategyUpdate(address newStrategy) external onlyControllerOrGovernance {
    uint256 when = block.timestamp + _nextImplementationDelay();
    _setNextStrategyTimestamp(when);
    _setNextStrategy(newStrategy);
    emit StrategyAnnounced(newStrategy, when);
  }

  function setStrategy(address newStrategy) external onlyControllerOrGovernance {
    if (!_canUpdateStrategy(newStrategy)) revert ErrTimelock();
    if (newStrategy == address(0)) revert ErrZeroAddress();
    if (IStrategy(newStrategy).vault() != address(this)) revert ErrVault();

    emit StrategyChanged(newStrategy, _strategy());
    if (newStrategy != _strategy()) {
      if (_strategy() != address(0)) {
        // Compound-on-exit only when it is free; inside the window the claim pays nothing and
        // would just burn the accrued AERO on the way out.
        IStrategyCLV2(_strategy()).unstake(isOutsideStakeWindow());
        // Hand both positions to the incoming strategy. They travel together, always.
        IStrategyMigrate(_strategy()).migratePositions(newStrategy);
      }
      _setStrategy(newStrategy);
      _handOverPositions(newStrategy);
    }
    _setNextStrategyTimestamp(0);
    _setNextStrategy(address(0));
  }

  function setLanePause(bool pauseDepositWithdraw, bool pauseHarvest, bool pauseRebalance, bool withdrawOnly)
    external
    onlyGovernance
  {
    _setPauseDepositWithdraw(pauseDepositWithdraw);
    _setPauseHarvest(pauseHarvest);
    _setPauseRebalance(pauseRebalance);
    _setWithdrawOnly(withdrawOnly);
  }

  function setStakeConfig(uint256 targetBps, uint256 bandBps, uint256 windowSafety) external onlyGovernance {
    // A 100%-staked target would leave no buffer at all and put every withdrawal into the gauge,
    // which is the exact failure V2 exists to avoid.
    if (targetBps == 0 || targetBps >= _BPS_DENOMINATOR) revert ErrBadConfig();
    if (bandBps >= _BPS_DENOMINATOR) revert ErrBadConfig();
    _setTargetStakedBps(targetBps);
    _setStakeRatioBandBps(bandBps);
    _setStakeWindowSafety(windowSafety);
    emit StakeConfigUpdated(targetBps, bandBps, windowSafety);
  }

  function setBufferPosition(uint256 id) external onlyGovernance {
    if (id == 0 || id == _posId()) revert ErrBadConfig();
    _setBufferPosId(id);
    _assertRangesMatch();
    emit BufferPositionSet(id);
  }

  // --------------------------------------------------------------------------------------------
  // internals
  // --------------------------------------------------------------------------------------------

  /// @dev Move any position this vault still holds to the strategy. Only relevant right after
  /// `initializeVault`, which receives the seeds before a strategy exists.
  function _handOverPositions(address s) internal {
    address pm = _posManager();
    uint256 a = _posId();
    uint256 b = _bufferPosId();
    if (INonfungiblePositionManager(pm).ownerOf(a) == address(this)) {
      IERC721Upgradeable(pm).transferFrom(address(this), s, a);
    }
    if (INonfungiblePositionManager(pm).ownerOf(b) == address(this)) {
      IERC721Upgradeable(pm).transferFrom(address(this), s, b);
    }
  }

  function _liquidityOf(uint256 id) internal view returns (uint256) {
    if (id == 0) return 0;
    (,,,,,,, uint128 liq,,,,) = INonfungiblePositionManager(_posManager()).positions(id);
    return uint256(liq);
  }

  function _setApproval(address token, address spender, uint256 amount) internal {
    IERC20Upgradeable(token).safeApprove(spender, 0);
    IERC20Upgradeable(token).safeApprove(spender, amount);
  }

  function _safeTransferIfPositive(address token, address to, uint256 amount) internal {
    if (amount > 0) IERC20Upgradeable(token).safeTransfer(to, amount);
  }

  /// @notice Return whatever the position could not consume to the depositor, without touching
  /// balances that were already sitting in the vault before this call.
  function _returnUnused(address to, address t0, address t1, uint256 before0, uint256 before1) internal {
    uint256 b0 = IERC20Upgradeable(t0).balanceOf(address(this));
    uint256 b1 = IERC20Upgradeable(t1).balanceOf(address(this));
    if (b0 > before0) IERC20Upgradeable(t0).safeTransfer(to, b0 - before0);
    if (b1 > before1) IERC20Upgradeable(t1).safeTransfer(to, b1 - before1);
  }

  modifier onlyRebalanceExecutor() {
    if (!(msg.sender == governance() || msg.sender == controller() || msg.sender == _rebalanceExecutor())) {
      revert ErrNotRebalanceExecutor();
    }
    _;
  }

  modifier whenRebalanceEnabledV2() {
    if (_pauseRebalance()) revert ErrRebalancePaused();
    _;
  }

  function _poolAddress() internal view returns (address) {
    return ICLRebalanceHelper(_rebalanceHelper()).poolAddressFor(_posManager(), _token0(), _token1(), _tickSpacing());
  }

  uint256 private _entered;

  modifier nonReentrantV2() {
    require(_entered == 0, "reentrant");
    _entered = 1;
    _;
    _entered = 0;
  }
}

interface IStrategyMigrate {
  /// @notice Send both position NFTs to the incoming strategy during a strategy swap.
  function migratePositions(address to) external;
}

/// @notice The V2 strategy surface the vault depends on for gauge/window state.
interface IStrategyCLV2 {
  function stakePosition() external;

  function preInteract() external;

  function unstake(bool compound) external;

  function increaseBuffer(uint256 amount0, uint256 amount1) external returns (uint128);

  function decreaseBuffer(uint128 liquidity, uint256 min0, uint256 min1, address to)
    external
    returns (uint256 amount0, uint256 amount1);

  function moveLiquidity(uint256 from, uint256 to, uint256 liquidity) external;

  function rebalanceRanges(
    address pool,
    address helper,
    int24 newLower,
    int24 newUpper,
    uint256 burnMin0,
    uint256 burnMin1,
    uint256 targetStakedBps,
    uint256 maxSwapBps,
    uint256 maxSlippageBps,
    uint32 twapWindow,
    uint256 maxTwapDeviationBps
  ) external returns (uint256 newStaked, uint256 newBuffer);

  /// @notice depositTimestamp(stakedPosId) + the gauge's live minStakeTime, or 0 when unstaked.
  function stakeWindowEnd() external view returns (uint256);

  function isOutsideStakeWindow() external view returns (bool);
}
