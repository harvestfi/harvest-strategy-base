//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./BaseSwapStrategyV2.sol";

contract BaseSwapStrategyV2Mainnet_BSX_ETH is BaseSwapStrategyV2 {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x7fea0384F38EF6Ae79bB12295a9e10C464204F52);
    address nftPool = address(0x7C04bF2bb7D27982810E432B188FA0C7729e651d);
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
