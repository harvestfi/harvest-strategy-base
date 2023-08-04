//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./BalancerStrategy.sol";

contract BalancerStrategyMainnet_DAI_USDC_WETH is BalancerStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x2Db50a0e0310723EF0C2a165CB9A9f80D772ba2F);
    address usdc = address(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA);
    address usdc_dai = address(0x6FbFcf88DB1aADA31F34215b2a1Df7fafb4883e9);
    address bal = address(0x7c6b91D9Be155A6Db01f749217d76fF02A7227F2);
    address gauge = address(0x7733650c7aaF2074FD1fCf98f70cbC09138E1Ea5);
    BalancerStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      address(0xBA12222222228d8Ba445958a75a0704d566BF2C8), //balancer vault
      0x2db50a0e0310723ef0c2a165cb9a9f80d772ba2f00020000000000000000000d,  // Pool id
      usdc_dai   //depositToken
    );
    rewardTokens = [bal, usdc];
    _setRewardToken(usdc);
  }
}
