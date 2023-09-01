//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_AERO_USDC is AerodromeVolatileStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x2223F9FE624F69Da4D8256A7bCc9104FBA7F8f75);
    address gauge = address(0x9a202c932453fB3d04003979B121E80e5A14eE7b);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    address usdc = address(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA);
    AerodromeVolatileStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      aero
    );
    rewardTokens = [aero, usdc];
  }
}
