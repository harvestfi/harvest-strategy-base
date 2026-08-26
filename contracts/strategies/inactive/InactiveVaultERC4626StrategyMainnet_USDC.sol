//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./InactiveVaultERC4626Strategy.sol";

/**
 * @dev Inactive vault strategy for USDC, parking the funds in the Gauntlet USDC Core Morpho vault.
 */
contract InactiveVaultERC4626StrategyMainnet_USDC is InactiveVaultERC4626Strategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address erc4626Vault = address(0xc0c5689e6f4D256E861F65465b691aeEcC0dEb12);
    address weth = address(0x4200000000000000000000000000000000000006);
    InactiveVaultERC4626Strategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      erc4626Vault,
      weth
    );
  }
}
