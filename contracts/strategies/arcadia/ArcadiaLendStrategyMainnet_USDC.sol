//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./ArcadiaLendStrategy.sol";

contract ArcadiaLendStrategyMainnet_USDC is ArcadiaLendStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address fToken = address(0xEFE32813dBA3A783059d50e5358b9e3661218daD);
    address weth = address(0x4200000000000000000000000000000000000006);
    ArcadiaLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      fToken,
      weth
    );
  }
}