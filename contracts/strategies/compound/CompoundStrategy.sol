// SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/upgradability/BaseUpgradeableStrategy.sol";
import "../../base/interface/compound/IComet.sol";
import "../../base/interface/compound/ICometRewards.sol";

/**
 * @title CompoundStrategy
 * @dev A strategy for depositing assets into Compound's Comet protocol for yield and reward generation,
 * allowing interaction with staking pools, reward claiming, and liquidation. Inherits from `BaseUpgradeableStrategy`.
 */
contract CompoundStrategy is BaseUpgradeableStrategy {
  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  address public constant harvestMSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);

  // Additional storage slots (specific to this strategy)
  bytes32 internal constant _MARKET_SLOT = 0x7e894854bb2aa938fcac0eb9954ddb51bd061fc228fb4e5b8e859d96c06bfaa0;

  constructor() public BaseUpgradeableStrategy() {
    assert(_MARKET_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.market")) - 1));
  }

  /**
   * @notice Initializes the strategy and verifies compatibility with Compound's Comet market.
   * @param _storage Address of the storage contract.
   * @param _underlying Address of the underlying asset.
   * @param _vault Address of the vault.
   * @param _market Address of the Comet market.
   * @param _rewardPool Address of the reward pool.
   * @param _rewardToken Address of the reward token.
   */
  function initializeBaseStrategy(
    address _storage,
    address _underlying,
    address _vault,
    address _market,
    address _rewardPool,
    address _rewardToken
  ) public initializer {
    BaseUpgradeableStrategy.initialize(
      _storage,
      _underlying,
      _vault,
      _rewardPool,
      _rewardToken,
      harvestMSIG
    );

    address _lpt = IComet(_market).baseToken();
    require(_lpt == _underlying, "Underlying mismatch");

    _setMarket(_market);
  }

  /**
   * @notice Gets the current balance of the reward pool for this strategy.
   * @return balance The balance in the reward pool.
   */
  function _rewardPoolBalance() internal view returns (uint256 balance) {
    balance = IComet(market()).balanceOf(address(this));
  }

  /**
   * @notice Exits the reward pool in case of an emergency.
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
    IComet(market()).withdraw(underlying(), Math.min(_rewardPoolBalance(), amount));
  }

  /**
   * @notice Supplies the entire balance of underlying tokens to the reward pool.
   */
  function _enterRewardPool() internal {
    address underlying_ = underlying();
    address market_ = market();
    uint256 entireBalance = IERC20(underlying_).balanceOf(address(this));
    IERC20(underlying_).safeApprove(market_, 0);
    IERC20(underlying_).safeApprove(market_, entireBalance);
    IComet(market_).supply(underlying_, entireBalance);
  }

  /**
   * @notice Invests all underlying tokens in the reward pool if investing is not paused.
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
   * @notice Checks if a given token is non-salvageable (i.e., cannot be removed from the strategy).
   * @param token Address of the token to check.
   * @return Boolean indicating if the token is non-salvageable.
   */
  function unsalvagableTokens(address token) public view returns (bool) {
    return (token == rewardToken() || token == underlying() || token == market());
  }

  /**
   * @notice Claims rewards from the reward pool.
   */
  function _claimReward() internal {
    ICometRewards(rewardPool()).claim(market(), address(this), true);
  }

  /**
   * @notice Liquidates rewards by converting them to the underlying asset.
   */
  function _liquidateReward() internal {
    if (!sell()) {
      emit ProfitsNotCollected(sell(), false);
      return;
    }
    address _rewardToken = rewardToken();
    address _universalLiquidator = universalLiquidator();

    uint256 rewardBalance = IERC20(_rewardToken).balanceOf(address(this));
    _notifyProfitInRewardToken(_rewardToken, rewardBalance);
    uint256 remainingRewardBalance = IERC20(_rewardToken).balanceOf(address(this));

    if (remainingRewardBalance == 0) {
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
   * @notice Withdraws all underlying assets to the vault.
   */
  function withdrawAllToVault() public restricted {
    _withdrawUnderlyingFromPool(_rewardPoolBalance());
    _claimReward();
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
    _claimReward();
    _liquidateReward();
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
   * @notice Internal function to set the address of the Compound Comet market.
   * @param _address Address of the Compound Comet market.
   */
  function _setMarket(address _address) internal {
    setAddress(_MARKET_SLOT, _address);
  }

  /**
   * @notice Returns the address of the Compound Comet market.
   * @return Address of the market.
   */
  function market() public view returns (address) {
    return getAddress(_MARKET_SLOT);
  }

  /**
   * @notice Finalizes the strategy upgrade.
   */
  function finalizeUpgrade() external onlyGovernance {
    _finalizeUpgrade();
  }
}
