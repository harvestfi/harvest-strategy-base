//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeStableStrategy.sol";

contract AerodromeStableStrategyMainnet_eUSD_USDC is AerodromeStableStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x7A034374C89C463DD65D8C9BCfe63BcBCED41f4F);
    address gauge = address(0x793F22aB88dC91793E5Ce6ADbd7E733B0BD4733e);
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
