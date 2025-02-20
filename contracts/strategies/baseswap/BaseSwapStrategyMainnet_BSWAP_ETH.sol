//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./BaseSwapStrategy.sol";

contract BaseSwapStrategyMainnet_BSWAP_ETH is BaseSwapStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xE80B4F755417FB4baF4dbd23C029db3F62786523);
    address masterChef = address(0x2B0A43DCcBD7d42c18F6A83F86D1a19fA58d541A);
    BaseSwapStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      masterChef,
      1        // Pool id
    );
    rewardTokens = [bswap];
  }
}
