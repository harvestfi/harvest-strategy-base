// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./VaultV2.sol";
import "./interface/IHardWorkHooks.sol";

/**
 * @title HookVaultV2
 * @dev A `VaultV2` that lets the strategy supply a withdrawal-safe hard work.
 *
 * With `compoundOnWithdraw` enabled, `VaultV1._withdraw` calls `IStrategy.doHardWork()`
 * before pricing the withdrawal, so the exiting user is credited the interest accrued
 * since the last hard work. `doHardWork()` also ends by depositing idle underlying into
 * the yield source, and the vault then redeems from that same yield source a few lines
 * later. Yield sources that forbid depositing and redeeming together - a redemption
 * delay, a withdrawal queue - reject that second call and the withdrawal reverts.
 *
 * This vault asks the strategy whether it implements {IHardWorkHooks}. If it does, the
 * withdrawal path calls `doHardWorkOnWithdraw()` instead, which credits the same accrued
 * interest without depositing. If it does not, the vault calls `doHardWork()` exactly as
 * `VaultV2` always has, so any existing strategy behaves identically.
 *
 * The deposit path is deliberately untouched: `investOnDeposit` still runs the full
 * `doHardWork()`, deposit included.
 *
 * Storage layout, every other entrypoint and the flags themselves are inherited from
 * `VaultV2` unchanged, so this is a drop-in implementation for an existing vault proxy.
 */
