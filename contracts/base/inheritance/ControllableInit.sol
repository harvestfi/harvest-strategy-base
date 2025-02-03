// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./GovernableInit.sol";

/**
 * @title ControllableInit
 * @dev This contract is a clone of Governable that supports the Initializable pattern.
 * Provides functionality to restrict certain functions to controller or governance roles.
 * Inherits from the GovernableInit contract.
 */
contract ControllableInit is GovernableInit {

  /**
   * @dev Empty constructor. Initialization logic is handled by the `initialize` function.
   */
  constructor() {}

  /**
   * @notice Initializes the contract with the storage address.
   * @dev This function is only callable once due to the `initializer` modifier.
   * @param _storage The address of the storage contract.
   */
  function initialize(address _storage) public override initializer {
    GovernableInit.initialize(_storage);
  }

  /**
   * @dev Modifier to restrict access to only the controller.
   * Reverts if the caller is not the controller.
   */
  modifier onlyController() {
    require(Storage(_storage()).isController(msg.sender), "Not a controller");
    _;
  }

  /**
   * @dev Modifier to restrict access to either the controller or governance.
   * Reverts if the caller is neither the controller nor governance.
   */
  modifier onlyControllerOrGovernance(){
    require((Storage(_storage()).isController(msg.sender) || Storage(_storage()).isGovernance(msg.sender)),
      "The caller must be controller or governance");
    _;
  }

  /**
   * @notice Returns the address of the current controller.
   * @return The address of the controller.
   */
  function controller() public view returns (address) {
    return Storage(_storage()).controller();
  }
}
