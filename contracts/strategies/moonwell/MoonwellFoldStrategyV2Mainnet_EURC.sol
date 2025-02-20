//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./MoonwellFoldStrategyV2.sol";

contract MoonwellFoldStrategyV2Mainnet_EURC is MoonwellFoldStrategyV2 {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42);
        address mToken = address(0xb682c840B5F4FC58B20769E691A6fa1305A501a2);
        address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
        address well = address(0xA88594D404727625A9437C3f886C7643872296AE);
        MoonwellFoldStrategyV2.initializeBaseStrategy(
            _storage, underlying, _vault, mToken, comptroller, well, 0, 830, 1000, false
        );
        rewardTokens = [well];
    }
}
