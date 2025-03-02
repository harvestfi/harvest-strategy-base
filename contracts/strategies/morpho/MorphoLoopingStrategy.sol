// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MarketParams} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/interface/IVault.sol";
import "../../base/upgradability/BaseUpgradeableStrategy.sol";
import "../../base/interface/moonwell/MTokenInterfaces.sol";
import "../../base/interface/moonwell/ComptrollerInterface.sol";
import "../../base/interface/balancer/IBVault.sol";
import "../../base/interface/weth/IWETH.sol";

import {Helpers} from "./utils/Helpers.sol";
import {StateSetter} from "./utils/StateSetter.sol";
import {Checks} from "./utils/Checks.sol";
import {MLSConstantsLib} from "./libraries/MLSConstantsLib.sol";
import {ErrorsLib} from "./libraries/ErrorsLib.sol";
import {MorphoBlueSnippets} from "./libraries/MorphoBlueLib.sol";
import {MorphoOps} from "./utils/MorphoOps.sol";

contract MorphoLoopingStrategy is BaseUpgradeableStrategy, Helpers, MorphoOps, StateSetter {
    using SafeERC20 for IERC20;

    uint256 public suppliedInUnderlying;
    uint256 public borrowedInUnderlying;

    bool internal makingFlashDeposit;
    bool internal makingFlashWithdrawal;

    /// @dev Reset on each upgrade
    address[] public rewardTokens;

    constructor() BaseUpgradeableStrategy() {
        if (MLSConstantsLib.LOAN_TOKEN_SLOT != bytes32(uint256(keccak256("eip1967.strategyStorage.loanToken")) - 1)) {
            revert ErrorsLib.LOAN_TOKEN_SLOT_NOT_CORRECT();
        }

        if (MLSConstantsLib.ORACLE_SLOT != bytes32(uint256(keccak256("eip1967.strategyStorage.oracle")) - 1)) {
            revert ErrorsLib.ORACLE_SLOT_NOT_CORRECT();
        }

        if (MLSConstantsLib.IRM_SLOT != bytes32(uint256(keccak256("eip1967.strategyStorage.irm")) - 1)) {
            revert ErrorsLib.IRM_SLOT_NOT_CORRECT();
        }

        if (MLSConstantsLib.LLTV_SLOT != bytes32(uint256(keccak256("eip1967.strategyStorage.lltv")) - 1)) {
            revert ErrorsLib.LLTV_SLOT_NOT_CORRECT();
        }

        if (MLSConstantsLib.MTOKEN_SLOT != bytes32(uint256(keccak256("eip1967.strategyStorage.mToken")) - 1)) {
            revert ErrorsLib.MTOKEN_SLOT_NOT_CORRECT();
        }

        if (
            MLSConstantsLib.COLLATERALFACTORNUMERATOR_SLOT
                != bytes32(uint256(keccak256("eip1967.strategyStorage.collateralFactorNumerator")) - 1)
        ) {
            revert ErrorsLib.COLLATERALFACTORNUMERATOR_SLOT_NOT_CORRECT();
        }

        if (
            MLSConstantsLib.FACTORDENOMINATOR_SLOT
                != bytes32(uint256(keccak256("eip1967.strategyStorage.factorDenominator")) - 1)
        ) {
            revert ErrorsLib.FACTORDENOMINATOR_SLOT_NOT_CORRECT();
        }

        if (
            MLSConstantsLib.BORROWTARGETFACTORNUMERATOR_SLOT
                != bytes32(uint256(keccak256("eip1967.strategyStorage.borrowTargetFactorNumerator")) - 1)
        ) {
            revert ErrorsLib.BORROWTARGETFACTORNUMERATOR_SLOT_NOT_CORRECT();
        }

        if (MLSConstantsLib.FOLD_SLOT != bytes32(uint256(keccak256("eip1967.strategyStorage.fold")) - 1)) {
            revert ErrorsLib.FOLD_SLOT_NOT_CORRECT();
        }
    }

    /// Checkpoint
    function initializeBaseStrategy(
        address _storage,
        address _underlying,
        address _vault,
        address _mToken,
        address _comptroller,
        address _rewardToken,
        uint256 _borrowTargetFactorNumerator,
        uint256 _collateralFactorNumerator,
        uint256 _factorDenominator,
        bool _fold
    ) public initializer {
        BaseUpgradeableStrategy.initialize(
            _storage, _underlying, _vault, _comptroller, _rewardToken, MLSConstantsLib.HARVEST_MSIG
        );

        require(MErc20Interface(_mToken).underlying() == _underlying, "Underlying mismatch");

        _setMToken(_mToken);

        require(_collateralFactorNumerator < _factorDenominator, "Numerator should be smaller than denominator");
        require(_borrowTargetFactorNumerator < _collateralFactorNumerator, "Target should be lower than limit");
        _setFactorDenominator(_factorDenominator);
        setUint256(MLSConstantsLib.COLLATERALFACTORNUMERATOR_SLOT, _collateralFactorNumerator);
        setUint256(MLSConstantsLib.BORROWTARGETFACTORNUMERATOR_SLOT, _borrowTargetFactorNumerator);
        setBoolean(MLSConstantsLib.FOLD_SLOT, _fold);
        address[] memory markets = new address[](1);
        markets[0] = _mToken;
        ComptrollerInterface(_comptroller).enterMarkets(markets);
    }

    modifier updateSupplyInTheEnd() {
        _;
        address _mToken = getMToken();
        // amount we supplied
        suppliedInUnderlying = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
        // amount we borrowed
        borrowedInUnderlying = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
    }

    /**
     * Exits Moonwell and transfers everything to the vault.
     */
    function withdrawAllToVault() public restricted updateSupplyInTheEnd {
        address _underlying = underlying();
        _claimRewards();
        _liquidateRewards();
        _withdrawMaximum();
        if (IERC20(_underlying).balanceOf(address(this)) > 0) {
            IERC20(_underlying).safeTransfer(vault(), IERC20(_underlying).balanceOf(address(this)));
        }
    }

    function emergencyExit() external onlyGovernance updateSupplyInTheEnd {
        _withdrawMaximum();
    }

    /**
     * Redeems maximum that can be redeemed from Venus.
     * Redeem the minimum of the underlying we own, and the underlying that the vToken can
     * immediately retrieve. Ensures that `redeemMaximum` doesn't fail silently.
     *
     * DOES NOT ensure that the strategy vUnderlying balance becomes 0.
     */
    function _withdrawMaximum() internal updateSupplyInTheEnd {
        address _mToken = getMToken();
        // amount of liquidity in Radiant
        uint256 available = MTokenInterface(_mToken).getCash();
        // amount we supplied
        uint256 supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
        // amount we borrowed
        uint256 borrowed = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
        uint256 balance = supplied - borrowed;

        _redeemWithFlashloan(Math.min(available, balance), 0);
        supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
        if (supplied > 0) MorphoBlueSnippets.withdrawAmount(getMarketParams(), supplied);
    }

    function withdrawToVault(uint256 amountUnderlying) public restricted updateSupplyInTheEnd {
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
     * Withdraws all assets, liquidates XVS, and invests again in the required ratio.
     */
    function doHardWork() public restricted {
        _claimRewards();
        _liquidateRewards();
        _investAllUnderlying();
    }

    function _claimRewards() internal {
        ComptrollerInterface(rewardPool()).claimReward();
    }

    function _liquidateRewards() internal {
        if (!sell()) {
            // Profits can be disabled for possible simplified and rapid exit
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
            if (token != _rewardToken) {
                IERC20(token).safeIncreaseAllowance(_universalLiquidator, balance);
                IUniversalLiquidator(_universalLiquidator).swap(token, _rewardToken, balance, 1, address(this));
            }
        }
        uint256 rewardBalance = IERC20(_rewardToken).balanceOf(address(this));

        if (rewardBalance < 1e8) {
            return;
        }

        _notifyProfitInRewardToken(_rewardToken, rewardBalance);
        uint256 remainingRewardBalance = IERC20(_rewardToken).balanceOf(address(this));

        if (remainingRewardBalance < 1e10) {
            return;
        }

        address _underlying = underlying();
        if (_underlying != _rewardToken) {
            IERC20(_rewardToken).safeIncreaseAllowance(_universalLiquidator, remainingRewardBalance);
            IUniversalLiquidator(_universalLiquidator).swap(
                _rewardToken, _underlying, remainingRewardBalance, 1, address(this)
            );
        }
    }

    /**
     * The strategy invests by supplying the underlying as a collateral.
     */
    function _investAllUnderlying() internal onlyNotPausedInvesting updateSupplyInTheEnd {
        address _underlying = underlying();
        uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));
        if (underlyingBalance > 0) _supplyCollateralWrap(underlyingBalance);
        if (!getFoldStatus()) return;
        _depositWithFlashloan();
    }

    /**
     * Redeems `amountUnderlying` or fails.
     */
    function _redeemPartial(uint256 amountUnderlying) internal {
        address _underlying = underlying();
        uint256 balanceBefore = IERC20(_underlying).balanceOf(address(this));
        _redeemWithFlashloan(amountUnderlying, getFoldStatus() ? getBorrowTargetFactorNumerator() : 0);
        uint256 balanceAfter = IERC20(_underlying).balanceOf(address(this));
        require(balanceAfter - balanceBefore >= amountUnderlying, "Unable to withdraw the entire amountUnderlying");
    }

    /**
     * Salvages a token.
     */
    function salvage(address recipient, address token, uint256 amount) public onlyGovernance {
        // To make sure that governance cannot come in and take away the coins
        require(!unsalvagableTokens(token), "token is defined as not salvagable");
        IERC20(token).safeTransfer(recipient, amount);
    }

    function addRewardToken(address _token) public onlyGovernance {
        rewardTokens.push(_token);
    }

    /**
     * Returns the current balance.
     */
    function investedUnderlyingBalance() public view returns (uint256) {
        // underlying in this strategy + underlying redeemable from Radiant - debt
        return IERC20(underlying()).balanceOf(address(this)) + suppliedInUnderlying - borrowedInUnderlying;
    }

    function receiveFlashLoan(
        IERC20[] memory, /*tokens*/
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory /*userData*/
    ) external {
        require(msg.sender == MLSConstantsLib.BVAULT);
        require(!makingFlashDeposit || !makingFlashWithdrawal, "Only one can be true");
        require(makingFlashDeposit || makingFlashWithdrawal, "One has to be true");
        address _underlying = underlying();
        uint256 toRepay = amounts[0] + feeAmounts[0];
        MarketParams memory marketParams = getMarketParams();
        if (makingFlashDeposit) {
            _supplyCollateralWrap(amounts[0]);
            if (toRepay > 0) MorphoBlueSnippets.borrow(marketParams, toRepay);
        } else {
            address _mToken = getMToken();
            uint256 borrowed = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
            uint256 repaying = Math.min(amounts[0], borrowed);
            IERC20(_underlying).safeIncreaseAllowance(_mToken, repaying);
            if (repaying > 0) MorphoBlueSnippets.repayAmount(marketParams, repaying);
            if (toRepay > 0) MorphoBlueSnippets.withdrawAmount(marketParams, toRepay);
        }
        IERC20(_underlying).safeTransfer(MLSConstantsLib.BVAULT, toRepay);
    }

    function _depositWithFlashloan() internal {
        address _mToken = getMToken();
        uint256 _denom = getFactorDenominator();
        uint256 _borrowNum = getBorrowTargetFactorNumerator();
        // amount we supplied
        uint256 supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
        // amount we borrowed
        uint256 borrowed = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
        uint256 balance = supplied - borrowed;
        uint256 borrowTarget = balance * _borrowNum / (_denom - _borrowNum);
        uint256 borrowDiff;
        if (borrowed > borrowTarget) {
            _redeemPartial(0);
            borrowDiff = 0;
        } else {
            borrowDiff = borrowTarget - borrowed;
            address _rewardPool = rewardPool();
            uint256 supplyCap = ComptrollerInterface(_rewardPool).supplyCaps(_mToken);
            uint256 currentSupplied =
                MTokenInterface(_mToken).totalSupply() * MTokenInterface(_mToken).exchangeRateCurrent() / 1e18;
            uint256 borrowCap = ComptrollerInterface(_rewardPool).borrowCaps(_mToken);
            uint256 totalBorrows = MTokenInterface(_mToken).totalBorrows();
            uint256 borrowAvail;
            if (totalBorrows < borrowCap) {
                borrowAvail = borrowCap - totalBorrows - 1;
                if (currentSupplied < supplyCap) {
                    borrowAvail = Math.min(supplyCap - currentSupplied - 2, borrowAvail);
                } else {
                    borrowAvail = 0;
                }
            } else {
                borrowAvail = 0;
            }
            if (borrowDiff > borrowAvail) {
                borrowDiff = borrowAvail;
            }
        }
        address _underlying = underlying();
        uint256 balancerBalance = IERC20(_underlying).balanceOf(MLSConstantsLib.BVAULT);

        if (borrowDiff > balancerBalance) {
            _depositNoFlash(supplied, borrowed, _mToken, _denom, _borrowNum);
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

    function _redeemWithFlashloan(uint256 amount, uint256 borrowTargetFactorNumerator) internal {
        address _mToken = getMToken();
        // amount we supplied
        uint256 supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
        // amount we borrowed
        uint256 borrowed = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
        uint256 newBorrowTarget;
        {
            uint256 oldBalance = supplied - borrowed;
            uint256 newBalance = oldBalance - amount;
            newBorrowTarget =
                newBalance * borrowTargetFactorNumerator / (getFactorDenominator() - borrowTargetFactorNumerator);
        }
        uint256 borrowDiff;
        if (borrowed < newBorrowTarget) {
            borrowDiff = 0;
        } else {
            borrowDiff = borrowed - newBorrowTarget;
        }
        address _underlying = underlying();
        uint256 balancerBalance = IERC20(_underlying).balanceOf(MLSConstantsLib.BVAULT);

        if (borrowDiff > balancerBalance) {
            _redeemNoFlash(amount, supplied, borrowed, _mToken, getFactorDenominator(), borrowTargetFactorNumerator);
        } else {
            address[] memory tokens = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            bytes memory userData = abi.encode(0);
            tokens[0] = _underlying;
            amounts[0] = borrowDiff;
            makingFlashWithdrawal = true;
            IBVault(MLSConstantsLib.BVAULT).flashLoan(address(this), tokens, amounts, userData);
            makingFlashWithdrawal = false;
            if (amount > 0) MorphoBlueSnippets.withdrawAmount(getMarketParams(), amount);
        }
    }

    function _depositNoFlash(uint256 supplied, uint256 borrowed, address _mToken, uint256 _denom, uint256 _borrowNum)
        internal
    {
        address _underlying = underlying();
        uint256 balance = supplied - borrowed;
        uint256 borrowTarget = balance * _borrowNum / (_denom - _borrowNum);
        {
            address _rewardPool = rewardPool();
            uint256 supplyCap = ComptrollerInterface(_rewardPool).supplyCaps(_mToken);
            uint256 currentSupplied =
                MTokenInterface(_mToken).totalSupply() * MTokenInterface(_mToken).exchangeRateCurrent() / 1e18;
            uint256 borrowCap = ComptrollerInterface(_rewardPool).borrowCaps(_mToken);
            uint256 totalBorrows = MTokenInterface(_mToken).totalBorrows();
            uint256 borrowAvail;
            if (totalBorrows < borrowCap) {
                borrowAvail = borrowCap - totalBorrows - 1;
                if (currentSupplied < supplyCap) {
                    borrowAvail = Math.min(supplyCap - currentSupplied - 2, borrowAvail);
                } else {
                    borrowAvail = 0;
                }
            } else {
                borrowAvail = 0;
            }
            if (borrowTarget - borrowed > borrowAvail) {
                borrowTarget = borrowed + borrowAvail;
            }
        }
        while (borrowed < borrowTarget) {
            uint256 wantBorrow = borrowTarget - borrowed;
            uint256 maxBorrow = supplied * getCollateralFactorNumerator() / _denom - borrowed;
            uint256 borrowAmount = Math.min(wantBorrow, maxBorrow);
            MorphoBlueSnippets.borrow(getMarketParams(), borrowAmount);
            uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));
            if (underlyingBalance > 0) _supplyCollateralWrap(underlyingBalance);
            //update parameters
            borrowed = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
            supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
            balance = supplied - borrowed;
        }
    }

    function _redeemNoFlash(
        uint256 amount,
        uint256 supplied,
        uint256 borrowed,
        address _mToken,
        uint256 _denom,
        uint256 _borrowNum
    ) internal {
        address _underlying = underlying();
        uint256 newBorrowTarget;
        {
            uint256 oldBalance = supplied - borrowed;
            uint256 newBalance = oldBalance - amount;
            newBorrowTarget = newBalance * _borrowNum / (_denom - _borrowNum);
        }
        while (borrowed > newBorrowTarget) {
            uint256 requiredCollateral = borrowed * _denom / getCollateralFactorNumerator();
            uint256 toRepay = borrowed - newBorrowTarget;
            // redeem just as much as needed to repay the loan
            // supplied - requiredCollateral = max redeemable, amount + repay = needed
            uint256 toRedeem = Math.min(supplied - requiredCollateral, amount + toRepay);
            if (toRedeem > 0) MorphoBlueSnippets.withdrawAmount(getMarketParams(), toRedeem);
            // now we can repay our borrowed amount
            uint256 _underlyingBalance = IERC20(_underlying).balanceOf(address(this));
            uint256 repayAmount = Math.min(toRepay, _underlyingBalance);
            MorphoBlueSnippets.repayAmount(getMarketParams(), repayAmount);
            // update the parameters
            borrowed = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
            supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
        }
        uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));
        if (underlyingBalance < amount) {
            uint256 toRedeem = amount - underlyingBalance;
            uint256 balance = supplied - borrowed;
            uint256 redeemAmount = Math.min(toRedeem, balance);
            // redeem the most we can redeem
            if (redeemAmount > 0) MorphoBlueSnippets.withdrawAmount(getMarketParams(), redeemAmount);
        }
    }

    function finalizeUpgrade() external onlyGovernance updateSupplyInTheEnd {
        _finalizeUpgrade();
    }
}
