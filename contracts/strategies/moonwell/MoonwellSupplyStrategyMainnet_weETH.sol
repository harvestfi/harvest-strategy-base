//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./MoonwellSupplyStrategy.sol";

contract MoonwellSupplyStrategyMainnet_weETH is MoonwellSupplyStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A);
        address mToken = address(0xb8051464C8c92209C92F3a4CD9C73746C4c3CFb3);
        address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
        address well = address(0xA88594D404727625A9437C3f886C7643872296AE);
        MoonwellSupplyStrategy.initializeBaseStrategy(_storage, underlying, _vault, mToken, comptroller, well);
        rewardTokens = [well];
    }
}
