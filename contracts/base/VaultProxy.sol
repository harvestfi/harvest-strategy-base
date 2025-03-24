// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./interface/IUpgradeSource.sol";
import "./upgradability/BaseUpgradeabilityProxy.sol";

/**
 * @title VaultProxy
 * @dev Proxy contract for a vault, allowing governance-controlled upgrades.
 * Inherits from `BaseUpgradeabilityProxy` to support upgradeable functionality.
 */
contract VaultProxy is BaseUpgradeabilityProxy {

  /**
   * @notice Initializes the VaultProxy with an initial implementation address.
   * @param _implementation Address of the initial implementation contract.
   */
  constructor(address _implementation) {
    _setImplementation(_implementation);
  }

  /**
   * @notice Upgrades the vault to a new implementation if a scheduled upgrade exists and the timer has elapsed.
   * @dev The function calls `finalizeUpgrade` via `delegatecall` to finalize the storage update in the proxy contract.
   * Reverts if an upgrade has not been scheduled or if the finalization process fails.
   */
  function upgrade() external {
    (bool should, address newImplementation) = IUpgradeSource(address(this)).shouldUpgrade();
    require(should, "Upgrade not scheduled");
    _upgradeTo(newImplementation);

    // Finalize the upgrade by calling `finalizeUpgrade` through delegatecall to ensure storage updates
    (bool success,) = address(this).delegatecall(
      abi.encodeWithSignature("finalizeUpgrade()")
    );

    require(success, "Issue when finalizing the upgrade");
  }

  /**
   * @notice Returns the current implementation address of the vault.
   * @return The address of the current implementation.
   */
  function implementation() external view returns (address) {
    return _implementation();
  }
}
