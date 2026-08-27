//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./GeneralERC4626Strategy.sol";

contract IPORLendingStrategyMainnet_USDC is GeneralERC4626Strategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address fToken = address(0xD46a3C2D958d0a2cB098d48C48dC19FE3A710F37);
    address weth = address(0x4200000000000000000000000000000000000006);
    GeneralERC4626Strategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      fToken,
      weth
    );
  }
}