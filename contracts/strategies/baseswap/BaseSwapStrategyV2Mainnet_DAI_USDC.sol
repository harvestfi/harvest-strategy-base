//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./BaseSwapStrategyV2.sol";

contract BaseSwapStrategyV2Mainnet_DAI_USDC is BaseSwapStrategyV2 {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x6D3c5a4a7aC4B1428368310E4EC3bB1350d01455);
    address nftPool = address(0xEC652B590Fe21dcd18Ea01253B5152b202cc3dEb);
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