contract HookVaultV2 is VaultV2 {
  // `using ... for` is not inherited, so the directives VaultV1 relies on are repeated
  // here for the function bodies this contract overrides.
  using SafeERC20Upgradeable for IERC20Upgradeable;
  using SafeMathUpgradeable for uint256;

  /// @dev keccak256("eip1967.vaultStorage.depositCap") - 1. A dedicated hashed slot, so
  /// adding it leaves the inherited storage layout untouched.
  bytes32 internal constant _DEPOSIT_CAP_SLOT = 0xd835bdd7ad461b0c86e99a3d099e26b9deeba4c35acaddbb2e0d9d5b3aa58781;

  event DepositCapChanged(uint256 oldCap, uint256 newCap);

  constructor() {
    assert(_DEPOSIT_CAP_SLOT == bytes32(uint256(keccak256("eip1967.vaultStorage.depositCap")) - 1));
  }

  /**
   * @notice Maximum total underlying the vault may hold. Zero means uncapped, which is
   * the default for every newly deployed vault.
   * @return The cap in underlying, or 0 if there is none.
   */
  function depositCap() public view returns (uint256) {
    return getUint256(_DEPOSIT_CAP_SLOT);
  }

  /**
   * @notice Sets the deposit cap, denominated in the underlying asset. Effective
   * immediately, with no timelock. A cap of 0 disables it.
   * @dev Setting a cap below current TVL does not force anything out; it only stops
   * further deposits until TVL falls back under the cap.
   * @param cap Maximum total underlying the vault may hold; 0 disables the cap.
   */
  function setDepositCap(uint256 cap) external onlyGovernance {
    emit DepositCapChanged(depositCap(), cap);
    setUint256(_DEPOSIT_CAP_SLOT, cap);
  }

  /**
   * @notice Remaining capacity under the deposit cap.
   * @dev Reports the real limit so an ERC-4626 integrator sizing a deposit from this
   * value is not handed `type(uint256).max` and then reverted by the cap. Slightly
   * conservative in one direction only: TVL can grow between this call and the deposit,
   * so a deposit of exactly this size may still be rejected. Exact when uncapped.
   * @return Remaining depositable underlying, or `type(uint256).max` if uncapped.
   */
  function maxDeposit(address /*caller*/) public view override returns (uint256) {
    uint256 cap = depositCap();
    if (cap == 0) return type(uint256).max;
    uint256 tvl = totalAssets();
    return cap > tvl ? cap - tvl : 0;
  }

  /**
   * @notice Shares mintable under the deposit cap.
   * @param _caller Address that would mint.
   * @return Mintable shares, or `type(uint256).max` if uncapped.
   */
  function maxMint(address _caller) public view override returns (uint256) {
    if (depositCap() == 0) return type(uint256).max;
    return convertToShares(maxDeposit(_caller));
  }

  /**
   * @notice Deposits underlying assets and mints shares, enforcing the deposit cap.
   * @dev A thin wrapper: the cap is checked against pre-deposit TVL plus this deposit,
   * before `VaultV1._deposit` pulls any funds. Uncapped vaults reach `super` after one
   * storage read.
   * @param amount Amount of underlying assets to deposit.
   * @param sender Address providing the assets.
   * @param beneficiary Address to receive the shares.
   * @return Amount of shares minted.
   */
  function _deposit(uint256 amount, address sender, address beneficiary) internal virtual override returns (uint256) {
    uint256 cap = depositCap();
    require(cap == 0 || underlyingBalanceWithInvestment().add(amount) <= cap, "Deposit cap reached");
    return super._deposit(amount, sender, beneficiary);
  }

  /**
   * @notice Runs the withdrawal-side hard work for the current strategy.
   * @dev Uses {IHardWorkHooks-doHardWorkOnWithdraw} when the strategy supports it,
   * otherwise falls back to `IStrategy.doHardWork()`.
   */
  function _hardWorkOnWithdraw() internal {
    address _strategy = strategy();
    if (_supportsHardWorkHooks(_strategy)) {
      IHardWorkHooks(_strategy).doHardWorkOnWithdraw();
    } else {
      IStrategy(_strategy).doHardWork();
    }
  }

  /**
   * @notice Whether the strategy implements the optional hard work hooks.
   * @dev A plain staticcall: a strategy without the function reverts, which reads as
   * "not supported". Deliberately does not treat a revert as an error - that is the
   * signal. Requires an exact 32-byte `true` so a proxy fallback returning empty or
   * arbitrary data cannot be mistaken for support.
   * @param _strategy Address of the strategy to probe.
   * @return True if the hook is implemented and should be used.
   */
  function _supportsHardWorkHooks(address _strategy) internal view returns (bool) {
    (bool success, bytes memory data) = _strategy.staticcall(
      abi.encodeWithSelector(IHardWorkHooks.supportsHardWorkHooks.selector)
    );
    if (!success || data.length != 32) {
      return false;
    }
    // Compared as uint256 against the canonical encoding of `true`. Decoding as a bool
    // would panic on a word that is neither 0 nor 1, taking the withdrawal down with it;
    // anything that is not exactly `true` should simply read as "not supported" and fall
    // back to doHardWork(), which is what a stock VaultV2 does anyway.
    return abi.decode(data, (uint256)) == 1;
  }

  /**
   * @notice Burns shares and returns underlying assets, using the strategy's
   * withdrawal-safe hard work when it offers one.
   * @dev Identical to `VaultV1._withdraw` apart from the hard work call.
   * @param numberOfShares Amount of shares to redeem.
   * @param receiver Address to receive the underlying assets.
   * @param owner Address holding the shares to redeem.
   * @return Amount of underlying assets received.
   */
  function _withdraw(uint256 numberOfShares, address receiver, address owner) internal virtual override returns (uint256) {
    require(totalSupply() > 0, "Vault has no shares");
    require(numberOfShares > 0, "numberOfShares must be greater than 0");
    uint256 totalSupply = totalSupply();

    address sender = msg.sender;
    if (sender != owner) {
      uint256 currentAllowance = allowance(owner, sender);
      if (currentAllowance != type(uint256).max) {
        require(currentAllowance >= numberOfShares, "ERC20: transfer amount exceeds allowance");
        _approve(owner, sender, currentAllowance - numberOfShares);
      }
    }
    _burn(owner, numberOfShares);

    if (compoundOnWithdraw()) {
      _hardWorkOnWithdraw();
    }

    uint256 underlyingAmountToWithdraw = underlyingBalanceWithInvestment()
        .mul(numberOfShares)
        .div(totalSupply);
    if (underlyingAmountToWithdraw > underlyingBalanceInVault()) {
      if (numberOfShares == totalSupply) {
        IStrategy(strategy()).withdrawAllToVault();
      } else {
        uint256 missing = underlyingAmountToWithdraw.sub(underlyingBalanceInVault());
        IStrategy(strategy()).withdrawToVault(missing);
      }
      underlyingAmountToWithdraw = MathUpgradeable.min(underlyingBalanceWithInvestment()
          .mul(numberOfShares)
          .div(totalSupply), underlyingBalanceInVault());
    }

    IERC20Upgradeable(underlying()).safeTransfer(receiver, underlyingAmountToWithdraw);
    emit IERC4626.Withdraw(sender, receiver, owner, underlyingAmountToWithdraw, numberOfShares);
    return underlyingAmountToWithdraw;
  }
}
