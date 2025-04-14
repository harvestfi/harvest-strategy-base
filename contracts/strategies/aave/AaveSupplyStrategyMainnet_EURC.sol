//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./AaveSupplyStrategy.sol";

contract AaveSupplyStrategyMainnet_EURC is AaveSupplyStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42);
    address aToken = address(0x90DA57E0A6C0d166Bf15764E03b83745Dc90025B);
    AaveSupplyStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      aToken
    );
  }
}