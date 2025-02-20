//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./MoonwellFoldStrategy.sol";

contract MoonwellFoldStrategyMainnet_WETH is MoonwellFoldStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x4200000000000000000000000000000000000006);
        address mToken = address(0x628ff693426583D9a7FB391E54366292F509D457);
        address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
        address well = address(0xFF8adeC2221f9f4D8dfbAFa6B9a297d17603493D);
        MoonwellFoldStrategy.initializeBaseStrategy(
            _storage, underlying, _vault, mToken, comptroller, well, 730, 750, 1000, true
        );
    }
}
