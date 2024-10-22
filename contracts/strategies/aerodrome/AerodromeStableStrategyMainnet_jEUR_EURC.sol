//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeStableStrategy.sol";

contract AerodromeStableStrategyMainnet_jEUR_EURC is AerodromeStableStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xC75799e0646470128a42D07335aB3BFa9E8Ee7C2);
    address gauge = address(0x533eb2cEf740654D09764334Bd86E62F0a253d1a);
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
