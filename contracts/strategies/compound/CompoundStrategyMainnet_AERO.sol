//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./CompoundStrategy.sol";

contract CompoundStrategyMainnet_AERO is CompoundStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    address market = address(0x784efeB622244d2348d4F2522f8860B96fbEcE89);
    address rewards = address(0x123964802e6ABabBE1Bc9547D72Ef1B69B00A6b1);
    address comp = address(0x9e1028F5F1D5eDE59748FFceE5532509976840E0);
    CompoundStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      market,
      rewards,
      comp
    );
  }
}
