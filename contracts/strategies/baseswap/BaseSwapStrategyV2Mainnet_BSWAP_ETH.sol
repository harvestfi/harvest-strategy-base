//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./BaseSwapStrategyV2.sol";

contract BaseSwapStrategyV2Mainnet_BSWAP_ETH is BaseSwapStrategyV2 {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xE80B4F755417FB4baF4dbd23C029db3F62786523);
    address nftPool = address(0xaA93C2eFD8fcC07c723E19A6e78eF5d2644BF391);
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
