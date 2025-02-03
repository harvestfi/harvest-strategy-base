// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

/**
 * @title Storage
 * @dev Contract that manages governance and controller addresses, with governance-controlled access.
 * The contract provides functions to set and verify governance and controller roles.
 */
contract Storage {

  /// @notice Address of the governance
  address public governance;

  /// @notice Address of the controller
  address public controller;

  /**
   * @dev Sets the deployer as the initial governance address.
   */
  constructor() {
    governance = msg.sender;
  }

  /**
   * @dev Modifier to restrict access to only the governance address.
   * Reverts if the caller is not governance.
   */
  modifier onlyGovernance() {
    require(isGovernance(msg.sender), "Not governance");
    _;
  }

  /**
   * @notice Updates the governance address.
   * @dev Can only be called by the current governance address.
   * @param _governance The new address for governance.
   * Reverts if `_governance` is the zero address.
   */
  function setGovernance(address _governance) public onlyGovernance {
    require(_governance != address(0), "new governance shouldn't be empty");
    governance = _governance;
  }

  /**
   * @notice Updates the controller address.
   * @dev Can only be called by the governance address.
   * @param _controller The new address for the controller.
   * Reverts if `_controller` is the zero address.
   */
  function setController(address _controller) public onlyGovernance {
    require(_controller != address(0), "new controller shouldn't be empty");
    controller = _controller;
  }

  /**
   * @notice Checks if a given address is the governance address.
   * @param account The address to check.
   * @return True if `account` is the governance address, false otherwise.
   */
  function isGovernance(address account) public view returns (bool) {
    return account == governance;
  }

  /**
   * @notice Checks if a given address is the controller address.
   * @param account The address to check.
   * @return True if `account` is the controller address, false otherwise.
   */
  function isController(address account) public view returns (bool) {
    return account == controller;
  }
}
