// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/upgradability/BaseUpgradeableStrategy.sol";
import "../../base/interface/degenPrime/IPrimePool.sol";

/**
 * @title DegenPrimeStrategy
 * @dev A lending strategy that invests underlying assets into a lending pool, providing yield and rewards.
 */
contract DegenPrimeStrategy is BaseUpgradeableStrategy {

  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  address public constant harvestMSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);

  bytes32 internal constant _PRIME_POOL_SLOT = 0x5a1913411ecfa50e611ef005f90bf3ac03e23ce41462902d023088107e260cf2;
  bytes32 internal constant _STORED_SUPPLIED_SLOT = 0x280539da846b4989609abdccfea039bd1453e4f710c670b29b9eeaca0730c1a2;
  bytes32 internal constant _PENDING_FEE_SLOT = 0x0af7af9f5ccfa82c3497f40c7c382677637aee27293a6243a22216b51481bd97;

  address[] public rewardTokens;

  constructor() BaseUpgradeableStrategy() {
    assert(_PRIME_POOL_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.primePool")) - 1));
    assert(_STORED_SUPPLIED_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.storedSupplied")) - 1));
    assert(_PENDING_FEE_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.pendingFee")) - 1));
  }

  /**
   * @notice Initializes the strategy and verifies compatibility with the Fluid lending pool.
   * @param _storage Address of the storage contract.
   * @param _underlying Address of the underlying asset.
   * @param _vault Address of the vault.
   * @param _primePool Address of the Prime Pool.
   * @param _rewardToken Address of the reward token.
   */
  function initializeBaseStrategy(
    address _storage,
    address _underlying,
    address _vault,
    address _primePool,
    address _rewardToken
  )
  public initializer {
    BaseUpgradeableStrategy.initialize(
      _storage,
      _underlying,
      _vault,
      _primePool,
      _rewardToken,
      harvestMSIG
    );

    require(IPrimePool(_primePool).tokenAddress() == _underlying, "Underlying mismatch");
  }

  /**
   * @notice Returns the current balance of assets in the strategy.
   * @return Current balance of assets in underlying.
   */
  function currentBalance() public view returns (uint256) {
    return IERC20(rewardPool()).balanceOf(address(this));
  }

  /**
   * @notice Returns the last stored balance of assets in the strategy.
   * @return Stored balance of assets.
   */
  function storedBalance() public view returns (uint256) {
    return getUint256(_STORED_SUPPLIED_SLOT);
  }

  /**
   * @notice Updates the stored balance with the current balance.
   */
  function _updateStoredBalance() internal {
    uint256 balance = currentBalance();
    setUint256(_STORED_SUPPLIED_SLOT, balance);
  }

  /**
   * @notice Calculates and returns the total fee numerator.
   * @return Total fee numerator.
   */
  function totalFeeNumerator() public view returns (uint256) {
    return strategistFeeNumerator().add(platformFeeNumerator()).add(profitSharingNumerator());
  }

  /**
   * @notice Returns any accrued but unpaid fees.
   * @return Pending fees.
   */
  function pendingFee() public view returns (uint256) {
    return getUint256(_PENDING_FEE_SLOT);
  }

  /**
   * @notice Accrues fees based on the increase in balance.
   */
  function _accrueFee() internal {
    uint256 fee;
    if (currentBalance() > storedBalance()) {
      uint256 balanceIncrease = currentBalance().sub(storedBalance());
      fee = balanceIncrease.mul(totalFeeNumerator()).div(feeDenominator());
    }
    setUint256(_PENDING_FEE_SLOT, pendingFee().add(fee));
  }

  /**
   * @notice Processes any pending fees, redeems the fee amount, and sends to the controller.
   */
  function _handleFee() internal {
    _accrueFee();
    uint256 fee = pendingFee();
    if (fee > 1e6) {
      _redeem(fee);
      address _underlying = underlying();
      fee = Math.min(fee, IERC20(_underlying).balanceOf(address(this)));
      uint256 balanceIncrease = fee.mul(feeDenominator()).div(totalFeeNumerator());
      _notifyProfitInRewardToken(_underlying, balanceIncrease);
      setUint256(_PENDING_FEE_SLOT, pendingFee().sub(fee));
    }
  }

  /**
   * @notice Determines if a token is unsalvageable (i.e., cannot be removed from the strategy).
   * @param token Address of the token.
   * @return Boolean indicating if the token is unsalvageable.
   */
  function unsalvagableTokens(address token) public view returns (bool) {
    return (token == rewardToken() || token == underlying() || token == rewardPool());
  }

  /**
   * @notice Invests the entire balance of underlying tokens into the lending pool.
   */
  function _investAllUnderlying() internal onlyNotPausedInvesting {
    address _underlying = underlying();
    uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));
    if (underlyingBalance > 1e2) {
      _supply(underlyingBalance);
    }
  }

  /**
   * @notice Withdraws all assets from the strategy and transfers to the vault.
   */
  function withdrawAllToVault() public restricted {
    _liquidateRewards();
    address _underlying = underlying();
    _redeemAll();
    if (IERC20(_underlying).balanceOf(address(this)) > 0) {
      IERC20(_underlying).safeTransfer(vault(), IERC20(_underlying).balanceOf(address(this)));
    }
    _updateStoredBalance();
  }

  /**
   * @notice Exits the strategy by redeeming all assets and pauses further investments.
   */
  function emergencyExit() external onlyGovernance {
    _accrueFee();
    _redeemAll();
    _setPausedInvesting(true);
    emit ToggledEmergencyState(true);
    _updateStoredBalance();
  }

  /**
   * @notice Resumes investing after being paused.
   */
  function continueInvesting() public onlyGovernance {
    _setPausedInvesting(false);
    emit ToggledEmergencyState(false);
  }

  /**
   * @notice Withdraws a specified amount of underlying assets to the vault.
   * @param amountUnderlying Amount of underlying assets to withdraw.
   */
  function withdrawToVault(uint256 amountUnderlying) public restricted {
    _accrueFee();
    address _underlying = underlying();
    uint256 balance = IERC20(_underlying).balanceOf(address(this));
    if (amountUnderlying <= balance) {
      IERC20(_underlying).safeTransfer(vault(), amountUnderlying);
      return;
    }
    uint256 toRedeem = amountUnderlying.sub(balance);
    _redeem(toRedeem);
    balance = IERC20(_underlying).balanceOf(address(this));
    IERC20(_underlying).safeTransfer(vault(), Math.min(amountUnderlying, balance));
    if (balance > 1e2) {
      _investAllUnderlying();
    }
    _updateStoredBalance();
  }

  /**
   * @notice Executes the main strategy logic including reward liquidation and reinvestment.
   */
  function doHardWork() public restricted {
    _liquidateRewards();
    _investAllUnderlying();
    _updateStoredBalance();
  }

  /**
   * @notice Salvages a token that is not essential to the strategy's core operations.
   * @param recipient Address to receive the salvaged tokens.
   * @param token Address of the token to salvage.
   * @param amount Amount of tokens to salvage.
   */
  function salvage(address recipient, address token, uint256 amount) public onlyGovernance {
    require(!unsalvagableTokens(token), "Token is non-salvageable");
    IERC20(token).safeTransfer(recipient, amount);
  }

  /**
   * @notice Adds a new reward token to the strategy.
   * @param _token Address of the reward token to add.
   */
  function addRewardToken(address _token) public onlyGovernance {
    rewardTokens.push(_token);
    emit RewardTokenAdded(_token);
  }

  /**
   * @notice Liquidates rewards by converting them to the underlying asset.
   */
  function _liquidateRewards() internal {
    if (!sell()) {
      emit ProfitsNotCollected(sell(), false);
      return;
    }
    _handleFee();
  }

  /**
   * @notice Returns the total balance of underlying assets held by the strategy.
   * @return Total balance of underlying assets.
   */
  function investedUnderlyingBalance() public view returns (uint256) {
    return IERC20(underlying()).balanceOf(address(this))
    .add(storedBalance())
    .sub(pendingFee());
  }

  /**
   * @notice Supplies a specified amount of underlying tokens to the lending pool.
   * @param amount Amount of tokens to supply.
   */
  function _supply(uint256 amount) internal {
    address _underlying = underlying();
    address _rewardPool = rewardPool();
    IERC20(_underlying).safeApprove(_rewardPool, 0);
    IERC20(_underlying).safeApprove(_rewardPool, amount);
    IPrimePool(_rewardPool).deposit(amount);
  }

  /**
   * @notice Redeems a specified amount of underlying tokens from the lending pool.
   * @param amountUnderlying Amount of underlying tokens to redeem.
   */
  function _redeem(uint256 amountUnderlying) internal {
    address _rewardPool = rewardPool();
    IPrimePool(_rewardPool).instantWithdraw(amountUnderlying);
  }

  /**
   * @notice Redeems all assets from the lending pool.
   */
  function _redeemAll() internal {
    address _rewardPool = rewardPool();
    if (IERC20(_rewardPool).balanceOf(address(this)) > 0) {
      IPrimePool(_rewardPool).instantWithdraw(
        IERC20(_rewardPool).balanceOf(address(this)).sub(pendingFee())
      );
    }
  }

  /**
   * @notice Finalizes the upgrade of the strategy.
   */
  function finalizeUpgrade() external onlyGovernance {
    _finalizeUpgrade();
  }

  receive() external payable {}
}
