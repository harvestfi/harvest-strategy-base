//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AaveSupplyStrategy.sol";

contract AaveSupplyStrategyMainnet_ETH is AaveSupplyStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4200000000000000000000000000000000000006);
    address aToken = address(0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7);
    AaveSupplyStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      aToken
    );
  }
}
