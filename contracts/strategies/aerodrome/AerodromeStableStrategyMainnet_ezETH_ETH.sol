//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./AerodromeStableStrategy.sol";

contract AerodromeStableStrategyMainnet_ezETH_ETH is AerodromeStableStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x497139e8435E01555AC1e3740fccab7AFf149e02);
        address gauge = address(0x4Fa58b3Bec8cE12014c7775a0B3da7e6AdC3c7eA);
        address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
        AerodromeStableStrategy.initializeBaseStrategy(_storage, underlying, _vault, gauge, aero);
        rewardTokens = [aero];
    }
}
