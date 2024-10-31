// SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "../upgradability/ReentrancyGuardUpgradeable.sol";
import "./Storage.sol";

/**
 * @title GovernableInit
 * @dev A contract that supports the Initializable interface, allowing for upgradeable deployments.
 * Provides governance-controlled access to certain functions and maintains a reference to a `Storage` contract.
 * Inherits from ReentrancyGuardUpgradeable to prevent reentrancy attacks.
 */
contract GovernableInit is ReentrancyGuardUpgradeable {

  /// @dev Storage slot for the storage contract address, as per EIP-1967 standard for upgradeable contracts.
  bytes32 internal constant _STORAGE_SLOT = 0xa7ec62784904ff31cbcc32d09932a58e7f1e4476e1d041995b37c917990b16dc;

  /**
   * @dev Modifier to restrict access to only the governance address.
   * Reverts if the caller is not governance.
   */
  modifier onlyGovernance() {
    require(Storage(_storage()).isGovernance(msg.sender), "Not governance");
    _;
  }

  /**
   * @dev Constructor to validate the storage slot constant as per EIP-1967.
   * Ensures the storage slot matches a deterministic value for consistency across upgrades.
   */
  constructor() public {
    assert(_STORAGE_SLOT == bytes32(uint256(keccak256("eip1967.governableInit.storage")) - 1));
  }

  /**
   * @notice Initializes the contract with a storage address.
   * @dev This function is intended to be called only once. Reentrancy guard initialization is also performed here.
   * @param _store The address of the storage contract.
   */
  function initialize(address _store) public virtual initializer {
    _setStorage(_store);
    ReentrancyGuardUpgradeable.initialize();
  }

  /**
   * @dev Sets the storage address in the specified EIP-1967 storage slot.
   * @param newStorage The address of the new storage contract.
   * Uses inline assembly to store the address in `_STORAGE_SLOT`.
   */
  function _setStorage(address newStorage) private {
    bytes32 slot = _STORAGE_SLOT;
    // solhint-disable-next-line no-inline-assembly
    assembly {
      sstore(slot, newStorage)
    }
  }

  /**
   * @notice Updates the storage contract reference.
   * @dev Can only be called by governance to update the storage address.
   * @param _store The new address of the storage contract. Must not be the zero address.
   */
  function setStorage(address _store) public onlyGovernance {
    require(_store != address(0), "new storage shouldn't be empty");
    _setStorage(_store);
  }

  /**
   * @dev Internal function to retrieve the current storage address from `_STORAGE_SLOT`.
   * @return str The address of the storage contract.
   */
  function _storage() internal view returns (address str) {
    bytes32 slot = _STORAGE_SLOT;
    // solhint-disable-next-line no-inline-assembly
    assembly {
      str := sload(slot)
    }
  }

  /**
   * @notice Retrieves the governance address from the storage contract.
   * @return The address of the governance.
   */
  function governance() public view returns (address) {
    return Storage(_storage()).governance();
  }
}
