//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./MoonwellFoldStrategy.sol";

contract MoonwellFoldStrategyMainnet_DAI is MoonwellFoldStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb);
        address mToken = address(0x73b06D8d18De422E269645eaCe15400DE7462417);
        address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
        address well = address(0xFF8adeC2221f9f4D8dfbAFa6B9a297d17603493D);
        MoonwellFoldStrategy.initializeBaseStrategy(
            _storage, underlying, _vault, mToken, comptroller, well, 780, 800, 1000, true
        );
    }
}
