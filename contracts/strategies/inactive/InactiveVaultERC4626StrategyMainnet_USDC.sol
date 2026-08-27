//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./InactiveVaultERC4626Strategy.sol";

/**
 * @dev Inactive vault strategy for USDC, parking the funds in the USDC Autopilot vault.
 */
contract InactiveVaultERC4626StrategyMainnet_USDC is InactiveVaultERC4626Strategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address erc4626Vault = address(0x0d877Dc7C8Fa3aD980DfDb18B48eC9F8768359C4);
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
