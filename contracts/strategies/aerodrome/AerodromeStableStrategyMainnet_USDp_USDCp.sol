//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeStableStrategy.sol";

contract AerodromeStableStrategyMainnet_USDp_USDCp is AerodromeStableStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xE96c788E66a97Cf455f46C5b27786191fD3bC50B);
    address gauge = address(0x526b3D92fF55263dd24E3e14ccD0f5c2Dab81d3b);
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
