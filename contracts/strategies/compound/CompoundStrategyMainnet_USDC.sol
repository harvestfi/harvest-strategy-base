//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./CompoundStrategy.sol";

contract CompoundStrategyMainnet_USDC is CompoundStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA);
    address market = address(0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf);
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
