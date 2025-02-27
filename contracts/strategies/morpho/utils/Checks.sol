// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import {StateAccessor} from "./StateAccessor.sol";

abstract contract Checks is StateAccessor {
    function unsalvagableTokens(address token) public view returns (bool) {
        return (
            token == rewardToken() || token == underlying()
                || token == getMToken()
        );
    }

    function depositArbCheck() public pure returns (bool) {
        // there's no arb here.
        return true;
    }
}