//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./BaseSwapStrategyV2.sol";

contract BaseSwapStrategyV2Mainnet_ETH_USDC is BaseSwapStrategyV2 {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x41d160033C222E6f3722EC97379867324567d883);
    address nftPool = address(0x34688C3E5AAD119851D5dc6AEb01Bf6DEA746eE7);
    BaseSwapStrategyV2.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      nftPool
    );
    rewardTokens = [bswap, bsx];
  }
}
