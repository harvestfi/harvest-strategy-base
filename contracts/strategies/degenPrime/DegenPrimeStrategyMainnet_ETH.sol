//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./DegenPrimeStrategy.sol";

contract DegenPrimeStrategyMainnet_ETH is DegenPrimeStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4200000000000000000000000000000000000006);
    address primePool = address(0x81b0b59C7967479EC5Ce55cF6588bf314C3E4852);
    address usdc = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    DegenPrimeStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      primePool,
      usdc
    );
  }
}