// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

/// @notice Test-only ERC20 meant to be installed at an EXISTING address via `hardhat_setCode`,
/// so a token that a fork cannot replicate can still be exercised.
///
/// Base's AAPLc (0xb200…d1fb) is the motivating case: `eth_getCode` returns the single byte 0xef,
/// yet the live node executes `balanceOf`/`transfer` normally — it is a system-level contract whose
/// code the RPC does not expose. A fork copies the stub, so every call into it traps and the whole
/// USDC/AAPLc pair was untestable.
///
/// Two constraints drive the design:
///   1. `setCode` does NOT run a constructor, so nothing can be initialised at deploy time —
///      `initMock` exists to be called afterwards.
///   2. `setCode` does NOT clear the address's existing storage, and the real token's layout is
///      unknown. Using slots 0,1,2… would read whatever the real contract left there, so every
///      slot here is namespaced under a keccak constant that cannot collide in practice. Balances
///      therefore all start at zero and must be seeded deliberately, which is the honest default:
///      a balance that appears without being seeded would be silently wrong.
contract MockNamespacedERC20 {
    bytes32 private constant NS_BAL    = keccak256("harvest.mocknserc20.balances.v1");
    bytes32 private constant NS_ALLOW  = keccak256("harvest.mocknserc20.allowances.v1");
    bytes32 private constant NS_SUPPLY = keccak256("harvest.mocknserc20.totalSupply.v1");
    bytes32 private constant NS_META   = keccak256("harvest.mocknserc20.decimals.v1");

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function _slotBal(address a) private pure returns (bytes32) {
        return keccak256(abi.encode(a, NS_BAL));
    }
    function _slotAllow(address o, address s) private pure returns (bytes32) {
        return keccak256(abi.encode(o, s, NS_ALLOW));
    }
    function _get(bytes32 s) private view returns (uint256 v) {
        assembly { v := sload(s) }
    }
    function _set(bytes32 s, uint256 v) private {
        assembly { sstore(s, v) }
    }

    /// @notice Set the decimals this mock reports. Call once after `setCode`.
    function initMock(uint8 dec) external {
        _set(NS_META, uint256(dec));
    }

    /// @notice Test-only, deliberately unrestricted: the seeding step needs to credit the pool
    /// with the balance it holds on the real chain before any swap or burn can pay out.
    function mint(address to, uint256 amount) external {
        _set(_slotBal(to), _get(_slotBal(to)) + amount);
        _set(NS_SUPPLY, _get(NS_SUPPLY) + amount);
        emit Transfer(address(0), to, amount);
    }

    function decimals() external view returns (uint8) { return uint8(_get(NS_META)); }
    function totalSupply() external view returns (uint256) { return _get(NS_SUPPLY); }
    function balanceOf(address a) external view returns (uint256) { return _get(_slotBal(a)); }
    function allowance(address o, address s) external view returns (uint256) { return _get(_slotAllow(o, s)); }

    function approve(address spender, uint256 amount) external returns (bool) {
        _set(_slotAllow(msg.sender, spender), amount);
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = _get(_slotAllow(from, msg.sender));
        if (a != type(uint256).max) {
            require(a >= amount, "MockNS: allowance");
            _set(_slotAllow(from, msg.sender), a - amount);
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        uint256 b = _get(_slotBal(from));
        require(b >= amount, "MockNS: balance");
        _set(_slotBal(from), b - amount);
        _set(_slotBal(to), _get(_slotBal(to)) + amount);
        emit Transfer(from, to, amount);
    }
}
