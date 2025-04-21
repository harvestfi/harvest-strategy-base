// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BaseUpgradeableStrategy} from "../../../base/upgradability/BaseUpgradeableStrategy.sol";
import {IUniversalLiquidator} from "../../../base/interface/IUniversalLiquidator.sol";
import {ErrorsLib} from "../libraries/ErrorsLib.sol";
import {StateAccessor} from "./StateAccessor.sol";
import {Checks} from "./Checks.sol";

/// @title StrategyOps
/// @author Harvest Community Foundation
/// @notice The StrategyOps contract.
/// @dev This contract can be turned into an library in the future after BaseUpgradeableStrategy is modularized.

abstract contract StrategyOps is BaseUpgradeableStrategy, StateAccessor, Checks {
    using SafeERC20 for IERC20;

    /// @dev Reset on each upgrade
    address[] public rewardTokens;

    /**
     * @notice Salvages a token.
     * @param recipient The recipient of the salvage.
     * @param token The token to salvage.
     * @param amount The amount of tokens to salvage.
     * @dev To make sure that governance cannot come in and take away the coins
     */
    function salvage(address recipient, address token, uint256 amount) public onlyGovernance {
        if (unsalvagableTokens(token)) revert ErrorsLib.TokenNotSalvagable(token);
        IERC20(token).safeTransfer(recipient, amount);
    }

    /**
     * @notice Liquidates rewards.
     * @param _sell Whether to sell the rewards.
     * @param _rewardToken The reward token.
     * @param _universalLiquidator The universal liquidator.
     * @param _underlying The underlying token.
     */
    function _liquidateRewards(bool _sell, address _rewardToken, address _universalLiquidator, address _underlying)
        internal
    {
        if (!_sell) {
            emit ProfitsNotCollected(_sell, false);
            return;
        }

        for (uint256 i; i < rewardTokens.length; i++) {
            address token = rewardTokens[i];
            uint256 balance = IERC20(token).balanceOf(address(this));
            if (balance == 0) continue;
            if (token != _rewardToken) {
                IERC20(token).safeIncreaseAllowance(_universalLiquidator, balance);
                IUniversalLiquidator(_universalLiquidator).swap(token, _rewardToken, balance, 1, address(this));
            }
        }
        uint256 rewardBalance = IERC20(_rewardToken).balanceOf(address(this));
        if (rewardBalance < 1e8) return;

        _notifyProfitInRewardToken(_rewardToken, rewardBalance);

        uint256 remainingRewardBalance = IERC20(_rewardToken).balanceOf(address(this));
        if (remainingRewardBalance < 1e10) return;

        if (_underlying != _rewardToken) {
            IERC20(_rewardToken).safeIncreaseAllowance(_universalLiquidator, remainingRewardBalance);
            IUniversalLiquidator(_universalLiquidator).swap(
                _rewardToken, _underlying, remainingRewardBalance, 1, address(this)
            );
        }
    }

    /**
     * @notice Adds a reward token.
     * @param _token The token to add.
     */
    function addRewardToken(address _token) public onlyGovernance {
        rewardTokens.push(_token);
    }

    receive() external payable {}
}
