//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./WasabiLendStrategy.sol";

contract WasabiLendStrategyMainnet_USDC is WasabiLendStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address fToken = address(0x1C4a802FD6B591BB71dAA01D8335e43719048B24);
    address weth = address(0x4200000000000000000000000000000000000006);
    WasabiLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      fToken,
      weth
    );
  }
}