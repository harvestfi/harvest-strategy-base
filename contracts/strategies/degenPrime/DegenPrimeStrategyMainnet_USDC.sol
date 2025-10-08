//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./DegenPrimeStrategy.sol";

contract DegenPrimeStrategyMainnet_USDC is DegenPrimeStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address primePool = address(0x2Fc7641F6A569d0e678C473B95C2Fc56A88aDF75);
    address weth = address(0x4200000000000000000000000000000000000006);
    DegenPrimeStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      primePool,
      weth
    );
  }
}