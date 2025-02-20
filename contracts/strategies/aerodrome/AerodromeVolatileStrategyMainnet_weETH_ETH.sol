//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_weETH_ETH is AerodromeVolatileStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x91F0f34916Ca4E2cCe120116774b0e4fA0cdcaA8);
        address gauge = address(0xf8d47b641eD9DF1c924C0F7A6deEEA2803b9CfeF);
        address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
        AerodromeVolatileStrategy.initializeBaseStrategy(_storage, underlying, _vault, gauge, aero);
        rewardTokens = [aero];
    }
}
