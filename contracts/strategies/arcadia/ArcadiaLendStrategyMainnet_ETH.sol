//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./ArcadiaLendStrategy.sol";

contract ArcadiaLendStrategyMainnet_ETH is ArcadiaLendStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4200000000000000000000000000000000000006);
    address fToken = address(0x393893caeB06B5C16728bb1E354b6c36942b1382);
    address usdc = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    ArcadiaLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      fToken,
      usdc
    );
  }
}