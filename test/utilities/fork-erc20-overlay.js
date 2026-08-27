const { ethers, network } = require("hardhat");
const BigNumber = require("bignumber.js");
const Overlay = artifacts.require("ForkERC20Overlay");

// The tokenised-equity assets behind IPOR's carry-trade vaults carry a single byte of
// code (0xef) and keep no EVM storage — Base's node executes them natively, so on a fork
// every call reverts with `invalid opcode` and every balance reads as zero.
//
// This puts a plain ERC20 at the token's address and seeds it. The PlasmaVault under test
// stays the real one: its shares, its fuses and its redemption delay (which lives in the
// access manager, not the token) are untouched.
//
// `assetsInVault` should be the PlasmaVault's live totalAssets, so the share price the
// test sees matches production. Whatever the vault already prices from its non-token legs
// is subtracted, so the total lands on that figure rather than overshooting it.
async function installTokenOverlay({ token, plasmaVault, name, symbol, decimals, assetsInVault, farmer, farmerBalance }) {
  const template = await Overlay.new();
  await network.provider.send("hardhat_setCode", [token, await ethers.provider.getCode(template.address)]);

  const overlay = await Overlay.at(token);
  await overlay.initOverlay(name, symbol, decimals);

  const pv = await ethers.getContractAt(["function totalAssets() view returns (uint256)"], plasmaVault);
  const residual = new BigNumber((await pv.totalAssets()).toString());
  const toMint = new BigNumber(assetsInVault).minus(residual);
  if (toMint.gt(0)) {
    await overlay.mint(plasmaVault, toMint.toFixed(0));
  }
  if (farmer) {
    await overlay.mint(farmer, farmerBalance);
  }
  return overlay;
}

module.exports = { installTokenOverlay };
