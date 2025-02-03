// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/upgradability/BaseUpgradeableStrategy.sol";
import "../../base/interface/extrafi/ILendingPool.sol";
import "../../base/interface/extrafi/IStakingRewards.sol";

/**
 * @title ExtraFiLendStrategy
 * @dev A lending strategy on ExtraFi platform, depositing underlying assets for yield generation.
 *      This contract allows staking, reward claiming, and liquidation functionalities.
 */
contract ExtraFiLendStrategy is BaseUpgradeableStrategy {
  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  address public constant harvestMSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);

  bytes32 internal constant _MARKET_SLOT = 0x7e894854bb2aa938fcac0eb9954ddb51bd061fc228fb4e5b8e859d96c06bfaa0;
  bytes32 internal constant _RESERVE_ID_SLOT = 0x86aa26bf7baa3789bd8bb93af5347b4e50191118805c3e074f92814ccc798549;
  bytes32 internal constant _STORED_SUPPLIED_SLOT = 0x280539da846b4989609abdccfea039bd1453e4f710c670b29b9eeaca0730c1a2;
  bytes32 internal constant _PENDING_FEE_SLOT = 0x0af7af9f5ccfa82c3497f40c7c382677637aee27293a6243a22216b51481bd97;

  address[] public rewardTokens;

  constructor() BaseUpgradeableStrategy() {
    assert(_MARKET_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.market")) - 1));
    assert(_RESERVE_ID_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.reserveId")) - 1));
    assert(_STORED_SUPPLIED_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.storedSupplied")) - 1));
    assert(_PENDING_FEE_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.pendingFee")) - 1));
  }

  /**
   * @notice Initializes the strategy and verifies compatibility with the ExtraFi lending pool.
   * @param _storage Address of the storage contract.
   * @param _underlying Address of the underlying asset.
   * @param _vault Address of the vault.
   * @param _market Address of the lending market.
   * @param _reserveId Reserve ID for the underlying asset in the lending pool.
   * @param _rewardPool Address of the reward pool.
   * @param _rewardToken Address of the reward token.
   */
  function initializeBaseStrategy(
    address _storage,
    address _underlying,
    address _vault,
    address _market,
    uint256 _reserveId,
    address _rewardPool,
    address _rewardToken
  )
  public initializer {
    BaseUpgradeableStrategy.initialize(
      _storage,
      _underlying,
      _vault,
      _rewardPool,
      _rewardToken,
      harvestMSIG
    );

    require(ILendingPool(_market).getUnderlyingTokenAddress(_reserveId) == _underlying, "Underlying mismatch");
    require(ILendingPool(_market).getStakingAddress(_reserveId) == _rewardPool, "RewardPool mismatch");
    _setMarket(_market);
    _setReserveId(_reserveId);
  }

  /**
   * @notice Returns the current balance of assets in the strategy including any exchange rate adjustments.
   * @return Current balance of assets.
   */
  function currentBalance() public view returns (uint256) {
    uint256 balance = IStakingRewards(rewardPool()).balanceOf(address(this));
    uint256 exchangeRate = ILendingPool(market()).exchangeRateOfReserve(reserveId());
    return balance.mul(exchangeRate).div(1e18);
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
   * @notice Calculates and accrues the fee based on the increase in balance.
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
   * @notice Handles and processes the pending fees.
   */
  function _handleFee() internal {
    _accrueFee();
    uint256 fee = pendingFee();
    if (fee > 10) {
      uint256 balanceIncrease = fee.mul(feeDenominator()).div(totalFeeNumerator());
      _redeem(fee);
      address _underlying = underlying();
      if (IERC20(_underlying).balanceOf(address(this)) < fee) {
        balanceIncrease = IERC20(_underlying).balanceOf(address(this)).mul(feeDenominator()).div(totalFeeNumerator());
      }
      _notifyProfitInRewardToken(_underlying, balanceIncrease);
      setUint256(_PENDING_FEE_SLOT, 0);
    }
    _updateStoredBalance();
  }

  /**
   * @notice Determines if a token is unsalvageable (i.e., cannot be removed from the strategy).
   * @param token Address of the token.
   * @return Boolean indicating if the token is unsalvageable.
   */
  function unsalvagableTokens(address token) public view returns (bool) {
    return (token == rewardToken() || token == underlying());
  }

  /**
   * @notice Invests the entire balance of underlying tokens into the lending pool.
   */
  function _investAllUnderlying() internal onlyNotPausedInvesting {
    address _underlying = underlying();
    uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));
    if (underlyingBalance > 0) {
      _supply(underlyingBalance);
    }
  }

  /**
   * @notice Exits the ExtraFi platform and transfers all assets to the vault.
   */
  function withdrawAllToVault() public restricted {
    _handleFee();
    _claimRewards();
    _liquidateRewards();
    address _underlying = underlying();
    _redeemAll();
    if (IERC20(_underlying).balanceOf(address(this)) > 0) {
      IERC20(_underlying).safeTransfer(vault(), IERC20(_underlying).balanceOf(address(this)));
    }
    _updateStoredBalance();
  }

  /**
   * @notice Performs an emergency exit by stopping investments and redeeming all assets.
   */
  function emergencyExit() external onlyGovernance {
    _accrueFee();
    _redeemAll();
    _setPausedInvesting(true);
    _updateStoredBalance();
  }

  /**
   * @notice Resumes investing after being paused.
   */
  function continueInvesting() public onlyGovernance {
    _setPausedInvesting(false);
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
    if (balance > 0) {
      _investAllUnderlying();
    }
    _updateStoredBalance();
  }

  /**
   * @notice Executes the main strategy logic including fee handling, reward claiming, and reinvestment.
   */
  function doHardWork() public restricted {
    _handleFee();
    _claimRewards();
    _liquidateRewards();
    _investAllUnderlying();
    _updateStoredBalance();
  }

  /**
   * @notice Salvages a token not essential to the strategy's core operations.
   * @param recipient Address to receive the salvaged tokens.
   * @param token Address of the token to salvage.
   * @param amount Amount of tokens to salvage.
   */
  function salvage(address recipient, address token, uint256 amount) public onlyGovernance {
    require(!unsalvagableTokens(token), "Token is non-salvageable");
    IERC20(token).safeTransfer(recipient, amount);
  }

  /**
   * @notice Claims rewards from the reward pool.
   */
  function _claimRewards() internal {
    IStakingRewards(rewardPool()).claim();
  }

  /**
   * @notice Adds a new reward token to the strategy.
   * @param _token Address of the reward token to add.
   */
  function addRewardToken(address _token) public onlyGovernance {
    rewardTokens.push(_token);
  }

  /**
   * @notice Liquidates rewards by converting them to the underlying asset.
   */
  function _liquidateRewards() internal {
    if (!sell()) {
      emit ProfitsNotCollected(sell(), false);
      return;
    }
    address _rewardToken = rewardToken();
    address _universalLiquidator = universalLiquidator();
    for (uint256 i; i < rewardTokens.length; i++) {
      address token = rewardTokens[i];
      uint256 balance = IERC20(token).balanceOf(address(this));
      if (balance == 0) {
          continue;
      }
      if (token != _rewardToken){
          IERC20(token).safeApprove(_universalLiquidator, 0);
          IERC20(token).safeApprove(_universalLiquidator, balance);
          IUniversalLiquidator(_universalLiquidator).swap(token, _rewardToken, balance, 1, address(this));
      }
    }
    uint256 rewardBalance = IERC20(_rewardToken).balanceOf(address(this));
    _notifyProfitInRewardToken(_rewardToken, rewardBalance);
    uint256 remainingRewardBalance = IERC20(_rewardToken).balanceOf(address(this));

    if (remainingRewardBalance < 1e13) {
      return;
    }
  
    address _underlying = underlying();
    if (_underlying != _rewardToken) {
      IERC20(_rewardToken).safeApprove(_universalLiquidator, 0);
      IERC20(_rewardToken).safeApprove(_universalLiquidator, remainingRewardBalance);
      IUniversalLiquidator(_universalLiquidator).swap(_rewardToken, _underlying, remainingRewardBalance, 1, address(this));
    }
  }

  /**
   * @notice Returns the total invested underlying balance.
   */
  function investedUnderlyingBalance() public view returns (uint256) {
    return IERC20(underlying()).balanceOf(address(this))
    .add(storedBalance());
  }

  /**
   * @notice Supplies underlying tokens to the lending pool.
   * @param amount Amount of tokens to supply.
   */
  function _supply(uint256 amount) internal {
    address _underlying = underlying();
    address _market = market();
    uint256 exchangeRate = ILendingPool(_market).exchangeRateOfReserve(reserveId());
    if (amount.mul(10) > exchangeRate.mul(10).div(1e18)){
      IERC20(_underlying).safeApprove(_market, 0);
      IERC20(_underlying).safeApprove(_market, amount);
      ILendingPool(_market).depositAndStake(reserveId(), amount, address(this), uint16(0));
    }
  }

  /**
   * @notice Redeems a specified amount of underlying tokens from the lending pool.
   * @param amountUnderlying Amount of underlying tokens to redeem.
   */
  function _redeem(uint256 amountUnderlying) internal {
    address _market = market();
    uint256 _reserveId = reserveId();
    uint256 exchangeRate = ILendingPool(_market).exchangeRateOfReserve(_reserveId);
    uint256 amount = amountUnderlying.mul(1e18).div(exchangeRate).add(1);
    ILendingPool(_market).unStakeAndWithdraw(_reserveId, amount, address(this), false);
  }

  /**
   * @notice Redeems all tokens from the lending pool.
   */
  function _redeemAll() internal {
    if (IStakingRewards(rewardPool()).balanceOf(address(this)) > 0) {
      ILendingPool(market()).unStakeAndWithdraw(
        reserveId(),
        IStakingRewards(rewardPool()).balanceOf(address(this)),
        address(this),
        false
      );
    }
  }

  /**
   * @notice Sets the address of the lending market.
   * @param _target Address of the lending market.
   */
  function _setMarket (address _target) internal {
    setAddress(_MARKET_SLOT, _target);
  }

  /**
   * @notice Returns the address of the lending market.
   * @return Address of the lending market.
   */
  function market() public view returns (address) {
    return getAddress(_MARKET_SLOT);
  }

  /**
   * @notice Sets the reserve ID in the lending pool.
   * @param _target Reserve ID.
   */
  function _setReserveId (uint256 _target) internal {
    setUint256(_RESERVE_ID_SLOT, _target);
  }

  /**
   * @notice Returns the reserve ID in the lending pool.
   * @return Reserve ID.
   */
  function reserveId() public view returns (uint256) {
    return getUint256(_RESERVE_ID_SLOT);
  }

  /**
   * @notice Finalizes the upgrade of the strategy.
   */
  function finalizeUpgrade() external onlyGovernance {
    _finalizeUpgrade();
  }

  receive() external payable {}
}
