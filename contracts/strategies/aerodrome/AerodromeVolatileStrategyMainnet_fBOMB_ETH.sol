//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_fBOMB_ETH is AerodromeVolatileStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4F9Dc2229f2357B27C22db56cB39582c854Ad6d5);
    address gauge = address(0x76c48576822Cd955C320f5d5A163E738dbFEcc01);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    address weth = address(0x4200000000000000000000000000000000000006);
    address fbomb = address(0x74ccbe53F77b08632ce0CB91D3A545bF6B8E0979);
    AerodromeVolatileStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      weth
    );
    rewardTokens = [aero, weth, fbomb];
  }
}
