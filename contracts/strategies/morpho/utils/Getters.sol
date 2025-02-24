// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import {ConstantsLib} from "../libraries/ConstantsLib.sol";

abstract contract Getters {
    function _getAddress(bytes32 slot) internal view returns (address str) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            str := sload(slot)
        }
    }

    function mToken() public view returns (address) {
        return _getAddress(ConstantsLib.MTOKEN_SLOT);
    }
}
