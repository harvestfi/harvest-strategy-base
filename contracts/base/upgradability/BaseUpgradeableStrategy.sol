// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "./BaseUpgradeableStrategyStorage.sol";
import "../inheritance/ControllableInit.sol";
import "../interface/IController.sol";
import "../interface/IRewardForwarder.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title BaseUpgradeableStrategy
 * @dev Upgradeable strategy contract to manage investment and profit distribution logic,
 * supporting upgradeable deployment with governance-controlled parameters.
 * Inherits from `ControllableInit` for governance and controller access.
 */
contract BaseUpgradeableStrategy is Initializable, ControllableInit, BaseUpgradeableStrategyStorage {
  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  /// @notice Emitted when profits are not collected due to specific conditions.
  event ProfitsNotCollected(bool sell, bool floor);

  /// @notice Emitted when a profit is logged in the reward token.
  event ProfitLogInReward(uint256 profitAmount, uint256 feeAmount, uint256 timestamp);

  /// @notice Emitted when a profit and buyback is logged.
  event ProfitAndBuybackLog(uint256 profitAmount, uint256 feeAmount, uint256 timestamp);

  /**
   * @dev Restricts access to only the controller, governance, or the vault.
   * Reverts if the caller is not one of these roles.
   */
  modifier restricted() {
    require(
      msg.sender == vault() || msg.sender == controller() || msg.sender == governance(),
      "The sender has to be the controller, governance, or vault"
    );
    _;
  }

  /**
   * @dev Restricts actions if the strategy is in emergency state.
   * Reverts if `pausedInvesting` is true.
   */
  modifier onlyNotPausedInvesting() {
    require(!pausedInvesting(), "Action blocked as the strategy is in emergency state");
    _;
  }

  /**
   * @dev Empty constructor for upgradeable strategy storage initialization.
   */
  constructor() BaseUpgradeableStrategyStorage() {}

  /**
   * @notice Initializes the strategy contract with necessary parameters.
   * @param _storage The address of the storage contract.
   * @param _underlying The address of the underlying token for investment.
   * @param _vault The address of the vault.
   * @param _rewardPool The address of the reward pool.
   * @param _rewardToken The address of the reward token.
   * @param _strategist The address of the strategist.
   */
  function initialize(
    address _storage,
    address _underlying,
    address _vault,
    address _rewardPool,
    address _rewardToken,
    address _strategist
  ) public initializer {
    ControllableInit.initialize(_storage);
    _setUnderlying(_underlying);
    _setVault(_vault);
    _setRewardPool(_rewardPool);
    _setRewardToken(_rewardToken);
    _setStrategist(_strategist);
    _setSell(true);
    _setSellFloor(0);
    _setPausedInvesting(false);
  }

  /**
   * @notice Schedules an upgrade for the strategy's implementation.
   * @param impl The address of the new implementation contract.
   * Can only be called by governance.
   */
  function scheduleUpgrade(address impl) public onlyGovernance {
    _setNextImplementation(impl);
    _setNextImplementationTimestamp(block.timestamp.add(nextImplementationDelay()));
  }

  /**
   * @dev Resets the scheduled upgrade parameters to zero after an upgrade is finalized.
   */
  function _finalizeUpgrade() internal {
    _setNextImplementation(address(0));
    _setNextImplementationTimestamp(0);
  }

  /**
   * @notice Checks if an upgrade is scheduled and ready to execute.
   * @return A boolean indicating if the upgrade should proceed and the address of the new implementation.
   */
  function shouldUpgrade() external view returns (bool, address) {
    return (
      nextImplementationTimestamp() != 0 &&
      block.timestamp > nextImplementationTimestamp() &&
      nextImplementation() != address(0),
      nextImplementation()
    );
  }

  // ========================= Internal & Private Functions =========================

  // ==================== Functionality ====================

  /**
   * @dev Logs the profit in reward token without a compounding buyback.
   * Only takes fees for distribution.
   * @param _rewardToken The address of the reward token.
   * @param _rewardBalance The balance of reward tokens to process for fees.
   * Emits ProfitLogInReward, PlatformFeeLogInReward, and StrategistFeeLogInReward events.
   */
  function _notifyProfitInRewardToken(
      address _rewardToken,
      uint256 _rewardBalance
  ) internal {
    if (_rewardBalance > 10) {
      uint256 _feeDenominator = feeDenominator();
      uint256 strategistFee = _rewardBalance.mul(strategistFeeNumerator()).div(_feeDenominator);
      uint256 platformFee = _rewardBalance.mul(platformFeeNumerator()).div(_feeDenominator);
      uint256 profitSharingFee = _rewardBalance.mul(profitSharingNumerator()).div(_feeDenominator);

      address strategyFeeRecipient = strategist();
      address platformFeeRecipient = IController(controller()).governance();

      emit ProfitLogInReward(_rewardToken, _rewardBalance, profitSharingFee, block.timestamp);
      emit PlatformFeeLogInReward(platformFeeRecipient, _rewardToken, _rewardBalance, platformFee, block.timestamp);
      emit StrategistFeeLogInReward(strategyFeeRecipient, _rewardToken, _rewardBalance, strategistFee, block.timestamp);

      address rewardForwarder = IController(controller()).rewardForwarder();
      IERC20(_rewardToken).safeApprove(rewardForwarder, 0);
      IERC20(_rewardToken).safeApprove(rewardForwarder, _rewardBalance);

      // Distribute/send the fees
      IRewardForwarder(rewardForwarder).notifyFee(
        _rewardToken,
        profitSharingFee,
        strategistFee,
        platformFee
      );
    } else {
      emit ProfitLogInReward(_rewardToken, 0, 0, block.timestamp);
      emit PlatformFeeLogInReward(IController(controller()).governance(), _rewardToken, 0, 0, block.timestamp);
      emit StrategistFeeLogInReward(strategist(), _rewardToken, 0, 0, block.timestamp);
    }
  }

  uint256[50] private ______gap;
}
