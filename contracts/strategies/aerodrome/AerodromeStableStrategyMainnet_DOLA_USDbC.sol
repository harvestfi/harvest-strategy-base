//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeStableStrategy.sol";

contract AerodromeStableStrategyMainnet_DOLA_USDbC is AerodromeStableStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x0B25c51637c43decd6CC1C1e3da4518D54ddb528);
    address gauge = address(0xeAE066C25106006fB386A3a8b1698A0cB6931c1a);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    AerodromeStableStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      aero
    );
    rewardTokens = [aero];
  }
}
