//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_VIRTUAL_cbBTC is AerodromeVolatileStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xb909F567c5c2Bb1A4271349708CC4637D7318b4A);
        address gauge = address(0x8c44e7F913D0893Cd5A3CBBb2fCd59785a7801ab);
        address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
        AerodromeVolatileStrategy.initializeBaseStrategy(_storage, underlying, _vault, gauge, aero);
        rewardTokens = [aero];
    }
}
