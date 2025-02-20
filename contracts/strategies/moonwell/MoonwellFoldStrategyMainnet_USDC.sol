//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./MoonwellFoldStrategy.sol";

contract MoonwellFoldStrategyMainnet_USDC is MoonwellFoldStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
        address mToken = address(0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22);
        address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
        address well = address(0xFF8adeC2221f9f4D8dfbAFa6B9a297d17603493D);
        MoonwellFoldStrategy.initializeBaseStrategy(
            _storage, underlying, _vault, mToken, comptroller, well, 780, 800, 1000, true
        );
    }
}
