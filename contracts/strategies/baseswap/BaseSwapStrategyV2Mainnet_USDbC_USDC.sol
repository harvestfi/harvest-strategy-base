//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./BaseSwapStrategyV2.sol";

contract BaseSwapStrategyV2Mainnet_USDbC_USDC is BaseSwapStrategyV2 {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xC52328d5Af54A12DA68459Ffc6D0845e91a8395F);
    address nftPool = address(0xD239824786D69627bc048Ee258943F2096Cf2Ab7);
    address _xBSXVault = address(0x40455352Dd3c5D65A40729C22B12265C17B37b75);
    BaseSwapStrategyV2.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      nftPool,
      _xBSXVault,
      address(0)
    );
    rewardTokens = [bswap, bsx];
  }
}
