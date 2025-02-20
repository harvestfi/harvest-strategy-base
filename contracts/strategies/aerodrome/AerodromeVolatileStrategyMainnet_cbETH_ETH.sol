//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_cbETH_ETH is AerodromeVolatileStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x44Ecc644449fC3a9858d2007CaA8CFAa4C561f91);
        address gauge = address(0xDf9D427711CCE46b52fEB6B2a20e4aEaeA12B2b7);
        address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
        address weth = address(0x4200000000000000000000000000000000000006);
        address cbeth = address(0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22);
        AerodromeVolatileStrategy.initializeBaseStrategy(_storage, underlying, _vault, gauge, weth);
        rewardTokens = [aero, weth, cbeth];
    }
}
