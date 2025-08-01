//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./MorphoVaultStrategy.sol";

contract MorphoVaultStrategyMainnet_MW_USDC is MorphoVaultStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address morphoVault = address(0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca);
    address weth = address(0x4200000000000000000000000000000000000006);
    address well = address(0xA88594D404727625A9437C3f886C7643872296AE);
    address morpho = address(0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842);
    address morphoPrePay = address(0x85DEf13cAfe6AFB1D810203324b7169040968843);
    MorphoVaultStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      morphoVault,
      weth,
      morphoPrePay
    );
    rewardTokens = [morpho, well];
  }

  function finalizeUpgrade() external override onlyGovernance {
    address morpho = address(0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842);
    address well = address(0xA88594D404727625A9437C3f886C7643872296AE);
    rewardTokens = [morpho, well];
    distributionTime[morpho] = 43200;
    distributionTime[well] = 43200 * 14;
    _finalizeUpgrade();
  }
}
