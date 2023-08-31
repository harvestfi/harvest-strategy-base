//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_TAROT_ETH is AerodromeVolatileStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x2d25E0514f23c6367687dE89Bd5167dc754D4934);
    address gauge = address(0xa81dac2e9caa218Fcd039D7CEdEB7847cf362213);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    address weth = address(0x4200000000000000000000000000000000000006);
    address tarot = address(0xF544251D25f3d243A36B07e7E7962a678f952691);
    AerodromeVolatileStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      weth
    );
    rewardTokens = [aero, weth, tarot];
  }
}
