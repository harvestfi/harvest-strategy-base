//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_GB_WETH is AerodromeVolatileStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x284ddaDA0B71F2D0D4e395B69b1013dBf6f3e6C1);
    address gauge = address(0x83FC503345Dcde6197b2BD8eaa82ccb4b737Be40);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    address gb = address(0x2aF864fb54b55900Cd58d19c7102d9e4FA8D84a3);
    address weth = address(0x4200000000000000000000000000000000000006);
    AerodromeVolatileStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      weth
    );
    rewardTokens = [aero, gb, weth];
  }
}
