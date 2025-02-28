// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMorpho, MarketParams} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";

import {BaseUpgradeableStrategyStorage} from "../../../base/upgradability/BaseUpgradeableStrategyStorage.sol";
import {MLSConstantsLib} from "../libraries/MLSConstantsLib.sol";
import {StateAccessor} from "./StateAccessor.sol";

abstract contract MorphoOps is BaseUpgradeableStrategyStorage, StateAccessor {
    using SafeERC20 for IERC20;
    /**
     * _supply -> supplyCollateral
     * _borrow -> borrow
     * _redeem -> withdrawCollateral
     * _repay -> repayAmount
     */

    function _supplyCollateralWrap(uint256 amount) internal {
        if (amount == 0) return;

        address _underlying = underlying();
        uint256 _balance = IERC20(_underlying).balanceOf(address(this));

        if (amount < _balance) _balance = amount;

        // Approve and supply collateral
        IERC20(_underlying).safeIncreaseAllowance(MLSConstantsLib.MORPHO_BLUE, _balance);

        IMorpho(MLSConstantsLib.MORPHO_BLUE).supplyCollateral(
            MarketParams({
                loanToken: getLoanToken(),
                collateralToken: _underlying,
                oracle: getOracle(),
                irm: getIRM(),
                lltv: getLLTV()
            }),
            _balance,
            address(this),
            "" // No callback data needed
        );
    }

    function _borrowWrap(uint256 amountUnderlying) internal {
        return;
        // if (amountUnderlying == 0) {
        //     return;
        // }
        // // Borrow, check the balance for this contract's address
        // MErc20Interface(getMToken()).borrow(amountUnderlying);
        // if (underlying() == MLSConstantsLib.WETH) {
        //     IWETH(MLSConstantsLib.WETH).deposit{value: address(this).balance}();
        // }
    }

    function _withdrawCollateralWrap(uint256 amountUnderlying) internal {
        return;
        // if (amountUnderlying == 0) {
        //     return;
        // }
        // MErc20Interface(getMToken()).redeemUnderlying(amountUnderlying);
        // if (underlying() == MLSConstantsLib.WETH) {
        //     IWETH(MLSConstantsLib.WETH).deposit{value: address(this).balance}();
        // }
    }

    function _repayAmountWrap(uint256 amountUnderlying) internal {
        return;
        // if (amountUnderlying == 0) {
        //     return;
        // }
        // address _underlying = underlying();
        // address _mToken = getMToken();
        // IERC20(_underlying).safeApprove(_mToken, 0);
        // IERC20(_underlying).safeApprove(_mToken, amountUnderlying);
        // MErc20Interface(_mToken).repayBorrow(amountUnderlying);
    }
}
