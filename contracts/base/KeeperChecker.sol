// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./inheritance/Controllable.sol";
import "./interface/IStrategy.sol";
import "./interface/IVault.sol";
import "./interface/chainlink/AutomationCompatibleInterface.sol";

/// @title KeeperChecker
/// @notice One Automation-compatible upkeep for every Harvest keeper job on a chain. It replaces
///         both `CLChainlinkChecker` (CL rebalances) and `ChainlinkChecker` (Controller hard works),
///         so a single keeper target, or a single CRE workflow, maintains CL vaults and Aave/Moonwell
///         looping (fold) strategies.
///
///         Each entry is typed, and each type has exactly one call it may make:
///           CL_REBALANCE  target = CL vault           -> target.rebalanceCurrentTick(width)
///           HARD_WORK     target = vault or strategy  -> controller.doHardWork(entry.vault)
///         The width comes from the vault's own `checker()`. The hard-work subject is fixed when the
///         entry is added (the vault itself, or `strategy.vault()`), and the strategy must still be
///         the vault's active strategy. Nothing else can be called: there is no function that takes
///         a call target or calldata.
///
///         Failure isolation. The old checkers surfaced only the FIRST eligible entry and reverted when
///         its call failed, so one broken entry starved every entry behind it. Here `performUpkeep`
///         re-checks each listed entry on chain, catches a failing call, emits `UpkeepFailed`, and
///         puts the entry into an exponential time backoff that `checkUpkeep` skips. Failures are only
///         recorded when the caller is a registered keeper: anyone can still perform, but nobody can
///         push an entry into backoff from inside a state they manipulated in the same transaction
///         (e.g. a flash-loan that drains an Aave reserve to make a fold deleverage revert).
///
///         Ordering. Entries are scanned by priority tier (0 first). Within a tier the scan rotates
///         with the block number, so an entry that stays eligible cannot starve its neighbours.
///         `checkData` can shard the registry across several upkeeps (see `checkUpkeep`).
///
///         Gas. A perform runs at most `maxPerPerform` entries; each `checker()` read is capped at
///         `checkGasLimit` and each execution at `callGasLimit[kind]`. An entry is only attempted when
///         the transaction can give it its full cap, so a short-gassed call skips it instead of
///         failing it.
///
///         msg.sender chain: keeper -> performUpkeep(this) -> vault / controller. So this contract
///         must be each CL vault's `rebalanceExecutor` and a Controller `hardWorker`.
contract KeeperChecker is Controllable, AutomationCompatibleInterface {
  enum Kind { NONE, CL_REBALANCE, HARD_WORK }

  /// @dev Why an entry is or is not runnable right now. Returned by `status()` for monitoring.
  enum Status { ELIGIBLE, NOT_REGISTERED, BACKED_OFF, CHECKER_FAILED, NOT_NEEDED, BAD_PAYLOAD, STALE_STRATEGY }

  struct Entry {
    Kind kind;
    uint8 priority;
    uint8 failures; // consecutive recorded failures, saturating
    uint40 backoffUntil; // checkUpkeep/performUpkeep skip the entry until this timestamp
    address vault; // HARD_WORK subject (the vault, or strategy.vault()); the target itself for CL_REBALANCE
  }

  uint8 public constant PRIORITY_SAFETY = 0;
  uint8 public constant PRIORITY_REBALANCE = 1;
  uint8 public constant PRIORITY_HARVEST = 2;
  uint8 public constant MAX_PRIORITY = 7;
  uint256 public constant MAX_BATCH = 5;
  uint256 public constant MAX_CALL_GAS = 15_000_000;
  uint256 public constant MIN_CALL_GAS = 100_000;

  bytes4 public constant REBALANCE_SELECTOR = bytes4(keccak256("rebalanceCurrentTick(uint256)"));
  bytes4 public constant HARD_WORK_SELECTOR = bytes4(keccak256("doHardWork(address)"));
  bytes4 private constant CHECKER_SELECTOR = bytes4(keccak256("checker()"));
  uint256 private constant PAYLOAD_LENGTH = 36;
  uint256 private constant MAX_REASON_LENGTH = 256;
  /// @dev Gas kept back after an execution for the call overhead, bookkeeping and the event.
  uint256 private constant POST_CALL_GAS = 60_000;

  address[] internal _targets;
  mapping(address => uint256) internal _indexPlusOne;
  mapping(address => Entry) public entries;

  mapping(address => bool) public isKeeper;
  /// @notice When true only registered keepers may perform. Off by default (permissionless, as before).
  bool public keepersOnly;
  uint256 public maxPerPerform = 2;
  uint256 public checkGasLimit = 1_000_000;
  mapping(Kind => uint256) public callGasLimit;
  uint256 public backoffBase = 10 minutes;
  uint256 public backoffMax = 6 hours;

  uint256 private _locked = 1;

  event EntryAdded(address indexed target, Kind kind, uint8 priority, address indexed vault);
  event EntryRemoved(address indexed target);
  event PriorityChanged(address indexed target, uint8 priority);
  event BackoffCleared(address indexed target);
  event UpkeepExecuted(address indexed target, Kind kind, bytes payload);
  /// @param backoffUntil 0 when the failure was not recorded (the caller is not a keeper).
  event UpkeepFailed(address indexed target, Kind kind, bytes reason, uint8 failures, uint40 backoffUntil);
  event KeeperSet(address indexed keeper, bool allowed);
  event KeepersOnlySet(bool enabled);
  event MaxPerPerformSet(uint256 value);
  event CheckGasLimitSet(uint256 value);
  event CallGasLimitSet(Kind kind, uint256 value);
  event BackoffSet(uint256 base, uint256 max);

  error ZeroAddress();
  error NotAContract(address target);
  error Duplicate(address target);
  error UnknownTarget(address target);
  error BadKind();
  error BadPriority(uint8 priority);
  error BadValue();
  error LengthMismatch();
  error NotAVaultOrStrategy(address target);
  error StrategyNotActive(address strategy, address vault);
  error NotKeeper(address caller);
  error TooMany(uint256 length);
  error NotNeeded();
  error Reentrant();

  constructor(address _storage) Controllable(_storage) {
    callGasLimit[Kind.CL_REBALANCE] = 4_500_000;
    callGasLimit[Kind.HARD_WORK] = 4_500_000;
  }

  modifier nonReentrant() {
    if (_locked != 1) revert Reentrant();
    _locked = 2;
    _;
    _locked = 1;
  }

  // ------------------------------------------------------------------------------ registry --

  function targetCount() external view returns (uint256) {
    return _targets.length;
  }

  function targetAt(uint256 i) external view returns (address) {
    return _targets[i];
  }

  function getTargets() external view returns (address[] memory) {
    return _targets;
  }

  function addEntry(address target, Kind kind, uint8 priority) public onlyGovernance {
    if (target == address(0)) revert ZeroAddress();
    if (target.code.length == 0) revert NotAContract(target);
    if (entries[target].kind != Kind.NONE) revert Duplicate(target);
    if (kind == Kind.NONE) revert BadKind();
    if (priority > MAX_PRIORITY) revert BadPriority(priority);
    address vault = kind == Kind.HARD_WORK ? _resolveVault(target) : target;
    entries[target] = Entry({kind: kind, priority: priority, failures: 0, backoffUntil: 0, vault: vault});
    _targets.push(target);
    _indexPlusOne[target] = _targets.length;
    emit EntryAdded(target, kind, priority, vault);
  }

  function addEntries(address[] calldata targets, Kind[] calldata kinds, uint8[] calldata priorities)
    external
    onlyGovernance
  {
    if (targets.length != kinds.length || targets.length != priorities.length) revert LengthMismatch();
    for (uint256 i = 0; i < targets.length; i++) addEntry(targets[i], kinds[i], priorities[i]);
  }

  function removeEntry(address target) public onlyGovernance {
    uint256 idx = _indexPlusOne[target];
    if (idx == 0) revert UnknownTarget(target);
    uint256 last = _targets.length;
    if (idx != last) {
      address moved = _targets[last - 1];
      _targets[idx - 1] = moved;
      _indexPlusOne[moved] = idx;
    }
    _targets.pop();
    delete _indexPlusOne[target];
    delete entries[target];
    emit EntryRemoved(target);
  }

  function removeEntries(address[] calldata targets) external onlyGovernance {
    for (uint256 i = 0; i < targets.length; i++) removeEntry(targets[i]);
  }

  function setPriority(address target, uint8 priority) public onlyGovernance {
    if (entries[target].kind == Kind.NONE) revert UnknownTarget(target);
    if (priority > MAX_PRIORITY) revert BadPriority(priority);
    entries[target].priority = priority;
    emit PriorityChanged(target, priority);
  }

  function setPriorities(address[] calldata targets, uint8[] calldata priorities) external onlyGovernance {
    if (targets.length != priorities.length) revert LengthMismatch();
    for (uint256 i = 0; i < targets.length; i++) setPriority(targets[i], priorities[i]);
  }

  function clearBackoff(address target) external onlyGovernance {
    Entry storage e = entries[target];
    if (e.kind == Kind.NONE) revert UnknownTarget(target);
    e.failures = 0;
    e.backoffUntil = 0;
    emit BackoffCleared(target);
  }

  // ------------------------------------------------------------------------------ settings --

  function setKeeper(address keeper, bool allowed) external onlyGovernance {
    if (keeper == address(0)) revert ZeroAddress();
    isKeeper[keeper] = allowed;
    emit KeeperSet(keeper, allowed);
  }

  function setKeepersOnly(bool enabled) external onlyGovernance {
    keepersOnly = enabled;
    emit KeepersOnlySet(enabled);
  }

  function setMaxPerPerform(uint256 value) external onlyGovernance {
    if (value == 0 || value > MAX_BATCH) revert BadValue();
    maxPerPerform = value;
    emit MaxPerPerformSet(value);
  }

  function setCheckGasLimit(uint256 value) external onlyGovernance {
    if (value < MIN_CALL_GAS || value > MAX_CALL_GAS) revert BadValue();
    checkGasLimit = value;
    emit CheckGasLimitSet(value);
  }

  function setCallGasLimit(Kind kind, uint256 value) external onlyGovernance {
    if (kind == Kind.NONE) revert BadKind();
    if (value < MIN_CALL_GAS || value > MAX_CALL_GAS) revert BadValue();
    callGasLimit[kind] = value;
    emit CallGasLimitSet(kind, value);
  }

  function setBackoff(uint256 base, uint256 max) external onlyGovernance {
    if (base == 0 || max < base || max > 30 days) revert BadValue();
    backoffBase = base;
    backoffMax = max;
    emit BackoffSet(base, max);
  }

  // ------------------------------------------------------------------ Chainlink Automation --

  /// @notice Returns up to `maxPerPerform` eligible targets, safety tier first.
  /// @param checkData empty, or `abi.encode(uint256 rotation)` to offset the in-tier rotation (the
  /// old checkers' start index), or `abi.encode(uint256 rotation, uint256 shards, uint256 shard)`
  /// to scan only targets with `uint160(target) % shards == shard` (stable across add/remove).
  /// @return upkeepNeeded true when at least one target is eligible.
  /// @return performData `abi.encode(address[] targets)`.
  function checkUpkeep(bytes calldata checkData)
    external
    view
    override
    returns (bool upkeepNeeded, bytes memory performData)
  {
    (uint256 rotation, uint256 shards, uint256 shard) = _decodeCheckData(checkData);
    uint256 n = _targets.length;
    if (n == 0) return (false, bytes(""));

    uint256 max = maxPerPerform;
    address[] memory picked = new address[](max);
    uint256 count = 0;
    uint256 offset = (rotation % n + block.number % n) % n;

    // One pass to learn which tiers are populated, so empty tiers cost nothing.
    uint256 tiers = 0;
    for (uint256 i = 0; i < n; i++) tiers |= 1 << entries[_targets[i]].priority;

    for (uint256 p = 0; p <= MAX_PRIORITY && count < max; p++) {
      if (tiers & (1 << p) == 0) continue;
      for (uint256 i = 0; i < n && count < max; i++) {
        address t = _targets[(offset + i) % n];
        Entry memory e = entries[t];
        if (e.priority != p) continue;
        if (shards > 1 && uint256(uint160(t)) % shards != shard) continue;
        (Status s,) = _evaluate(t, e);
        if (s == Status.ELIGIBLE) picked[count++] = t;
      }
    }
    if (count == 0) return (false, bytes(""));
    assembly ("memory-safe") {
      mstore(picked, count)
    }
    return (true, abi.encode(picked));
  }

  /// @notice Executes every listed target that is still eligible. A target that is no longer
  /// eligible (a racing keeper got there first, or the data was stale or forged) is skipped; a target
  /// whose call reverts is reported and, for a keeper caller, backed off. Reverts only when nothing
  /// ran and nothing was recorded, so a losing racer's simulation fails cleanly.
  function performUpkeep(bytes calldata performData) external override nonReentrant {
    bool trusted = isKeeper[msg.sender];
    if (keepersOnly && !trusted) revert NotKeeper(msg.sender);
    address[] memory list = abi.decode(performData, (address[]));
    if (list.length > maxPerPerform) revert TooMany(list.length);

    uint256 done = 0;
    for (uint256 i = 0; i < list.length; i++) {
      address t = list[i];
      Entry memory e = entries[t];
      (Status s, bytes memory payload) = _evaluate(t, e);
      if (s != Status.ELIGIBLE) continue;

      uint256 g = callGasLimit[e.kind];
      // EIP-150 forwards at most 63/64 of what is left. Stop rather than run the entry short of its
      // cap: an out-of-gas revert caused by the caller's gas limit must never count as a failure.
      if (gasleft() < g + g / 63 + POST_CALL_GAS) break;

      address callee = e.kind == Kind.CL_REBALANCE ? t : controller();
      (bool ok, bytes memory reason) = _call(callee, payload, g);
      if (ok) {
        if (e.failures != 0 || e.backoffUntil != 0) {
          entries[t].failures = 0;
          entries[t].backoffUntil = 0;
        }
        emit UpkeepExecuted(t, e.kind, payload);
        done++;
      } else if (trusted) {
        uint8 failures = e.failures == type(uint8).max ? e.failures : e.failures + 1;
        uint256 delay = backoffBase << (failures > 32 ? 32 : failures - 1);
        if (delay > backoffMax) delay = backoffMax;
        uint40 until = uint40(block.timestamp + delay);
        entries[t].failures = failures;
        entries[t].backoffUntil = until;
        emit UpkeepFailed(t, e.kind, reason, failures, until);
        done++;
      } else {
        emit UpkeepFailed(t, e.kind, reason, e.failures, 0);
      }
    }
    if (done == 0) revert NotNeeded();
  }

  // ----------------------------------------------------------------------------- monitoring --

  /// @notice Whether `target` would run now, and the exact call it would make.
  function status(address target) external view returns (Status, bytes memory payload) {
    return _evaluate(target, entries[target]);
  }

  // ------------------------------------------------------------------------------- internal --

  function _evaluate(address t, Entry memory e) internal view returns (Status s, bytes memory payload) {
    if (e.kind == Kind.NONE) return (Status.NOT_REGISTERED, payload);
    if (e.backoffUntil > block.timestamp) return (Status.BACKED_OFF, payload);
    (s, payload) = _probe(t);
    if (s != Status.ELIGIBLE) return (s, payload);

    if (e.kind == Kind.CL_REBALANCE) {
      if (bytes4(payload) != REBALANCE_SELECTOR) return (Status.BAD_PAYLOAD, payload);
    } else {
      if (keccak256(payload) != keccak256(abi.encodeWithSelector(HARD_WORK_SELECTOR, e.vault))) {
        return (Status.BAD_PAYLOAD, payload);
      }
      if (e.vault != t) {
        (bool ok, address active) = _readAddress(e.vault, IVault.strategy.selector);
        if (!ok || active != t) return (Status.STALE_STRATEGY, payload);
      }
    }
  }

  /// @dev Reads `target.checker()` under `checkGasLimit` without trusting its return data: only a
  /// standard `(bool, bytes)` encoding whose bytes are exactly 36 long (selector + one word) is
  /// accepted, and at most 0xa0 bytes are ever copied, so a hostile checker cannot return-bomb us.
  function _probe(address t) internal view returns (Status s, bytes memory payload) {
    uint256 g = checkGasLimit;
    bytes4 sel = CHECKER_SELECTOR;
    bool success;
    uint256 rds;
    uint256 flag;
    uint256 offset;
    uint256 len;
    payload = new bytes(PAYLOAD_LENGTH);
    assembly ("memory-safe") {
      let ptr := mload(0x40)
      mstore(ptr, sel)
      success := staticcall(g, t, ptr, 4, 0, 0)
      rds := returndatasize()
      if and(success, gt(rds, 0x5f)) {
        returndatacopy(ptr, 0, 0x60)
        flag := mload(ptr)
        offset := mload(add(ptr, 0x20))
        len := mload(add(ptr, 0x40))
      }
    }
    if (!success || rds < 0x60 || flag > 1) return (Status.CHECKER_FAILED, payload);
    if (flag == 0) return (Status.NOT_NEEDED, payload);
    if (offset != 0x40 || len != PAYLOAD_LENGTH || rds < 0xa0) return (Status.BAD_PAYLOAD, payload);
    assembly ("memory-safe") {
      returndatacopy(add(payload, 0x20), 0x60, 36)
    }
    return (Status.ELIGIBLE, payload);
  }

  function _readAddress(address t, bytes4 sel) internal view returns (bool ok, address a) {
    uint256 g = checkGasLimit;
    assembly ("memory-safe") {
      let ptr := mload(0x40)
      mstore(ptr, sel)
      // Two statements on purpose: Yul evaluates arguments right to left, so folding these into
      // one and(...) would read the PREVIOUS call's returndatasize.
      let success := staticcall(g, t, ptr, 4, ptr, 0x20)
      if and(success, gt(returndatasize(), 0x1f)) {
        let w := mload(ptr)
        if iszero(shr(160, w)) {
          ok := 1
          a := w
        }
      }
    }
  }

  /// @dev Executes with a hard gas cap and copies at most MAX_REASON_LENGTH bytes of revert data.
  function _call(address callee, bytes memory data, uint256 g) internal returns (bool ok, bytes memory reason) {
    uint256 rds;
    assembly ("memory-safe") {
      ok := call(g, callee, 0, add(data, 0x20), mload(data), 0, 0)
      rds := returndatasize()
    }
    if (!ok) {
      uint256 n = rds > MAX_REASON_LENGTH ? MAX_REASON_LENGTH : rds;
      reason = new bytes(n);
      assembly ("memory-safe") {
        returndatacopy(add(reason, 0x20), 0, n)
      }
    }
  }

  /// @dev A strategy entry hard-works `strategy.vault()` and must be that vault's active strategy;
  /// anything without a `vault()` is taken as the vault itself and must report a strategy.
  function _resolveVault(address target) internal view returns (address) {
    (bool ok, address vault) = _readAddress(target, IStrategy.vault.selector);
    if (ok && vault != address(0) && vault.code.length > 0) {
      (bool ok2, address active) = _readAddress(vault, IVault.strategy.selector);
      if (!ok2 || active != target) revert StrategyNotActive(target, vault);
      return vault;
    }
    (bool ok3, address strat) = _readAddress(target, IVault.strategy.selector);
    if (!ok3 || strat == address(0)) revert NotAVaultOrStrategy(target);
    return target;
  }

  function _decodeCheckData(bytes calldata checkData)
    internal
    pure
    returns (uint256 rotation, uint256 shards, uint256 shard)
  {
    if (checkData.length == 32) {
      rotation = abi.decode(checkData, (uint256));
    } else if (checkData.length == 96) {
      (rotation, shards, shard) = abi.decode(checkData, (uint256, uint256, uint256));
      if (shards > 1 && shard >= shards) revert BadValue();
    }
  }
}
