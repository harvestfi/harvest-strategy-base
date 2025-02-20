//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./MorphoVaultStrategy.sol";

contract MorphoVaultStrategyMainnet_MW_EURC is MorphoVaultStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42);
    address morphoVault = address(0xf24608E0CCb972b0b0f4A6446a0BBf58c701a026);
    address weth = address(0x4200000000000000000000000000000000000006);
    address well = address(0xA88594D404727625A9437C3f886C7643872296AE);
    address morpho = address(0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842);
    MorphoVaultStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      morphoVault,
      weth
    );
    rewardTokens = [well, morpho];
  }
}
