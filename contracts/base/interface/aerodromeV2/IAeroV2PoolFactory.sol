// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title IAeroV2PoolFactory
 * @notice Factory of Aero V2 Basic pools (one for volatile pools, one for stable pools).
 */
interface IAeroV2PoolFactory {
  /// @notice While true, every pool of this factory reverts swaps with IsPaused (mint and burn still work)
  function isPaused() external view returns (bool);

  /// @notice Pauses or unpauses swaps in all pools of this factory. Aero's pauser only.
  function setPauseState(bool state) external;

  /// @notice Account allowed to call setPauseState
  function pauser() external view returns (address);
}
