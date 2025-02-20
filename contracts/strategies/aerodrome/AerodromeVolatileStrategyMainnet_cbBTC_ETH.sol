//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_cbBTC_ETH is AerodromeVolatileStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x2578365B3dfA7FfE60108e181EFb79FeDdec2319);
        address gauge = address(0xAFdEBa12B6a870d6639d043030b4b49F9C7c62BB);
        address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
        AerodromeVolatileStrategy.initializeBaseStrategy(_storage, underlying, _vault, gauge, aero);
        rewardTokens = [aero];
    }
}
