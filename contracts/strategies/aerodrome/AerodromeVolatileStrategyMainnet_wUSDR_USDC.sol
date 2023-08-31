//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_wUSDR_USDC is AerodromeVolatileStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x3Fc28BFac25fC8e93B5b2fc15EfBBD5a8aA44eFe);
    address gauge = address(0xF64957C35409055776C7122AC655347ef88eaF9B);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    address usdc = address(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA);
    address wusdr = address(0x9483ab65847A447e36d21af1CaB8C87e9712ff93);
    AerodromeVolatileStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      usdc
    );
    rewardTokens = [aero, usdc, wusdr];
  }
}
