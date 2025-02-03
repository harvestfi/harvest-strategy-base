// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/upgradability/BaseUpgradeableStrategy.sol";
import "../../base/interface/aerodrome/IGauge.sol";
import "../../base/interface/aerodrome/IPool.sol";
import "../../base/interface/aerodrome/IRouter.sol";

/**
 * @title AerodromeVolatileStrategy
 * @dev A strategy contract for volatile Aerodrome liquidity pools, allowing staking, claiming rewards,
 * and reinvesting profits into the pool. Inherits from `BaseUpgradeableStrategy`.
 */
contract AerodromeVolatileStrategy is BaseUpgradeableStrategy {
  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  address public constant aeroRouter = address(0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43);
  address public constant harvestMSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);

  address[] public rewardTokens;

  constructor() BaseUpgradeableStrategy() {}

  /**
   * @notice Initializes the strategy and verifies gauge compatibility with underlying asset.
   * @param _storage Address of the storage contract.
   * @param _underlying Address of the underlying asset.
   * @param _vault Address of the vault.
   * @param _gauge Address of the gauge contract for staking.
   * @param _rewardToken Address of the reward token.
   */
  function initializeBaseStrategy(
    address _storage,
    address _underlying,
    address _vault,
    address _gauge,
    address _rewardToken
  ) public initializer {
    BaseUpgradeableStrategy.initialize(
      _storage,
      _underlying,
      _vault,
      _gauge,
      _rewardToken,
      harvestMSIG
    );

    if (_gauge != address(0)) {
      address _lpt = IGauge(rewardPool()).stakingToken();
      require(_lpt == _underlying, "Underlying mismatch");
    }
  }

  /**
   * @notice Gets the balance of staked tokens in the reward pool.
   * @return balance The staked balance in the reward pool.
   */
  function _rewardPoolBalance() internal view returns (uint256 balance) {
    if (rewardPool() != address(0)) {
      balance = IGauge(rewardPool()).balanceOf(address(this));
    } else {
      balance = 0;
    }
  }

  /**
   * @notice Exits the reward pool in case of emergency.
   */
  function _emergencyExitRewardPool() internal {
    uint256 stakedBalance = _rewardPoolBalance();
    if (stakedBalance != 0) {
        _withdrawUnderlyingFromPool(stakedBalance);
    }
  }

  /**
   * @notice Withdraws a specified amount of underlying tokens from the reward pool.
   * @param amount Amount of tokens to withdraw.
   */
  function _withdrawUnderlyingFromPool(uint256 amount) internal {
    if (amount > 0) {
      IGauge(rewardPool()).withdraw(amount);
    }
  }

  /**
   * @notice Deposits the entire balance of underlying tokens into the reward pool.
   */
  function _enterRewardPool() internal {
    address underlying_ = underlying();
    address rewardPool_ = rewardPool();
    if (rewardPool_ == address(0)) {
      return;
    }
    uint256 entireBalance = IERC20(underlying_).balanceOf(address(this));
    IERC20(underlying_).safeApprove(rewardPool_, 0);
    IERC20(underlying_).safeApprove(rewardPool_, entireBalance);
    IGauge(rewardPool_).deposit(entireBalance);
  }

  /**
   * @notice Invests all underlying tokens into the reward pool if investing is not paused.
   */
  function _investAllUnderlying() internal onlyNotPausedInvesting {
    if (IERC20(underlying()).balanceOf(address(this)) > 0) {
      _enterRewardPool();
    }
  }

  /**
   * @notice Emergency function to exit the reward pool and stop investing.
   */
  function emergencyExit() public onlyGovernance {
    _emergencyExitRewardPool();
    _setPausedInvesting(true);
  }

  /**
   * @notice Resumes investing in the reward pool after being paused.
   */
  function continueInvesting() public onlyGovernance {
    _setPausedInvesting(false);
  }

  /**
   * @notice Checks if a token is non-salvageable (i.e., cannot be removed from the strategy).
   * @param token Address of the token to check.
   * @return Boolean indicating if the token is non-salvageable.
   */
  function unsalvagableTokens(address token) public view returns (bool) {
    return (token == rewardToken() || token == underlying());
  }

  /**
   * @notice Adds a new reward token to the list of reward tokens.
   * @param _token Address of the reward token to add.
   */
  function addRewardToken(address _token) public onlyGovernance {
    rewardTokens.push(_token);
  }

  /**
   * @notice Claims rewards from the reward pool and associated pools.
   */
  function _claimRewards() internal {
    IPool(underlying()).claimFees();
    if (rewardPool() != address(0)) {
      IGauge(rewardPool()).getReward(address(this));
    }
  }

  /**
   * @notice Liquidates all rewards by converting them to the underlying asset.
   */
  function _liquidateReward() internal {
    if (!sell()) {
      emit ProfitsNotCollected(sell(), false);
      return;
    }

    address _rewardToken = rewardToken();
    address _universalLiquidator = universalLiquidator();
    for (uint256 i = 0; i < rewardTokens.length; i++) {
      address token = rewardTokens[i];
      uint256 balance = IERC20(token).balanceOf(address(this));
      if (balance == 0) {
        continue;
      }
      if (token != _rewardToken) {
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
    address token0 = IPool(_underlying).token0();
    address token1 = IPool(_underlying).token1();

    uint256 toToken0 = remainingRewardBalance.div(2);
    uint256 toToken1 = remainingRewardBalance.sub(toToken0);

    IERC20(_rewardToken).safeApprove(_universalLiquidator, 0);
    IERC20(_rewardToken).safeApprove(_universalLiquidator, remainingRewardBalance);

    uint256 token0Amount;
    if (token0 != _rewardToken) {
      IUniversalLiquidator(_universalLiquidator).swap(_rewardToken, token0, toToken0, 1, address(this));
      token0Amount = IERC20(token0).balanceOf(address(this));
    } else {
      token0Amount = toToken0;
    }

    uint256 token1Amount;
    if (token1 != _rewardToken) {
      IUniversalLiquidator(_universalLiquidator).swap(_rewardToken, token1, toToken1, 1, address(this));
      token1Amount = IERC20(token1).balanceOf(address(this));
    } else {
      token1Amount = toToken1;
    }

    IERC20(token0).safeApprove(aeroRouter, 0);
    IERC20(token0).safeApprove(aeroRouter, token0Amount);

    IERC20(token1).safeApprove(aeroRouter, 0);
    IERC20(token1).safeApprove(aeroRouter, token1Amount);

    IRouter(aeroRouter).addLiquidity(
      token0,
      token1,
      false,
      token0Amount,
      token1Amount,
      1,
      1,
      address(this),
      block.timestamp
    );
  }

  /**
   * @notice Withdraws all underlying assets to the vault.
   */
  function withdrawAllToVault() public restricted {
    _withdrawUnderlyingFromPool(_rewardPoolBalance());
    _claimRewards();
    _liquidateReward();
    address underlying_ = underlying();
    IERC20(underlying_).safeTransfer(vault(), IERC20(underlying_).balanceOf(address(this)));
  }

  /**
   * @notice Withdraws a specified amount of underlying assets to the vault.
   * @param _amount Amount of underlying assets to withdraw.
   */
  function withdrawToVault(uint256 _amount) public restricted {
    address underlying_ = underlying();
    uint256 entireBalance = IERC20(underlying_).balanceOf(address(this));

    if (_amount > entireBalance) {
      uint256 needToWithdraw = _amount.sub(entireBalance);
      uint256 toWithdraw = Math.min(_rewardPoolBalance(), needToWithdraw);
      _withdrawUnderlyingFromPool(toWithdraw);
    }
    IERC20(underlying_).safeTransfer(vault(), _amount);
  }

  /**
   * @notice Returns the total balance of underlying assets managed by the strategy.
   * @return Total balance of underlying assets.
   */
  function investedUnderlyingBalance() external view returns (uint256) {
    if (rewardPool() == address(0)) {
      return IERC20(underlying()).balanceOf(address(this));
    }
    return _rewardPoolBalance().add(IERC20(underlying()).balanceOf(address(this)));
  }

  /**
   * @notice Allows governance or the controller to salvage tokens that are not part of the core strategy.
   * @param recipient Address to receive the salvaged tokens.
   * @param token Address of the token to salvage.
   * @param amount Amount of tokens to salvage.
   */
  function salvage(address recipient, address token, uint256 amount) external onlyControllerOrGovernance {
    require(!unsalvagableTokens(token), "Token is non-salvageable");
    IERC20(token).safeTransfer(recipient, amount);
  }

  /**
   * @notice Claims rewards, sells them, and reinvests in the reward pool.
   */
  function doHardWork() external onlyNotPausedInvesting restricted {
    _claimRewards();
    _liquidateReward();
    _investAllUnderlying();
  }

  /**
   * @notice Updates the gauge address and reinvests all funds in the new gauge.
   * @param _newGauge Address of the new gauge.
   */
  function setGauge(address _newGauge) external onlyGovernance {
    _withdrawUnderlyingFromPool(_rewardPoolBalance());
    _claimRewards();
    _liquidateReward();

    address _lpt = IGauge(_newGauge).stakingToken();
    require(_lpt == underlying(), "Underlying mismatch");

    _setRewardPool(_newGauge);
    _investAllUnderlying();
  }

  /**
   * @notice Enables or disables the selling of rewards for the strategy.
   * @param s Boolean to enable or disable selling.
   */
  function setSell(bool s) public onlyGovernance {
    _setSell(s);
  }

  /**
   * @notice Finalizes the strategy upgrade.
   */
  function finalizeUpgrade() external onlyGovernance {
    _finalizeUpgrade();
  }
}
