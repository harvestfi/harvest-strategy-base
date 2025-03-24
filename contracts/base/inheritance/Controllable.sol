// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./Governable.sol";

/**
 * @title Controllable
 * @dev Contract module which provides a basic access control mechanism,
 * allowing functions to be restricted to a controller or governance.
 * Inherits from the Governable contract.
 */
contract Controllable is Governable {

  /**
   * @dev Initializes the contract by setting the storage address.
   * @param _storage The address of the storage contract.
   */
  constructor(address _storage) Governable(_storage) {}

  /**
   * @dev Modifier to restrict access to only the controller.
   * Reverts if the caller is not the controller.
   */
  modifier onlyController() {
    require(store.isController(msg.sender), "Not a controller");
    _;
  }

  /**
   * @dev Modifier to restrict access to either the controller or governance.
   * Reverts if the caller is neither the controller nor governance.
   */
  modifier onlyControllerOrGovernance() {
    require((store.isController(msg.sender) || store.isGovernance(msg.sender)),
      "The caller must be controller or governance");
    _;
  }

  /**
   * @notice Gets the address of the current controller.
   * @return The address of the controller.
   */
  function controller() public view returns (address) {
    return store.controller();
  }
}
