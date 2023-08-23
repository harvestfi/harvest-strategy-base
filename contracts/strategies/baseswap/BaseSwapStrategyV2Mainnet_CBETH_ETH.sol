//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./BaseSwapStrategyV2.sol";

contract BaseSwapStrategyV2Mainnet_CBETH_ETH is BaseSwapStrategyV2 {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x07CFA5Df24fB17486AF0CBf6C910F24253a674D3);
    address nftPool = address(0x858a8B8143F8A510f663F8EeF31D9bF1Fb4d986F);
    BaseSwapStrategyV2.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      nftPool
    );
    rewardTokens = [bswap, bsx];
  }
}
