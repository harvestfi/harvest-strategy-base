// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MarketParams} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "@morpho-org/morpho-blue/src/libraries/MarketParamsLib.sol";
import {BaseUpgradeableStrategyStorage} from "../../../base/upgradability/BaseUpgradeableStrategyStorage.sol";
import {StateAccessor} from "./StateAccessor.sol";
import {MLSConstantsLib} from "../libraries/MLSConstantsLib.sol";
import {MorphoBlueSnippets} from "../libraries/MorphoBlueLib.sol";

// abstract contract WithdrawActions is BaseUpgradeableStrategyStorage, StateAccessor {
//     /**
//      * Redeems `amountUnderlying` or fails.
//      */
//     function _redeemPartial(uint256 amountUnderlying) internal {
//         address _underlying = underlying();
//         uint256 balanceBefore = IERC20(_underlying).balanceOf(address(this));
//         _redeemWithFlashloan(amountUnderlying, getLoopMode() ? getBorrowTargetFactorNumerator() : 0);
//         uint256 balanceAfter = IERC20(_underlying).balanceOf(address(this));
//         require(balanceAfter - balanceBefore >= amountUnderlying, "Unable to withdraw the entire amountUnderlying");
//     }

//     function _redeemWithFlashloan(uint256 amount, uint256 borrowTargetFactorNumerator) internal {
//         address _mToken = getMToken();
//         // amount we supplied
//         uint256 supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
//         // amount we borrowed
//         uint256 borrowed = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
//         uint256 newBorrowTarget;
//         {
//             uint256 oldBalance = supplied - borrowed;
//             uint256 newBalance = oldBalance - amount;
//             newBorrowTarget =
//                 newBalance * borrowTargetFactorNumerator / (getFactorDenominator() - borrowTargetFactorNumerator);
//         }
//         uint256 borrowDiff;
//         if (borrowed < newBorrowTarget) {
//             borrowDiff = 0;
//         } else {
//             borrowDiff = borrowed - newBorrowTarget;
//         }
//         address _underlying = underlying();
//         uint256 balancerBalance = IERC20(_underlying).balanceOf(MLSConstantsLib.BVAULT);

//         if (borrowDiff > balancerBalance) {
//             _redeemNoFlash(amount, supplied, borrowed, _mToken, getFactorDenominator(), borrowTargetFactorNumerator);
//         } else {
//             address[] memory tokens = new address[](1);
//             uint256[] memory amounts = new uint256[](1);
//             bytes memory userData = abi.encode(0);
//             tokens[0] = _underlying;
//             amounts[0] = borrowDiff;
//             makingFlashWithdrawal = true;
//             IBVault(MLSConstantsLib.BVAULT).flashLoan(address(this), tokens, amounts, userData);
//             makingFlashWithdrawal = false;
//             if (amount > 0) MorphoBlueSnippets.withdrawAmount(getMarketParams(), amount);
//         }
//     }

//     function _redeemNoFlash(
//         uint256 amount,
//         uint256 supplied,
//         uint256 borrowed,
//         address _mToken,
//         uint256 _denom,
//         uint256 _borrowNum
//     ) internal {
//         address _underlying = underlying();
//         uint256 newBorrowTarget;
//         {
//             uint256 oldBalance = supplied - borrowed;
//             uint256 newBalance = oldBalance - amount;
//             newBorrowTarget = newBalance * _borrowNum / (_denom - _borrowNum);
//         }
//         while (borrowed > newBorrowTarget) {
//             uint256 requiredCollateral = borrowed * _denom / getCollateralFactorNumerator();
//             uint256 toRepay = borrowed - newBorrowTarget;
//             // redeem just as much as needed to repay the loan
//             // supplied - requiredCollateral = max redeemable, amount + repay = needed
//             uint256 toRedeem = Math.min(supplied - requiredCollateral, amount + toRepay);
//             if (toRedeem > 0) MorphoBlueSnippets.withdrawAmount(getMarketParams(), toRedeem);
//             // now we can repay our borrowed amount
//             uint256 _underlyingBalance = IERC20(_underlying).balanceOf(address(this));
//             uint256 repayAmount = Math.min(toRepay, _underlyingBalance);
//             MorphoBlueSnippets.repayAmount(getMarketParams(), repayAmount);
//             // update the parameters
//             borrowed = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
//             supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
//         }
//         uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));
//         if (underlyingBalance < amount) {
//             uint256 toRedeem = amount - underlyingBalance;
//             uint256 balance = supplied - borrowed;
//             uint256 redeemAmount = Math.min(toRedeem, balance);
//             // redeem the most we can redeem
//             if (redeemAmount > 0) MorphoBlueSnippets.withdrawAmount(getMarketParams(), redeemAmount);
//         }
//     }
// }

