//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./GeneralERC4626Strategy.sol";

contract IPORLendingStrategyMainnet_GOOGL is GeneralERC4626Strategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xb2000000000000000000002D0BA3164cc74f58B7);
    address fToken = address(0x01DBDB9748ECf71B1fFbb62f5cB41318531bA362);
    address usdc = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    GeneralERC4626Strategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      fToken,
      usdc
    );
  }
}
