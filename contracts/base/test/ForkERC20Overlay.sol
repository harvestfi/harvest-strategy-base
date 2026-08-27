// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

/**
 * @notice Test-only ERC20 used to stand in for a token that a Hardhat fork cannot
 * execute. The tokenised-equity assets behind IPOR's carry-trade vaults carry a single
 * byte of code (0xef) and keep no EVM storage, so a fork reverts with `invalid opcode`
 * on every call. `hardhat_setCode` puts this implementation at the token's address; its
 * storage starts empty, so `initOverlay` and `mint` seed it.
 *
 * Standard ERC20 semantics only — the point is to behave exactly like the real token
 * does on-chain, so the PlasmaVault under test is the real one.
 */
contract ForkERC20Overlay {
  mapping(address => uint256) private _balances;
  mapping(address => mapping(address => uint256)) private _allowances;
  uint256 private _totalSupply;
  string private _name;
  string private _symbol;
  uint8 private _decimals;

  event Transfer(address indexed from, address indexed to, uint256 value);
  event Approval(address indexed owner, address indexed spender, uint256 value);

  function initOverlay(string memory name_, string memory symbol_, uint8 decimals_) external {
    _name = name_;
    _symbol = symbol_;
    _decimals = decimals_;
  }

  function mint(address to, uint256 amount) external {
    _balances[to] += amount;
    _totalSupply += amount;
    emit Transfer(address(0), to, amount);
  }

  function name() external view returns (string memory) { return _name; }
  function symbol() external view returns (string memory) { return _symbol; }
  function decimals() external view returns (uint8) { return _decimals; }
  function totalSupply() external view returns (uint256) { return _totalSupply; }
  function balanceOf(address a) external view returns (uint256) { return _balances[a]; }
  function allowance(address o, address s) external view returns (uint256) { return _allowances[o][s]; }

  function approve(address spender, uint256 amount) external returns (bool) {
    _allowances[msg.sender][spender] = amount;
    emit Approval(msg.sender, spender, amount);
    return true;
  }

  function transfer(address to, uint256 amount) external returns (bool) {
    _transfer(msg.sender, to, amount);
    return true;
  }

  function transferFrom(address from, address to, uint256 amount) external returns (bool) {
    uint256 allowed = _allowances[from][msg.sender];
    if (allowed != type(uint256).max) {
      require(allowed >= amount, "ERC20: insufficient allowance");
      _allowances[from][msg.sender] = allowed - amount;
    }
    _transfer(from, to, amount);
    return true;
  }

  function _transfer(address from, address to, uint256 amount) internal {
    require(_balances[from] >= amount, "ERC20: transfer amount exceeds balance");
    unchecked { _balances[from] -= amount; }
    _balances[to] += amount;
    emit Transfer(from, to, amount);
  }
}
