//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./DegenPrimeStrategy.sol";

contract DegenPrimeStrategyMainnet_cbBTC is DegenPrimeStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf);
    address primePool = address(0xCA8C954073054551B99EDee4e1F20c3d08778329);
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