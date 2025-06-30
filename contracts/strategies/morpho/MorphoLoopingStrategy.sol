// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MarketParams} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "@morpho-org/morpho-blue/src/libraries/MarketParamsLib.sol";
import "../../base/upgradability/BaseUpgradeableStrategy.sol";
import {IRewardPrePay} from "../../base/interface/IRewardPrePay.sol";
import "../../base/interface/moonwell/MTokenInterfaces.sol";

import {MLSConstantsLib} from "./libraries/MLSConstantsLib.sol";
import {ErrorsLib} from "./libraries/ErrorsLib.sol";
import {MorphoBlueSnippets} from "./libraries/MorphoBlueLib.sol";
import {WithdrawActions} from "./utils/AssetOps.sol";
import {StateSetter} from "./utils/StateSetter.sol";

contract MorphoLoopingStrategy is WithdrawActions, StateSetter {
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

        if (MLSConstantsLib.LOOP_MODE_SLOT != bytes32(uint256(keccak256("eip1967.strategyStorage.loopMode")) - 1)) {
            revert ErrorsLib.LOOP_MODE_SLOT_NOT_CORRECT();
        }

        if (
            MLSConstantsLib.MORPHO_PRE_PAY_SLOT
                != bytes32(uint256(keccak256("eip1967.strategyStorage.morphoPrePay")) - 1)
        ) {
            revert ErrorsLib.MORPHO_PRE_PAY_SLOT_NOT_CORRECT();
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
    }

    /// Checkpoint
    function initializeBaseStrategy(
        address _storage,
        address _underlying,
        address _vault,
        address _morphoVault,
        address _rewardToken,
        address _morphoPrePay,
        uint256 _borrowTargetFactorNumerator,
        uint256 _collateralFactorNumerator,
        uint256 _factorDenominator,
        bool _loopMode,
        address _mToken
    ) public initializer {
        BaseUpgradeableStrategy.initialize(
            _storage, _underlying, _vault, _morphoVault, _rewardToken, MLSConstantsLib.HARVEST_MSIG
        );

        require(_collateralFactorNumerator < _factorDenominator, "Numerator should be smaller than denominator");
        require(_borrowTargetFactorNumerator < _collateralFactorNumerator, "Target should be lower than limit");
        _setMorphoPrePay(_morphoPrePay);
        _setFactorDenominator(_factorDenominator);
        setUint256(MLSConstantsLib.COLLATERALFACTORNUMERATOR_SLOT, _collateralFactorNumerator);
        setUint256(MLSConstantsLib.BORROWTARGETFACTORNUMERATOR_SLOT, _borrowTargetFactorNumerator);
        setBoolean(MLSConstantsLib.LOOP_MODE_SLOT, _loopMode);

        require(MErc20Interface(_mToken).underlying() == _underlying, "Underlying mismatch");
        _setMToken(_mToken);
    }

    /**
     * Withdraws all assets, liquidates XVS, and invests again in the required ratio.
     */
    function doHardWork() public restricted {
        // TODO: Do we supply to Morpho? And do we collect fee here?
        IRewardPrePay(getMorphoPrePay()).claim();
        _liquidateRewards(sell(), rewardToken(), universalLiquidator(), underlying());
        _investAllUnderlying();
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

    function finalizeUpgrade() external onlyGovernance {
        _finalizeUpgrade();
    }
}
