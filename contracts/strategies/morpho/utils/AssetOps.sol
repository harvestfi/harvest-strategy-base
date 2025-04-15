// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MarketParams} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "@morpho-org/morpho-blue/src/libraries/MarketParamsLib.sol";
import {BaseUpgradeableStrategyStorage} from "../../../base/upgradability/BaseUpgradeableStrategyStorage.sol";
import {IBVault} from "../../../base/interface/balancer/IBVault.sol";
import {MorphoOps} from "./MorphoOps.sol";
import {StateAccessor} from "./StateAccessor.sol";
import {MLSConstantsLib} from "../libraries/MLSConstantsLib.sol";
import {MorphoBlueSnippets} from "../libraries/MorphoBlueLib.sol";
import {ErrorsLib} from "../libraries/ErrorsLib.sol";
import {IMorphoLoopingStrategy} from "../interfaces/IMorphoLoopingStrategy.sol";

abstract contract FlashLoanActions is BaseUpgradeableStrategyStorage, MorphoOps {
    using SafeERC20 for IERC20;

    bool internal makingFlashLoan;
    IMorphoLoopingStrategy.FlashLoanType internal flashLoanType;

    function _flashLoan(uint256 amount) internal {
        if (makingFlashLoan) revert ErrorsLib.FLASH_LOAN_ALREADY_IN_PROGRESS();
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        bytes memory userData = abi.encode(0);

        tokens[0] = underlying();
        amounts[0] = amount;
        makingFlashLoan = true;
        IBVault(MLSConstantsLib.BVAULT).flashLoan(address(this), tokens, amounts, userData);
        makingFlashLoan = false;
        flashLoanType = IMorphoLoopingStrategy.FlashLoanType.None;
    }

    function receiveFlashLoan(
        IERC20[] memory, /*tokens*/
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory /*userData*/
    ) external {
        if (msg.sender != MLSConstantsLib.BVAULT) revert ErrorsLib.INVALID_FLASH_LOAN_CALLER();
        if (!makingFlashLoan) revert ErrorsLib.FLASH_LOAN_NOT_IN_PROGRESS();
        address _underlying = underlying();
        uint256 toRepay = amounts[0] + feeAmounts[0];
        MarketParams memory marketParams = getMarketParams();
        if (flashLoanType == IMorphoLoopingStrategy.FlashLoanType.Deposit) {
            _supplyCollateralWrap(amounts[0]);
            if (toRepay > 0) MorphoBlueSnippets.borrow(marketParams, toRepay);
        } else {
            address _mToken = getMToken();
            uint256 borrowed = MorphoBlueSnippets.borrowAssetsUser(marketParams, address(this));
            uint256 repaying = Math.min(amounts[0], borrowed);
            IERC20(_underlying).safeIncreaseAllowance(_mToken, repaying);
            if (repaying > 0) MorphoBlueSnippets.repayAmount(marketParams, repaying);
            if (toRepay > 0) MorphoBlueSnippets.withdrawAmount(marketParams, toRepay);
        }
        IERC20(_underlying).safeTransfer(MLSConstantsLib.BVAULT, toRepay);
    }
}

abstract contract RedeemActions is BaseUpgradeableStrategyStorage, FlashLoanActions {
    using MarketParamsLib for MarketParams;

    function _redeemPartial(uint256 amountUnderlying) internal {
        address _underlying = underlying();
        uint256 balanceBefore = IERC20(_underlying).balanceOf(address(this));
        _redeemWithFlashloan(amountUnderlying, getLoopMode() ? getBorrowTargetFactorNumerator() : 0);
        uint256 balanceAfter = IERC20(_underlying).balanceOf(address(this));
        require(balanceAfter - balanceBefore >= amountUnderlying, "Unable to withdraw the entire amountUnderlying");
    }

    function _redeemWithFlashloan(uint256 amount, uint256 borrowTargetFactorNumerator) internal {
        // retrieve parameters
        uint256 denominator = getFactorDenominator();
        MarketParams memory marketParams = getMarketParams();
        // retrieve market information
        uint256 supplied = MorphoBlueSnippets.collateralAssetsUser(marketParams.id(), address(this));
        uint256 borrowed = MorphoBlueSnippets.borrowAssetsUser(marketParams, address(this));
        uint256 newBorrowTarget =
            (supplied - borrowed - amount) * borrowTargetFactorNumerator / (denominator - borrowTargetFactorNumerator);
        uint256 borrowDiff = borrowed < newBorrowTarget ? 0 : borrowed - newBorrowTarget;

        address _underlying = underlying();
        uint256 balancerBalance = IERC20(_underlying).balanceOf(MLSConstantsLib.BVAULT);

        if (borrowDiff > balancerBalance) {
            _redeemNoFlash(amount, supplied, borrowed, marketParams, denominator, borrowTargetFactorNumerator);
        } else {
            flashLoanType = IMorphoLoopingStrategy.FlashLoanType.Withdraw;
            _flashLoan(amount);
            if (amount > 0) MorphoBlueSnippets.withdrawAmount(getMarketParams(), amount);
        }
    }

    function _redeemNoFlash(
        uint256 amount,
        uint256 supplied,
        uint256 borrowed,
        MarketParams memory marketParams,
        uint256 denominator,
        uint256 borrowTargetFactorNumerator
    ) internal {
        address _underlying = underlying();
        uint256 newBorrowTarget =
            (supplied - borrowed - amount) * borrowTargetFactorNumerator / (denominator - borrowTargetFactorNumerator);

        while (borrowed > newBorrowTarget) {
            uint256 requiredCollateral = borrowed * denominator / getCollateralFactorNumerator();
            uint256 toRepay = borrowed - newBorrowTarget;
            // redeem just as much as needed to repay the loan
            // supplied - requiredCollateral = max redeemable, amount + repay = needed
            uint256 toRedeem = Math.min(supplied - requiredCollateral, amount + toRepay);
            if (toRedeem > 0) MorphoBlueSnippets.withdrawAmount(marketParams, toRedeem);
            // now we can repay our borrowed amount
            uint256 _underlyingBalance = IERC20(_underlying).balanceOf(address(this));
            uint256 repayAmount = Math.min(toRepay, _underlyingBalance);
            MorphoBlueSnippets.repayAmount(marketParams, repayAmount);
            // update the parameters
            borrowed = MorphoBlueSnippets.borrowAssetsUser(marketParams, address(this));
            supplied = MorphoBlueSnippets.collateralAssetsUser(marketParams.id(), address(this));
        }
        uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));
        if (underlyingBalance < amount) {
            uint256 toRedeem = amount - underlyingBalance;
            uint256 balance = supplied - borrowed;
            uint256 redeemAmount = Math.min(toRedeem, balance);
            // redeem the most we can redeem
            if (redeemAmount > 0) MorphoBlueSnippets.withdrawAmount(marketParams, redeemAmount);
        }
    }
}

