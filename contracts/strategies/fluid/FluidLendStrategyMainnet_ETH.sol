//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./FluidLendStrategy.sol";

contract FluidLendStrategyMainnet_ETH is FluidLendStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4200000000000000000000000000000000000006);
    address fToken = address(0x9272D6153133175175Bc276512B2336BE3931CE9);
    address usdc = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    FluidLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      fToken,
      usdc
    );
  }
}