//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_cbBTC_USDC is AerodromeVolatileStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x9c38b55f9A9Aba91BbCEDEb12bf4428f47A6a0B8);
        address gauge = address(0xEDC76895e053A9bbAC456B5a9c5B49144eee0080);
        address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
        AerodromeVolatileStrategy.initializeBaseStrategy(_storage, underlying, _vault, gauge, aero);
        rewardTokens = [aero];
    }
}
