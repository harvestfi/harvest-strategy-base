//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./BaseSwapStrategyV2.sol";

contract BaseSwapStrategyV2Mainnet_axlWBTC_USDbC is BaseSwapStrategyV2 {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x317d373E590795e2c09D73FaD7498FC98c0A692B);
        address nftPool = address(0x7E0F687d82D05aDb99D196Cd8E342f042803A4b6);
        address _xBSXVault = address(0x40455352Dd3c5D65A40729C22B12265C17B37b75);
        BaseSwapStrategyV2.initializeBaseStrategy(_storage, underlying, _vault, nftPool, _xBSXVault, address(0));
        rewardTokens = [bswap, bsx];
    }
}
