//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./MorphoVaultStrategy.sol";

contract MorphoVaultStrategyMainnet_SH_ETH is MorphoVaultStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4200000000000000000000000000000000000006);
    address morphoVault = address(0xbEEf050a7485865A7a8d8Ca0CC5f7536b7a3443e);
    address usdc = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
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
    rewardTokens = [morpho];
  }
}
