// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import {ConstantsLib} from "../libraries/ConstantsLib.sol";
import {BaseUpgradeableStrategyStorage} from "../../../base/upgradability/BaseUpgradeableStrategyStorage.sol";

abstract contract Setters {
    function _setAddress(bytes32 slot, address _address) internal {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            sstore(slot, _address)
        }
    }

    function _setMToken(address _target) internal {
        _setAddress(ConstantsLib.MTOKEN_SLOT, _target);
    }
}
