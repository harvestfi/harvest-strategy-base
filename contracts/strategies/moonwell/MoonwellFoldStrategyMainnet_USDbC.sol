//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./MoonwellFoldStrategy.sol";

contract MoonwellFoldStrategyMainnet_USDbC is MoonwellFoldStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA);
        address mToken = address(0x703843C3379b52F9FF486c9f5892218d2a065cC8);
        address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
        address well = address(0xFF8adeC2221f9f4D8dfbAFa6B9a297d17603493D);
        MoonwellFoldStrategy.initializeBaseStrategy(
            _storage, underlying, _vault, mToken, comptroller, well, 780, 800, 1000, true
        );
    }
}
