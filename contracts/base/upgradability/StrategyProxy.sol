// SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "../interface/IUpgradeSource.sol";
import "./BaseUpgradeabilityProxy.sol";

/**
 * @title StrategyProxy
 * @dev Proxy contract for strategies, enabling controlled upgrades by governance.
 * Inherits from `BaseUpgradeabilityProxy` to support upgradeable contract logic.
 */
contract StrategyProxy is BaseUpgradeabilityProxy {

  /**
   * @dev Initializes the proxy with an implementation address.
   * @param _implementation The address of the initial implementation contract.
   */
  constructor(address _implementation) public {
    _setImplementation(_implementation);
  }

  /**
   * @notice Upgrades the implementation to a new address if a scheduled upgrade exists.
   * @dev Only callable if an upgrade has been scheduled and the timer has elapsed.
   * Calls `finalizeUpgrade` through delegatecall to finalize the storage update in the proxy.
   * Reverts if the upgrade is not scheduled or if the finalization fails.
   */
  function upgrade() external {
    (bool should, address newImplementation) = IUpgradeSource(address(this)).shouldUpgrade();
    require(should, "Upgrade not scheduled");
    _upgradeTo(newImplementation);

    // Finalizes upgrade with delegatecall to ensure storage is updated within this proxy
    (bool success,) = address(this).delegatecall(
      abi.encodeWithSignature("finalizeUpgrade()")
    );

    require(success, "Issue when finalizing the upgrade");
  }

  /**
   * @notice Returns the current implementation address.
   * @return The address of the current implementation contract.
   */
  function implementation() external view returns (address) {
    return _implementation();
  }
}
