//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./MorphoVaultStrategy.sol";

contract MorphoVaultStrategyMainnet_SE_USDC is MorphoVaultStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address morphoVault = address(0x616a4E1db48e22028f6bbf20444Cd3b8e3273738);
    address weth = address(0x4200000000000000000000000000000000000006);
    address seam = address(0x1C7a460413dD4e964f96D8dFC56E7223cE88CD85);
    address morpho = address(0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842);
    MorphoVaultStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      morphoVault,
      weth
    );
    rewardTokens = [seam, morpho];
  }
}
