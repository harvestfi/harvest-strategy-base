//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./MorphoVaultStrategy.sol";

contract MorphoVaultStrategyMainnet_CR_ETH is MorphoVaultStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4200000000000000000000000000000000000006);
    address morphoVault = address(0x09832347586E238841F49149C84d121Bc2191C53);
    address usdc = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address morpho = address(0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842);
    address yoeth = address(0x3A43AEC53490CB9Fa922847385D82fe25d0E9De7);
    address morphoPrePay = address(0x1E905e572100134aFeEe01E88703cdbb0AdAF62c);
    MorphoVaultStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      morphoVault,
      usdc,
      morphoPrePay
    );
    rewardTokens = [morpho, yoeth];
    distributionTime[yoeth] = 43200;
    distributionTime[morpho] = 43200;
  }
}
