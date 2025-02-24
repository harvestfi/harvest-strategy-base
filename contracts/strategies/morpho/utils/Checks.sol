// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

abstract contract Checks {
    function depositArbCheck() public pure returns (bool) {
        // there's no arb here.
        return true;
    }
}
