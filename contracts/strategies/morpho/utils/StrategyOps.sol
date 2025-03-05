// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUniversalLiquidator} from "../../../base/interface/IUniversalLiquidator.sol";
import {BaseUpgradeableStrategy} from "../../../base/upgradability/BaseUpgradeableStrategy.sol";

/// @title StrategyOps
/// @author Harvest Community Foundation
/// @notice The StrategyOps contract.
/// @dev This contract can be turned into an library in the future after BaseUpgradeableStrategy is modularized.

abstract contract StrategyOps is BaseUpgradeableStrategy {
    using SafeERC20 for IERC20;

    /// @dev Reset on each upgrade
    address[] public rewardTokens;

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

    function addRewardToken(address _token) public onlyGovernance {
        rewardTokens.push(_token);
    }

    receive() external payable {}
}