abstract contract DepositActions is BaseUpgradeableStrategyStorage, StateAccessor {
    using MarketParamsLib for MarketParams;

    function _depositWithFlashloan() internal {
        // retrieve parameters
        uint256 _denominator = getFactorDenominator();
        uint256 _borrowNumerator = getBorrowTargetFactorNumerator();
        MarketParams memory marketParams = getMarketParams();
        // retrieve market information
        uint256 supplied = MorphoBlueSnippets.collateralAssetsUser(marketParams.id(), address(this));
        uint256 borrowed = MorphoBlueSnippets.borrowAssetsUser(marketParams, address(this));
        uint256 borrowTarget = (supplied - borrowed) * _borrowNumerator / (_denominator - _borrowNumerator);
        uint256 borrowDiff;
        if (borrowed > borrowTarget) {
            _redeemPartial(0);
        } else {
            borrowDiff = borrowTarget - borrowed;
            // retrieve market information
            uint256 totalSupply = MorphoBlueSnippets.marketTotalSupply(marketParams);
            uint256 totalBorrows = MorphoBlueSnippets.marketTotalBorrow(marketParams);
            uint256 availableBorrowAmt = totalSupply - totalBorrows - 1;
            if (borrowDiff > availableBorrowAmt) borrowDiff = availableBorrowAmt;
        }

        uint256 balancerBalance = IERC20(underlying()).balanceOf(MLSConstantsLib.BVAULT);
        bool makingFlashDeposit;

        if (borrowDiff > balancerBalance) {
            _depositNoFlash(supplied, borrowed, marketParams, _denominator, _borrowNumerator);
        } else {
            address[] memory tokens = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            bytes memory userData = abi.encode(0);
            tokens[0] = underlying();
            amounts[0] = borrowDiff;
            makingFlashDeposit = true;
            IBVault(MLSConstantsLib.BVAULT).flashLoan(address(this), tokens, amounts, userData);
            makingFlashDeposit = false;
        }
    }

    function _depositNoFlash(
        uint256 supplied,
        uint256 borrowed,
        MarketParams memory _marketParams,
        uint256 _denom,
        uint256 _borrowNum
    ) internal {
        address _underlying = underlying();
        uint256 balance = supplied - borrowed;
        uint256 borrowTarget = balance * _borrowNum / (_denom - _borrowNum);
        {
            address _rewardPool = rewardPool();
            // retrieve market information
            uint256 totalSupply = MorphoBlueSnippets.marketTotalSupply(_marketParams);
            uint256 totalBorrows = MorphoBlueSnippets.marketTotalBorrow(_marketParams);
            uint256 availableBorrowAmt = totalSupply - totalBorrows - 1;
            if (borrowTarget - borrowed > availableBorrowAmt) borrowTarget = borrowed + availableBorrowAmt;
        }
        while (borrowed < borrowTarget) {
            uint256 wantBorrow = borrowTarget - borrowed;
            uint256 maxBorrow = supplied * getCollateralFactorNumerator() / _denom - borrowed;
            uint256 borrowAmount = Math.min(wantBorrow, maxBorrow);
            MorphoBlueSnippets.borrow(getMarketParams(), borrowAmount);
            uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));
            if (underlyingBalance > 0) _supplyCollateralWrap(underlyingBalance);
            // retrieve market information
            borrowed = MorphoBlueSnippets.borrowAssetsUser(_marketParams, address(this));
            balance = supplied - borrowed;
        }
    }
}
