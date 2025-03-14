//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_ETH_USDC_V2 is AerodromeVolatileStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xcDAC0d6c6C59727a65F871236188350531885C43);
    address gauge = address(0x519BBD1Dd8C6A94C46080E24f316c14Ee758C025);
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
