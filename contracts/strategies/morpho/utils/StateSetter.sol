// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import {ControllableInit} from "../../../base/inheritance/ControllableInit.sol";
import {MLSConstantsLib} from "../libraries/MLSConstantsLib.sol";
import {Checks} from "./Checks.sol";

abstract contract StateSetter is ControllableInit, Checks {
    function _setMToken(address _target) internal {
        setAddress(MLSConstantsLib.MTOKEN_SLOT, _target);
    }

    function _setFactorDenominator(uint256 _denominator) internal {
        setUint256(MLSConstantsLib.FACTORDENOMINATOR_SLOT, _denominator);
    }

    // updating collateral factor
    // note 1: one should settle the loan first before calling this
    // note 2: collateralFactorDenominator is 1000, therefore, for 20%, you need 200
    function setCollateralFactorNumerator(uint256 _numerator) public onlyGovernance {
        require(_numerator <= getFactorDenominator(), "Collateral factor cannot be this high");
        require(
            _numerator > getBorrowTargetFactorNumerator(),
            "Collateral factor should be higher than borrow target"
        );
        setUint256(MLSConstantsLib.COLLATERALFACTORNUMERATOR_SLOT, _numerator);
    }

    function setFold(bool _fold) public onlyGovernance {
        setBoolean(MLSConstantsLib.FOLD_SLOT, _fold);
    }

    function setBorrowTargetFactorNumerator(uint256 _numerator) public onlyGovernance {
        require(_numerator < getCollateralFactorNumerator(), "Target should be lower than collateral limit");
        setUint256(MLSConstantsLib.BORROWTARGETFACTORNUMERATOR_SLOT, _numerator);
    }
}
