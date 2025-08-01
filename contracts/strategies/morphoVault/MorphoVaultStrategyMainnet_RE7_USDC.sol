//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./MorphoVaultStrategy.sol";

contract MorphoVaultStrategyMainnet_RE7_USDC is MorphoVaultStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address morphoVault = address(0x12AFDeFb2237a5963e7BAb3e2D46ad0eee70406e);
    address weth = address(0x4200000000000000000000000000000000000006);
    address morpho = address(0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842);
    address morphoPrePay = address(0x1E905e572100134aFeEe01E88703cdbb0AdAF62c);
    MorphoVaultStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      morphoVault,
      weth,
      morphoPrePay
    );
    rewardTokens = [morpho];
  }

  function finalizeUpgrade() external override onlyGovernance {
    address morpho = address(0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842);
    rewardTokens = [morpho];
    distributionTime[morpho] = 43200;
    _finalizeUpgrade();
  }
}
