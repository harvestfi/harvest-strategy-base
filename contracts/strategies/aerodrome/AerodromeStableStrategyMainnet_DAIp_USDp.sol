//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./AerodromeStableStrategy.sol";

contract AerodromeStableStrategyMainnet_DAIp_USDp is AerodromeStableStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x1b05e4e814b3431a48b8164c41eaC834d9cE2Da6);
        address gauge = address(0x87803Cb321624921cedaAD4555F07Daa0D1Ed325);
        address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
        AerodromeStableStrategy.initializeBaseStrategy(_storage, underlying, _vault, gauge, aero);
        rewardTokens = [aero];
    }
}
