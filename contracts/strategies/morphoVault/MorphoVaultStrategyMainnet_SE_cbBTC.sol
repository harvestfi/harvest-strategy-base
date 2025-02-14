//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./MorphoVaultStrategy.sol";

contract MorphoVaultStrategyMainnet_SE_cbBTC is MorphoVaultStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf);
    address morphoVault = address(0x5a47C803488FE2BB0A0EAaf346b420e4dF22F3C7);
    address weth = address(0x4200000000000000000000000000000000000006);
    address seam = address(0x1C7a460413dD4e964f96D8dFC56E7223cE88CD85);
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
    rewardTokens = [morpho, seam];
  }
}
