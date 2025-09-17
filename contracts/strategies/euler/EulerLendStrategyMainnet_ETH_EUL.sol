//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./EulerLendStrategy.sol";

contract EulerLendStrategyMainnet_ETH_EUL is EulerLendStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4200000000000000000000000000000000000006);
    address eulerVault = address(0x859160DB5841E5cfB8D3f144C6b3381A85A4b410);
    address usdc = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    EulerLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      eulerVault,
      usdc
    );
  }
}