//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./MoonwellFoldStrategyV2.sol";

contract MoonwellFoldStrategyV2Mainnet_wrsETH is MoonwellFoldStrategyV2 {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xEDfa23602D0EC14714057867A78d01e94176BEA0);
        address mToken = address(0xfC41B49d064Ac646015b459C522820DB9472F4B5);
        address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
        address well = address(0xA88594D404727625A9437C3f886C7643872296AE);
        MoonwellFoldStrategyV2.initializeBaseStrategy(
            _storage, underlying, _vault, mToken, comptroller, well, 720, 740, 1000, true
        );
        rewardTokens = [well];
    }
}
