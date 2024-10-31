// SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./Storage.sol";

/**
 * @title Governable
 * @dev This contract provides governance-controlled access to specific functions.
 * Stores a reference to a `Storage` contract and restricts certain functions to
 * only be accessible by the governance address.
 */
contract Governable {

  /// @notice Reference to the storage contract containing governance and controller information
  Storage public store;

  /**
   * @dev Sets the initial storage contract address upon deployment.
   * @param _store The address of the Storage contract.
   * Reverts if `_store` is the zero address.
   */
  constructor(address _store) public {
    require(_store != address(0), "new storage shouldn't be empty");
    store = Storage(_store);
  }

  /**
   * @dev Modifier to restrict access to only governance.
   * Reverts if the caller is not the governance address.
   */
  modifier onlyGovernance() {
    require(store.isGovernance(msg.sender), "Not governance");
    _;
  }

  /**
   * @notice Updates the storage contract reference.
   * @dev Can only be called by the governance address.
   * @param _store The new address of the Storage contract.
   * Reverts if `_store` is the zero address.
   */
  function setStorage(address _store) public onlyGovernance {
    require(_store != address(0), "new storage shouldn't be empty");
    store = Storage(_store);
  }

  /**
   * @notice Gets the current governance address from the storage contract.
   * @return The address of the governance.
   */
  function governance() public view returns (address) {
    return store.governance();
  }
}
