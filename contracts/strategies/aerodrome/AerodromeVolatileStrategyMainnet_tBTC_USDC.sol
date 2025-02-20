//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_tBTC_USDC is AerodromeVolatileStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x723AEf6543aecE026a15662Be4D3fb3424D502A9);
    address gauge = address(0x50f0249B824033Cf0AF0C8b9fe1c67c2842A34d5);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    address usdc = address(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA);
    address tbtc = address(0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b);
    AerodromeVolatileStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      usdc
    );
    rewardTokens = [aero, usdc, tbtc];
  }
}
