// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IFoldNavVault {
  function totalAssets() external view returns (uint256);
}

interface IFoldNavStrategy {
  function preInteract() external;
  function storedBalance() external view returns (uint256);
  function pendingFee() external view returns (uint256);
  function underlying() external view returns (address);
  function supplyAsset() external view returns (address);
}

interface IFoldNavViewer {
  function getPrice(address assetToken, address quoteToken) external view returns (uint256);
}

/**
 * Test-only. Its runtime code is placed (hardhat_setCode, inside a snapshot) at
 * the strategy's governance address, which the strategy's `restricted` modifier
 * accepts. One call then reads vault.totalAssets(), runs a REAL preInteract(),
 * and reads it again in the same transaction: same block, same accrued Aave
 * interest, same oracle price.
 */
contract FoldNavProbe {
  address internal constant VIEWER = address(0x1e51654aB193bA165b7F7715C734dAF454f08148);

  function probe(address vault, address strategy) external returns (
    uint256 assetsBefore,  // totalAssets() before preInteract: the value under test
    uint256 cachedBefore,  // the cached (pre-change) formula before preInteract
    uint256 assetsAfter,   // totalAssets() right after a real preInteract
    uint256 cachedAfter,   // the cached formula recomputed after preInteract
    uint256 feeBooked      // pendingFee booked by that preInteract
  ) {
    IFoldNavStrategy s = IFoldNavStrategy(strategy);
    uint256 fee0 = s.pendingFee();
    assetsBefore = IFoldNavVault(vault).totalAssets();
    cachedBefore = _cached(vault, s);
    s.preInteract();
    assetsAfter = IFoldNavVault(vault).totalAssets();
    cachedAfter = _cached(vault, s);
    feeBooked = s.pendingFee() - fee0;
  }

  // Vault idle underlying + the pre-change investedUnderlyingBalance():
  // idle underlying + idle collateral at the oracle + storedBalance - pendingFee.
  function _cached(address vault, IFoldNavStrategy s) internal view returns (uint256) {
    address u = s.underlying();
    address c = s.supplyAsset();
    uint256 idleC = IERC20(c).balanceOf(address(s));
    if (idleC > 0) {
      idleC = (idleC * IFoldNavViewer(VIEWER).getPrice(c, u)) / 1e18;
    }
    return IERC20(u).balanceOf(vault) + IERC20(u).balanceOf(address(s)) + idleC
      + s.storedBalance() - s.pendingFee();
  }
}
