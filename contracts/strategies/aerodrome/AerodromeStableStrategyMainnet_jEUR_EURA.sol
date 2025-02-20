//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./AerodromeStableStrategy.sol";

contract AerodromeStableStrategyMainnet_jEUR_EURA is AerodromeStableStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xe7e01f38470136dE763d22e534e53C8BCdbA3f39);
        address gauge = address(0xb5FFE35051b62DfE687aaB959625a29bEd54575a);
        address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
        AerodromeStableStrategy.initializeBaseStrategy(_storage, underlying, _vault, gauge, aero);
        rewardTokens = [aero];
    }
}
