// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import {MLSConstantsLib} from "../libraries/MLSConstantsLib.sol";
import {BaseUpgradeableStrategyStorage} from "../../../base/upgradability/BaseUpgradeableStrategyStorage.sol";

abstract contract StateAccessor is BaseUpgradeableStrategyStorage {
    function getMToken() public view returns (address) {
        return getAddress(MLSConstantsLib.MTOKEN_SLOT);
    }

    function getCollateralFactorNumerator() public view returns (uint256) {
        return getUint256(MLSConstantsLib.COLLATERALFACTORNUMERATOR_SLOT);
    }

    function getFactorDenominator() public view returns (uint256) {
        return getUint256(MLSConstantsLib.FACTORDENOMINATOR_SLOT);
    }

    function getBorrowTargetFactorNumerator() public view returns (uint256) {
        return getUint256(MLSConstantsLib.BORROWTARGETFACTORNUMERATOR_SLOT);
    }

    function getFoldStatus() public view returns (bool) {
        return getBoolean(MLSConstantsLib.FOLD_SLOT);
    }
}
