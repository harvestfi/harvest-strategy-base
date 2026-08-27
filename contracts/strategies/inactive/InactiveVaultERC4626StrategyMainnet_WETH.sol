//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./InactiveVaultERC4626Strategy.sol";

/**
 * @dev Inactive vault strategy for WETH, parking the funds in the WETH Autopilot vault.
 */
contract InactiveVaultERC4626StrategyMainnet_WETH is InactiveVaultERC4626Strategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4200000000000000000000000000000000000006);
    address erc4626Vault = address(0x7872893e528Fe2c0829e405960db5B742112aa97);
    address usdc = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    InactiveVaultERC4626Strategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      erc4626Vault,
      usdc
    );
  }
}
