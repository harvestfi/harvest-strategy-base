//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_GENOME_ETH is AerodromeVolatileStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x963ceee215e5b0B1dCB221C3bA398De66abC73D9);
        address gauge = address(0xa4F335B6ee0f8e34F31d4C8b702080196252dAc3);
        address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
        AerodromeVolatileStrategy.initializeBaseStrategy(_storage, underlying, _vault, gauge, aero);
        rewardTokens = [aero];
    }
}
