// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/upgradability/BaseUpgradeableStrategy.sol";
import "../../base/interface/aave/IAToken.sol";
import "../../base/interface/aave/IPool.sol";

contract AaveSupplyStrategy is BaseUpgradeableStrategy {

  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  address public constant harvestMSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);

  // additional storage slots (on top of BaseUpgradeableStrategy ones) are defined here
  bytes32 internal constant _ATOKEN_SLOT = 0x8cdee58637b787efaa2d78bb1da1e053a2c91e61640b32339bfbba65c00abd68;
  bytes32 internal constant _STORED_SUPPLIED_SLOT = 0x280539da846b4989609abdccfea039bd1453e4f710c670b29b9eeaca0730c1a2;
  bytes32 internal constant _PENDING_FEE_SLOT = 0x0af7af9f5ccfa82c3497f40c7c382677637aee27293a6243a22216b51481bd97;

  constructor() BaseUpgradeableStrategy() {
    assert(_ATOKEN_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.aToken")) - 1));
    assert(_STORED_SUPPLIED_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.storedSupplied")) - 1));
    assert(_PENDING_FEE_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.pendingFee")) - 1));
  }

  function initializeBaseStrategy(
    address _storage,
    address _underlying,
    address _vault,
    address _aToken
  )
  public initializer {
    BaseUpgradeableStrategy.initialize(
      _storage,
      _underlying,
      _vault,
      _aToken,
      _underlying,
      harvestMSIG
    );

    require(IAToken(_aToken).UNDERLYING_ASSET_ADDRESS() == _underlying, "Underlying mismatch");
    _setAToken(_aToken);
  }

  function currentSupplied() public view returns (uint256) {
    return IAToken(aToken()).balanceOf(address(this));
  }

  function storedSupplied() public view returns (uint256) {
    return getUint256(_STORED_SUPPLIED_SLOT);
  }

  function _updateStoredSupplied() internal {
    setUint256(_STORED_SUPPLIED_SLOT, currentSupplied());
  }

  function totalFeeNumerator() public view returns (uint256) {
    return strategistFeeNumerator().add(platformFeeNumerator()).add(profitSharingNumerator());
  }

  function pendingFee() public view returns (uint256) {
    return getUint256(_PENDING_FEE_SLOT);
  }

  function _accrueFee() internal {
    uint256 fee;
    if (currentSupplied() > storedSupplied()) {
      uint256 balanceIncrease = currentSupplied().sub(storedSupplied());
      fee = balanceIncrease.mul(totalFeeNumerator()).div(feeDenominator());
    }
    setUint256(_PENDING_FEE_SLOT, pendingFee().add(fee));
    _updateStoredSupplied();
  }

  function feeFloor() public view virtual returns (uint256) {
    return 1e3;
  }

  function _handleFee() internal {
    _accrueFee();
    uint256 fee = pendingFee();
    if (fee > feeFloor()) {
      address _underlying = underlying();
      uint256 availableBalance = IERC20(_underlying).balanceOf(address(this));
      if (availableBalance < fee) {
        // Ask the pool only for the shortfall, and never for more than it can service right
        // now: the position we actually hold, and the underlying sitting in the aToken.
        uint256 redeemable = Math.min(
          Math.min(
            fee.sub(availableBalance),
            currentSupplied()
          ),
          IERC20(_underlying).balanceOf(aToken())
        );
        if (redeemable > 0) {
          _redeem(redeemable);
        }
      }
      fee = Math.min(fee, IERC20(_underlying).balanceOf(address(this)));
      if (fee == 0) {
        return;
      }
      uint256 balanceIncrease = fee.mul(feeDenominator()).div(totalFeeNumerator());
      _notifyProfitInRewardToken(_underlying, balanceIncrease);
      setUint256(_PENDING_FEE_SLOT, pendingFee().sub(fee));
    }
  }
  
  function depositArbCheck() public pure returns (bool) {
    // there's no arb here.
    return true;
  }

  function unsalvagableTokens(address token) public view returns (bool) {
    return (token == underlying() || token == aToken());
  }

  /**
  * Exits Moonwell and transfers everything to the vault.
  */
  function withdrawAllToVault() public restricted {
    address _underlying = underlying();
    _handleFee();
    _redeemMaximum();
    // Keep back whatever fee `_handleFee` could not pay out - it is below the dust floor,
    // or the yield source refused the redemption. Handing it to the vault along with
    // everything else would leave `pendingFee` with nothing behind it, and
    // `investedUnderlyingBalance()` would then report less than zero.
    uint256 balance = IERC20(_underlying).balanceOf(address(this));
    uint256 fee = pendingFee();
    if (balance > fee) {
      IERC20(_underlying).safeTransfer(vault(), balance.sub(fee));
    }
    _updateStoredSupplied();
  }

  function emergencyExit() external onlyGovernance {
    _accrueFee();
    _redeemMaximum();
    _updateStoredSupplied();
  }

  function withdrawToVault(uint256 amountUnderlying) public restricted {
    _accrueFee();
    address _underlying = underlying();
    uint256 balance = IERC20(_underlying).balanceOf(address(this));
    if (amountUnderlying <= balance) {
      IERC20(_underlying).safeTransfer(vault(), amountUnderlying);
      _updateStoredSupplied();
      return;
    }
    uint256 toRedeem = amountUnderlying.sub(balance);
    // get some of the underlying
    _redeem(toRedeem);
    // transfer the amount requested (or the amount we have) back to vault()
    IERC20(_underlying).safeTransfer(vault(), amountUnderlying);
    balance = IERC20(_underlying).balanceOf(address(this));
    if (balance > 1e2) {
      _supply(balance);
    }
    _updateStoredSupplied();
  }

  /**
  * Withdraws all assets, liquidates XVS, and invests again in the required ratio.
  */
  function doHardWork() public restricted {
    _handleFee();
    _supply(IERC20(underlying()).balanceOf(address(this)));
    _updateStoredSupplied();
  }

  /**
  * Salvages a token.
  */
  function salvage(address recipient, address token, uint256 amount) public onlyGovernance {
    // To make sure that governance cannot come in and take away the coins
    require(!unsalvagableTokens(token), "token is defined as not salvagable");
    IERC20(token).safeTransfer(recipient, amount);
  }

  /**
  * Returns the current balance.
  */
  function investedUnderlyingBalance() public view returns (uint256) {
    // underlying in this strategy + underlying redeemable from Radiant - debt
    uint256 total = IERC20(underlying()).balanceOf(address(this)).add(storedSupplied());
    uint256 fee = pendingFee();
    // Clamped rather than subtracted outright: this is read by every vault entrypoint, so
    // an underflow here would take deposits, withdrawals and the share price down with it.
    return total > fee ? total.sub(fee) : 0;
  }

  /**
  * Supplies to Moonwel
  */
  function _supply(uint256 amount) internal {
    if (amount < 1e2){
      return;
    }
    address _underlying = underlying();
    address _pool = IAToken(aToken()).POOL();
    IERC20(_underlying).safeApprove(_pool, 0);
    IERC20(_underlying).safeApprove(_pool, amount);
    IPool(_pool).supply(_underlying, amount, address(this), 0);
  }

  function _redeem(uint256 amountUnderlying) internal {
    if (amountUnderlying == 0){
      return;
    }
    address _pool = IAToken(aToken()).POOL();
    IPool(_pool).withdraw(underlying(), amountUnderlying, address(this));
  }

  function _redeemMaximum() internal {
    // The fee is deliberately left in the position rather than redeemed. Clamped rather
    // than subtracted outright, so that a fee larger than what is left cannot revert the
    // exit. The `+1` is the rounding margin that keeps the redemption from
    // asking for more than the position can cover.
    uint256 supplied = currentSupplied();
    uint256 fee = pendingFee().add(1);
    if (supplied > fee) {
      _redeem(supplied.sub(fee));
    }
  }

  function _setAToken (address _target) internal {
    setAddress(_ATOKEN_SLOT, _target);
  }

  function aToken() public view returns (address) {
    return getAddress(_ATOKEN_SLOT);
  }

  function finalizeUpgrade() external onlyGovernance {
    _finalizeUpgrade();
  }

  receive() external payable {}
}