abstract contract WithdrawActions is BaseUpgradeableStrategyStorage, RedeemActions {
    /**
     * Exits Moonwell and transfers everything to the vault.
     */
    function withdrawAllToVault() public restricted {
        address _underlying = underlying();
        ComptrollerInterface(rewardPool()).claimReward();
        _liquidateRewards(sell(), rewardToken(), universalLiquidator(), _underlying);
        _withdrawMaximum();
        if (IERC20(_underlying).balanceOf(address(this)) > 0) {
            IERC20(_underlying).safeTransfer(vault(), IERC20(_underlying).balanceOf(address(this)));
        }
    }

    function emergencyExit() external onlyGovernance {
        _withdrawMaximum();
    }

    function withdrawToVault(uint256 amountUnderlying) public restricted {
        address _underlying = underlying();
        uint256 balance = IERC20(_underlying).balanceOf(address(this));
        if (amountUnderlying <= balance) {
            IERC20(_underlying).safeTransfer(vault(), amountUnderlying);
            return;
        }
        uint256 toRedeem = amountUnderlying - balance;
        // get some of the underlying
        _redeemPartial(toRedeem);
        // transfer the amount requested (or the amount we have) back to vault()
        IERC20(_underlying).safeTransfer(vault(), amountUnderlying);
        balance = IERC20(_underlying).balanceOf(address(this));
        if (balance > 0) {
            _investAllUnderlying();
        }
    }

    /**
     * Redeems maximum that can be redeemed from Venus.
     * Redeem the minimum of the underlying we own, and the underlying that the vToken can
     * immediately retrieve. Ensures that `redeemMaximum` doesn't fail silently.
     *
     * DOES NOT ensure that the strategy vUnderlying balance becomes 0.
     */
    function _withdrawMaximum() internal {
        address _mToken = getMToken();
        // amount of liquidity in Radiant
        uint256 available = MTokenInterface(_mToken).getCash();
        // amount we supplied
        uint256 supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
        // amount we borrowed
        uint256 borrowed = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
        uint256 balance = supplied - borrowed;

        _redeemWithFlashloan(Math.min(available, balance), 0);
        //_redeemWithFlashloan(amountUnderlying, getLoopMode() ? getBorrowTargetFactorNumerator() : 0);
        supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
        if (supplied > 0) MorphoBlueSnippets.withdrawAmount(getMarketParams(), supplied);
    }
}

abstract contract DepositActions is BaseUpgradeableStrategyStorage, RedeemActions {
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

        if (borrowDiff > balancerBalance) {
            _depositNoFlash(supplied, borrowed, marketParams, _denominator, _borrowNumerator);
        } else {
            flashLoanType = IMorphoLoopingStrategy.FlashLoanType.Deposit;
            _flashLoan(borrowDiff);
        }
    }

    function _depositNoFlash(
        uint256 supplied,
        uint256 borrowed,
        MarketParams memory marketParams,
        uint256 denominator,
        uint256 borrowTargetFactorNumerator
    ) internal {
        uint256 balance = supplied - borrowed;
        uint256 borrowTarget = balance * borrowTargetFactorNumerator / (denominator - borrowTargetFactorNumerator);
        // retrieve market information
        uint256 totalSupply = MorphoBlueSnippets.marketTotalSupply(marketParams);
        uint256 totalBorrows = MorphoBlueSnippets.marketTotalBorrow(marketParams);
        uint256 availableBorrowAmt = totalSupply - totalBorrows - 1;
        if (borrowTarget - borrowed > availableBorrowAmt) borrowTarget = borrowed + availableBorrowAmt;

        while (borrowed < borrowTarget) {
            uint256 wantBorrow = borrowTarget - borrowed;
            uint256 maxBorrow = supplied * getCollateralFactorNumerator() / denominator - borrowed;
            uint256 borrowAmount = Math.min(wantBorrow, maxBorrow);
            MorphoBlueSnippets.borrow(marketParams, borrowAmount);
            uint256 underlyingBalance = IERC20(underlying()).balanceOf(address(this));
            if (underlyingBalance > 0) _supplyCollateralWrap(underlyingBalance);
            // retrieve market information
            borrowed = MorphoBlueSnippets.borrowAssetsUser(marketParams, address(this));
            balance = supplied - borrowed;
        }
    }
}
