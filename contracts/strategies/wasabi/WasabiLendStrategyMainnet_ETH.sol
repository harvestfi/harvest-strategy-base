//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./WasabiLendStrategy.sol";

contract WasabiLendStrategyMainnet_ETH is WasabiLendStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4200000000000000000000000000000000000006);
    address fToken = address(0x197D5C29072C1444Acb4F0935C219738A47E4a18);
    address usdc = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    WasabiLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      fToken,
      usdc
    );
  }
}