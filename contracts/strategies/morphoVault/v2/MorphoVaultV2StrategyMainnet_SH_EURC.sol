//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./MorphoVaultV2Strategy.sol";

contract MorphoVaultStrategyMainnet_SH_EURC_V2 is MorphoVaultV2Strategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42);
    address morphoVault = address(0xbeef009F28cCf367444a9F79096862920e025DC1);
    address weth = address(0x4200000000000000000000000000000000000006);
    address morpho = address(0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842);
    MorphoVaultV2Strategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      morphoVault,
      weth
    );
    rewardTokens = [morpho];
    _setDistributionTime(morpho, 172_800); // 48 hours
  }
}
