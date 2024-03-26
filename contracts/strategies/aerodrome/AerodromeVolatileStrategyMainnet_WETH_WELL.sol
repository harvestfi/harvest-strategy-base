//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_WETH_WELL is AerodromeVolatileStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xffA3F8737C39e36dec4300B162c2153c67c8352f);
    address gauge = address(0xcEa0a2228145d0fD25dE083e3786ddB1eA184296);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    address well = address(0xFF8adeC2221f9f4D8dfbAFa6B9a297d17603493D);
    address weth = address(0x4200000000000000000000000000000000000006);
    AerodromeVolatileStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      weth
    );
    rewardTokens = [aero, weth, well];
  }
}
