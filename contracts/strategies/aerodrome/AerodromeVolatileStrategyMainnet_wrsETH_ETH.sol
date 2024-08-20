//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_wrsETH_ETH is AerodromeVolatileStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xA24382874A6FD59de45BbccFa160488647514c28);
    address gauge = address(0x2da7789a6371F550caF9054694F5A5A6682903f9);
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
