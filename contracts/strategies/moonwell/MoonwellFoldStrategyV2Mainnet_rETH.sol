//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./MoonwellFoldStrategyV2.sol";

contract MoonwellFoldStrategyV2Mainnet_rETH is MoonwellFoldStrategyV2 {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c);
        address mToken = address(0xCB1DaCd30638ae38F2B94eA64F066045B7D45f44);
        address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
        address well = address(0xFF8adeC2221f9f4D8dfbAFa6B9a297d17603493D);
        address usdc = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
        address well_new = address(0xA88594D404727625A9437C3f886C7643872296AE);
        MoonwellFoldStrategyV2.initializeBaseStrategy(
            _storage, underlying, _vault, mToken, comptroller, usdc, 760, 780, 1000, true
        );
        rewardTokens = [well, usdc, well_new];
    }
}
