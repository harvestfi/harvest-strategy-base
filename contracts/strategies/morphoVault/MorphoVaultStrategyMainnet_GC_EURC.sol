//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./MorphoVaultStrategy.sol";

contract MorphoVaultStrategyMainnet_GC_EURC is MorphoVaultStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42);
    address morphoVault = address(0x1c155be6bC51F2c37d472d4C2Eba7a637806e122);
    address weth = address(0x4200000000000000000000000000000000000006);
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
    rewardTokens = [morpho];
  }

  function finalizeUpgrade() external override onlyGovernance {
    address morpho = address(0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842);
    rewardTokens = [morpho];
    distributionTime[morpho] = 43200;
    _finalizeUpgrade();
  }
}
