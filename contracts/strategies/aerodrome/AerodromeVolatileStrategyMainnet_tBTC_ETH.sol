//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_tBTC_ETH is AerodromeVolatileStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x2722C8f9B5E2aC72D1f225f8e8c990E449ba0078);
    address gauge = address(0xfaE8C18D83655Fbf31af10d2e9A1Ad5bA77D0377);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    address weth = address(0x4200000000000000000000000000000000000006);
    address tbtc = address(0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b);
    AerodromeVolatileStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      weth
    );
    rewardTokens = [aero, weth, tbtc];
  }
}
