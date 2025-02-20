//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_ETH_USDC is AerodromeVolatileStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xB4885Bc63399BF5518b994c1d0C153334Ee579D0);
        address gauge = address(0xeca7Ff920E7162334634c721133F3183B83B0323);
        address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
        address usdc = address(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA);
        address weth = address(0x4200000000000000000000000000000000000006);
        AerodromeVolatileStrategy.initializeBaseStrategy(_storage, underlying, _vault, gauge, weth);
        rewardTokens = [aero, usdc, weth];
    }
}
