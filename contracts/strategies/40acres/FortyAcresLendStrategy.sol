//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "../euler/EulerLendStrategy.sol";

/**
 * @title FortyAcresLendStrategy
 * @dev EulerLendStrategy extended with in-kind withdrawals: the vault can pull a pro-rata
 * slice of the strategy's lending pool shares and send them straight to a redeeming user.
 * This provides an exit for vault users while the lending pool has no redeemable liquidity.
 * The pool shares backing accrued-but-unpaid fees are carved out before the split so fee
 * accounting stays intact.
 */
contract FortyAcresLendStrategy is EulerLendStrategy {

  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  event WithdrawInKind(address indexed receiver, uint256 shareNumerator, uint256 shareDenominator, uint256 assetsOut, uint256 poolSharesOut);

  constructor() EulerLendStrategy() {}

  /**
   * @notice Hands `_receiver` their `_shareNumerator / _shareDenominator` slice of everything
   * this strategy holds: idle underlying and the yield source's own shares, net of what
   * backs the accrued fee.
   * @dev Called by an in-kind vault when a holder redeems in kind, so they can exit even
   * while the yield source refuses redemptions. Both legs are paid, so nothing the strategy
   * holds is invisible to the redeemer - in particular underlying that arrived while the
   * yield source was closed and is still waiting to be supplied. The fraction is the
   * holder's share of the vault's supply, so the payout is exactly proportional and does
   * not depend on any cached exchange rate.
   *
   * The fee is carved out once: from idle first, the remainder from the position - the
   * same order `_handleFee` pays it in. `previewWithdraw` measures the position part, so
   * it is grossed up for any exit fee the yield source charges and what stays behind really
   * is worth the fee.
   * @param _shareNumerator Numerator of the redeemed fraction (redeemed vault shares).
   * @param _shareDenominator Denominator of the fraction (vault supply before the burn).
   * @param _receiver Address receiving the underlying and the position tokens.
   * @return assetsOut Idle underlying transferred.
   * @return poolSharesOut Position tokens transferred.
   */
  function withdrawInKind(
    uint256 _shareNumerator,
    uint256 _shareDenominator,
    address _receiver
  ) external restricted returns (uint256 assetsOut, uint256 poolSharesOut) {
    require(_shareDenominator > 0, "denominator must be greater than 0");
    require(_shareNumerator <= _shareDenominator, "numerator must not exceed denominator");
    _accrueFee();
    (uint256 netIdle, uint256 netShares) = _inKindDistributable(pendingFee());
    assetsOut = netIdle.mul(_shareNumerator).div(_shareDenominator);
    poolSharesOut = netShares.mul(_shareNumerator).div(_shareDenominator);
    if (assetsOut > 0) {
      IERC20(underlying()).safeTransfer(_receiver, assetsOut);
    }
    if (poolSharesOut > 0) {
      IERC20(eulerVault()).safeTransfer(_receiver, poolSharesOut);
    }
    _updateStoredBalance();
    emit WithdrawInKind(_receiver, _shareNumerator, _shareDenominator, assetsOut, poolSharesOut);
  }

  /**
   * @dev What can be handed out in kind: idle underlying and position tokens, net of what
   * backs `fee`. The fee comes out of idle first and then out of the position, so it is
   * carved exactly once.
   */
  function _inKindDistributable(uint256 fee) internal view returns (uint256 netIdle, uint256 netShares) {
    address _pool = eulerVault();
    uint256 idle = IERC20(underlying()).balanceOf(address(this));
    uint256 shares = IERC20(_pool).balanceOf(address(this));
    uint256 feeFromIdle = Math.min(fee, idle);
    netIdle = idle.sub(feeFromIdle);
    uint256 feeFromPosition = fee.sub(feeFromIdle);
    uint256 feeShares = feeFromPosition > 0 ? IERC4626(_pool).previewWithdraw(feeFromPosition) : 0;
    netShares = shares > feeShares ? shares.sub(feeShares) : 0;
  }

  /**
   * @notice Accrues fees and refreshes the cached balance so the vault's share price
   * reflects the pool's live rate. Called by the vault before minting deposits while
   * in-kind redemptions are enabled.
   */
  function syncBalance() external restricted {
    _accrueFee();
    _updateStoredBalance();
  }

  /**
   * @dev Returns the pending fee as it would stand right after an accrual, i.e. including
   * the fee on any balance increase since the last sync.
   */
  function _simulatedPendingFee() internal view returns (uint256) {
    uint256 pending = pendingFee();
    uint256 current = currentBalance();
    uint256 stored = storedBalance();
    if (current > stored) {
      pending = pending.add(current.sub(stored).mul(totalFeeNumerator()).div(feeDenominator()));
    }
    return pending;
  }

  /**
   * @notice Returns the invested underlying balance as it would stand right after
   * `syncBalance`, i.e. based on the pool's live rate instead of the cached balance.
   * Used by the vault to quote deposits and withdrawals while in-kind redemptions are
   * enabled, so previews match the synced rate used during execution.
   * @return Live invested underlying balance, net of pending fees.
   */
  function syncedInvestedUnderlyingBalance() public view returns (uint256) {
    uint256 gross = IERC20(underlying()).balanceOf(address(this)).add(currentBalance());
    uint256 pending = _simulatedPendingFee();
    return gross > pending ? gross.sub(pending) : 0;
  }

  /**
   * @notice Estimates both legs of {withdrawInKind} for a given fraction, including the
   * fee that would accrue at execution time.
   * @param _shareNumerator Numerator of the redeemed fraction.
   * @param _shareDenominator Denominator of the redeemed fraction.
   * @return assetsOut Estimated idle underlying that would be transferred.
   * @return poolSharesOut Estimated position tokens that would be transferred.
   */
  function previewWithdrawInKind(
    uint256 _shareNumerator,
    uint256 _shareDenominator
  ) public view returns (uint256 assetsOut, uint256 poolSharesOut) {
    if (_shareDenominator == 0) {
      return (0, 0);
    }
    (uint256 netIdle, uint256 netShares) = _inKindDistributable(_simulatedPendingFee());
    assetsOut = netIdle.mul(_shareNumerator).div(_shareDenominator);
    poolSharesOut = netShares.mul(_shareNumerator).div(_shareDenominator);
  }
}
