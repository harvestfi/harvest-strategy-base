// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import {MarketParams} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";

import {MLSConstantsLib} from "../libraries/MLSConstantsLib.sol";
import {BaseUpgradeableStrategyStorage} from "../../../base/upgradability/BaseUpgradeableStrategyStorage.sol";

abstract contract StateAccessor is BaseUpgradeableStrategyStorage {
    /* MORPHO */

    function getLoanToken() public view returns (address) {
        return getAddress(MLSConstantsLib.LOAN_TOKEN_SLOT);
    }

    function getOracle() public view returns (address) {
        return getAddress(MLSConstantsLib.ORACLE_SLOT);
    }

    function getIRM() public view returns (address) {
        return getAddress(MLSConstantsLib.IRM_SLOT);
    }

    function getLLTV() public view returns (uint256) {
        return getUint256(MLSConstantsLib.LLTV_SLOT);
    }

    function getMarketParams() public view returns (MarketParams memory) {
        return MarketParams({
            loanToken: getLoanToken(),
            collateralToken: underlying(),
            oracle: getOracle(),
            irm: getIRM(),
            lltv: getLLTV()
        });
    }

    /* MOONWELL */

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
