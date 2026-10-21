// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

/// @dev Test-only doubles for KeeperChecker fork tests. Never deploy.

/// CL-vault-shaped entry. `checker()` returns `payload` (by default rebalanceCurrentTick(width)).
contract MockKeeperCLVault {
  bool public canExec = true;
  bool public revertOnRebalance = true;
  bytes public payload;
  uint256 public rebalances;

  constructor() {
    payload = abi.encodeWithSignature("rebalanceCurrentTick(uint256)", uint256(4));
  }

  function setCanExec(bool v) external { canExec = v; }
  function setRevertOnRebalance(bool v) external { revertOnRebalance = v; }
  function setPayload(bytes calldata p) external { payload = p; }

  function checker() external view returns (bool, bytes memory) {
    return (canExec, payload);
  }

  function rebalanceCurrentTick(uint256) external {
    require(!revertOnRebalance, "MockCL: rebalance reverts");
    rebalances++;
  }
}

/// Harvest-vault-shaped target of Controller.doHardWork.
contract MockKeeperVault {
  address public strategy;
  bool public revertOnHardWork = true;
  uint256 public hardWorks;

  function setStrategy(address s) external { strategy = s; }
  function setRevertOnHardWork(bool v) external { revertOnHardWork = v; }
  function getPricePerFullShare() external pure returns (uint256) { return 1e18; }

  function doHardWork() external {
    require(!revertOnHardWork, "MockVault: hard work reverts");
    hardWorks++;
  }
}

/// Strategy-shaped HARD_WORK entry. `checker()` returns doHardWork(subject), subject = vault by default.
contract MockKeeperStrategy {
  address public vault;
  address public subject;
  bool public canExec = true;

  constructor(address _vault) {
    vault = _vault;
    subject = _vault;
  }

  function setSubject(address s) external { subject = s; }
  function setCanExec(bool v) external { canExec = v; }

  function checker() external view returns (bool, bytes memory) {
    return (canExec, abi.encodeWithSignature("doHardWork(address)", subject));
  }
}

/// Hostile checkers: return a huge blob, revert, or return a malformed encoding.
contract MockKeeperHostile {
  uint256 public mode; // 0 = return bomb, 1 = revert, 2 = canExec word = 2, 3 = short return

  function setMode(uint256 m) external { mode = m; }

  function strategy() external view returns (address) { return address(this); }

  function checker() external view returns (bool, bytes memory) {
    uint256 m = mode;
    if (m == 1) revert("hostile");
    assembly {
      let p := mload(0x40)
      if eq(m, 0) {
        mstore(p, 1)
        mstore(add(p, 0x20), 0x40)
        mstore(add(p, 0x40), 36)
        return(p, 200000)
      }
      if eq(m, 2) {
        mstore(p, 2)
        mstore(add(p, 0x20), 0x40)
        mstore(add(p, 0x40), 0)
        return(p, 0x60)
      }
      mstore(p, 1)
      return(p, 0x20)
    }
  }
}

/// Wraps a real CLRebalanceHelper: `shouldRebalance` says yes until the vault has rebalanced once
/// after this was deployed; everything else is forwarded. Makes a real CL vault eligible without
/// moving the pool price.
contract MockRebalanceHelperForwarder {
  address public immutable real;
  uint256 public immutable armedAt;

  constructor(address _real) {
    real = _real;
    armedAt = block.timestamp;
  }

  function shouldRebalance(address, int24, int24, int24, uint256, uint256, uint256 lastRebalance, uint256, uint256, uint256)
    external
    view
    returns (bool)
  {
    return lastRebalance < armedAt;
  }

  fallback() external {
    address r = real;
    assembly {
      calldatacopy(0, 0, calldatasize())
      let ok := staticcall(gas(), r, 0, calldatasize(), 0, 0)
      returndatacopy(0, 0, returndatasize())
      if iszero(ok) { revert(0, returndatasize()) }
      return(0, returndatasize())
    }
  }
}
