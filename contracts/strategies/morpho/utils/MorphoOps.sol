// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MarketParams} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";

import {BaseUpgradeableStrategyStorage} from "../../../base/upgradability/BaseUpgradeableStrategyStorage.sol";
import {MLSConstantsLib} from "../libraries/MLSConstantsLib.sol";
import {MorphoBlueSnippets} from "../libraries/MorphoBlueLib.sol";
import {StateAccessor} from "./StateAccessor.sol";

abstract contract MorphoOps is BaseUpgradeableStrategyStorage, StateAccessor {
    using SafeERC20 for IERC20;

    function _supplyCollateralWrap(uint256 amount) internal {
        if (amount == 0) return;

        address _underlying = underlying();
        uint256 _balance = IERC20(_underlying).balanceOf(address(this));

        // TODO: Might be able to remove this check
        if (amount < _balance) _balance = amount;

        // Approve and supply collateral
        IERC20(_underlying).safeIncreaseAllowance(MLSConstantsLib.MORPHO_BLUE, _balance);

        MorphoBlueSnippets.supplyCollateral(
            MarketParams({
                loanToken: getLoanToken(),
                collateralToken: _underlying,
                oracle: getOracle(),
                irm: getIRM(),
                lltv: getLLTV()
            }),
            _balance
        );
    }
}
