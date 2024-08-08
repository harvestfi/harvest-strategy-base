//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_USDC_KLIMA is AerodromeVolatileStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x958682eC6282BC7E939FA8Ba9397805C214c3A09);
    address gauge = address(0x950aD950D6f07491ef2c150545A6A2AB7AdC03f4);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    AerodromeVolatileStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      aero
    );
    rewardTokens = [aero];
  }
}
