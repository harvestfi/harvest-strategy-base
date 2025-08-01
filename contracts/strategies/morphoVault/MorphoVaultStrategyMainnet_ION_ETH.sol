//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./MorphoVaultStrategy.sol";

contract MorphoVaultStrategyMainnet_ION_ETH is MorphoVaultStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4200000000000000000000000000000000000006);
    address morphoVault = address(0x5A32099837D89E3a794a44fb131CBbAD41f87a8C);
    address usdc = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address ion = address(0x3eE5e23eEE121094f1cFc0Ccc79d6C809Ebd22e5);
    address morpho = address(0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842);
    address morphoPrePay = address(0x85DEf13cAfe6AFB1D810203324b7169040968843);
    MorphoVaultStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      morphoVault,
      usdc,
      morphoPrePay
    );
    rewardTokens = [morpho, ion];
  }

  function finalizeUpgrade() external override onlyGovernance {
    address ion = address(0x3eE5e23eEE121094f1cFc0Ccc79d6C809Ebd22e5);
    address extra = address(0x2dAD3a13ef0C6366220f989157009e501e7938F8);
    address morpho = address(0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842);
    rewardTokens = [morpho, ion, extra];
    distributionTime[ion] = 43200;
    distributionTime[extra] = 43200;
    distributionTime[morpho] = 43200;
    _finalizeUpgrade();
  }
}
