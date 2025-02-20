//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./AerodromeStableStrategy.sol";

contract AerodromeStableStrategyMainnet_msUSD_USDC is AerodromeStableStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xcEFC8B799a8EE5D9b312aeca73262645D664AaF7);
        address gauge = address(0xDBF852464fC906C744E52Dbd68C1b07dD33A922a);
        address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
        AerodromeStableStrategy.initializeBaseStrategy(_storage, underlying, _vault, gauge, aero);
        rewardTokens = [aero];
    }
}
