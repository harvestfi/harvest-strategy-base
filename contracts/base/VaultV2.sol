// SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./interface/IERC4626.sol";
import "./VaultV1.sol";

/**
 * @title VaultV2
 * @dev An ERC-4626 compliant vault inheriting from `VaultV1`. Adds ERC-4626 standard methods for asset and share conversions,
 * along with support for deposit, mint, withdraw, and redeem operations.
 */
contract VaultV2 is IERC4626, VaultV1 {

    /// @notice Constant used for decimal conversions, initialized to `10` as a `uint256`.
    uint256 public constant TEN = 10;

    /**
     * @notice Returns the underlying asset address.
     * @return Address of the underlying asset.
     */
    function asset() public view override returns (address) {
        return underlying();
    }

    /**
     * @notice Returns the total assets managed by the vault, including invested assets.
     * @return Total assets in the vault.
     */
    function totalAssets() public view override returns (uint256) {
        return underlyingBalanceWithInvestment();
    }

    /**
     * @notice Calculates the value of one share in terms of the underlying asset.
     * @return Value of one share in underlying assets.
     */
    function assetsPerShare() public view override returns (uint256) {
        return convertToAssets(TEN ** decimals());
    }

    /**
     * @notice Returns the total assets owned by a specific depositor.
     * @param _depositor Address of the depositor.
     * @return Total assets of the depositor.
     */
    function assetsOf(address _depositor) public view override returns (uint256) {
        return totalAssets() * balanceOf(_depositor) / totalSupply();
    }

    /**
     * @notice Returns the maximum amount of assets that can be deposited by the caller.
     * @return Maximum deposit limit as `uint(-1)` (no limit).
     */
    function maxDeposit(address /*caller*/) public view override returns (uint256) {
        return uint(-1);
    }

    /**
     * @notice Provides an estimate of shares that will be minted for a given asset deposit.
     * @param _assets Amount of assets to deposit.
     * @return Estimated number of shares to be minted.
     */
    function previewDeposit(uint256 _assets) public view override returns (uint256) {
        return convertToShares(_assets);
    }

    /**
     * @notice Deposits assets in the vault and mints shares to the receiver.
     * @param _assets Amount of assets to deposit.
     * @param _receiver Address that will receive the minted shares.
     * @return Number of shares minted.
     */
    function deposit(uint256 _assets, address _receiver) public override nonReentrant defense returns (uint256) {
        uint256 shares = _deposit(_assets, msg.sender, _receiver);
        return shares;
    }

    /**
     * @notice Returns the maximum amount of shares that can be minted by the caller.
     * @return Maximum mint limit as `uint(-1)` (no limit).
     */
    function maxMint(address /*caller*/) public view override returns (uint256) {
        return uint(-1);
    }

    /**
     * @notice Provides an estimate of assets required to mint a given amount of shares.
     * @param _shares Amount of shares to mint.
     * @return Estimated amount of assets needed.
     */
    function previewMint(uint256 _shares) public view override returns (uint256) {
        return convertToAssets(_shares);
    }

    /**
     * @notice Mints shares to the receiver by depositing the required amount of assets.
     * @param _shares Number of shares to mint.
     * @param _receiver Address that will receive the minted shares.
     * @return Amount of assets deposited.
     */
    function mint(uint256 _shares, address _receiver) public override nonReentrant defense returns (uint256) {
        uint assets = convertToAssets(_shares);
        _deposit(assets, msg.sender, _receiver);
        return assets;
    }

    /**
     * @notice Returns the maximum amount of assets that can be withdrawn by a caller.
     * @param _caller Address of the caller.
     * @return Maximum withdrawable asset amount.
     */
    function maxWithdraw(address _caller) public view override returns (uint256) {
        return assetsOf(_caller);
    }

    /**
     * @notice Provides an estimate of shares needed to withdraw a specified amount of assets.
     * @param _assets Amount of assets to withdraw.
     * @return Estimated shares required.
     */
    function previewWithdraw(uint256 _assets) public view override returns (uint256) {
        return convertToShares(_assets);
    }

    /**
     * @notice Withdraws assets from the vault by burning a proportional amount of shares.
     * @param _assets Amount of assets to withdraw.
     * @param _receiver Address to receive the withdrawn assets.
     * @param _owner Address of the share owner.
     * @return Number of shares burned.
     */
    function withdraw(
        uint256 _assets,
        address _receiver,
        address _owner
    ) public override nonReentrant defense returns (uint256) {
        uint256 shares = convertToShares(_assets);
        _withdraw(shares, _receiver, _owner);
        return shares;
    }

    /**
     * @notice Returns the maximum number of shares that can be redeemed by the caller.
     * @param _caller Address of the caller.
     * @return Maximum redeemable shares.
     */
    function maxRedeem(address _caller) public view override returns (uint256) {
        return balanceOf(_caller);
    }

    /**
     * @notice Provides an estimate of assets that would be returned for a specified amount of shares.
     * @param _shares Amount of shares to redeem.
     * @return Estimated amount of assets returned.
     */
    function previewRedeem(uint256 _shares) public view override returns (uint256) {
        return convertToAssets(_shares);
    }

    /**
     * @notice Redeems shares for assets and transfers the assets to the receiver.
     * @param _shares Number of shares to redeem.
     * @param _receiver Address to receive the redeemed assets.
     * @param _owner Address of the share owner.
     * @return Amount of assets transferred.
     */
    function redeem(
        uint256 _shares,
        address _receiver,
        address _owner
    ) public override nonReentrant defense returns (uint256) {
        uint256 assets = _withdraw(_shares, _receiver, _owner);
        return assets;
    }

    // ========================= Conversion Functions =========================

    /**
     * @notice Converts a given amount of shares to the equivalent amount of assets.
     * @param _shares Amount of shares to convert.
     * @return Equivalent amount of assets.
     */
    function convertToAssets(uint256 _shares) public view returns (uint256) {
        return totalAssets() == 0 || totalSupply() == 0
            ? _shares.mul(TEN ** ERC20Upgradeable(underlying()).decimals()).div(TEN ** decimals())
            : _shares.mul(totalAssets()).div(totalSupply());
    }

    /**
     * @notice Converts a given amount of assets to the equivalent amount of shares.
     * @param _assets Amount of assets to convert.
     * @return Equivalent amount of shares.
     */
    function convertToShares(uint256 _assets) public view returns (uint256) {
        return totalAssets() == 0 || totalSupply() == 0
            ? _assets.mul(TEN ** decimals()).div(TEN ** ERC20Upgradeable(underlying()).decimals())
            : _assets.mul(totalSupply()).div(totalAssets());
    }
}
