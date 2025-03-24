// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MarketParams} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "@morpho-org/morpho-blue/src/libraries/MarketParamsLib.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/upgradability/BaseUpgradeableStrategy.sol";
import "../../base/interface/moonwell/MTokenInterfaces.sol";

import {MLSConstantsLib} from "./libraries/MLSConstantsLib.sol";
import {ErrorsLib} from "./libraries/ErrorsLib.sol";
import {MorphoBlueSnippets} from "./libraries/MorphoBlueLib.sol";
import {StrategyOps} from "./utils/StrategyOps.sol";
import {StateSetter} from "./utils/StateSetter.sol";
import {DepositActions} from "./utils/AssetOps.sol";

contract MorphoLoopingStrategy is StrategyOps, StateSetter, DepositActions {
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;

    bool internal makingFlashDeposit;
    bool internal makingFlashWithdrawal;

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

        if (MLSConstantsLib.LOOP_MODE_SLOT != bytes32(uint256(keccak256("eip1967.strategyStorage.loopMode")) - 1)) {
            revert ErrorsLib.LOOP_MODE_SLOT_NOT_CORRECT();
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
        bool _loopMode
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
        setBoolean(MLSConstantsLib.LOOP_MODE_SLOT, _loopMode);
        address[] memory markets = new address[](1);
        markets[0] = _mToken;
        ComptrollerInterface(_comptroller).enterMarkets(markets);
    }

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

    /**
     * Withdraws all assets, liquidates XVS, and invests again in the required ratio.
     */
    function doHardWork() public restricted {
        // TODO: remove this once we have a proper reward claiming mechanism
        ComptrollerInterface(rewardPool()).claimReward();
        _liquidateRewards(sell(), rewardToken(), universalLiquidator(), underlying());
        _investAllUnderlying();
    }

    /**
     * The strategy invests by supplying the underlying as a collateral.
     */
    function _investAllUnderlying() internal onlyNotPausedInvesting {
        address _underlying = underlying();
        uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));
        if (underlyingBalance > 0) _supplyCollateralWrap(underlyingBalance);
        if (!getLoopMode()) return;
        _depositWithFlashloan();
    }

    /**
     * Salvages a token.
     */
    function salvage(address recipient, address token, uint256 amount) public onlyGovernance {
        // To make sure that governance cannot come in and take away the coins
        require(!unsalvagableTokens(token), "token is defined as not salvagable");
        IERC20(token).safeTransfer(recipient, amount);
    }

    /**
     * @notice Returns the current balance.
     * @dev underlying in this strategy + collateral in Morpho - borrow in Morpho
     * @return balance The current balance.
     */
    function investedUnderlyingBalance() public view returns (uint256 balance) {
        MarketParams memory marketParams = getMarketParams();
        return IERC20(underlying()).balanceOf(address(this))
            + MorphoBlueSnippets.collateralAssetsUser(marketParams.id(), address(this))
            - MorphoBlueSnippets.borrowAssetsUser(marketParams, address(this));
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

    function finalizeUpgrade() external onlyGovernance {
        _finalizeUpgrade();
    }
}
