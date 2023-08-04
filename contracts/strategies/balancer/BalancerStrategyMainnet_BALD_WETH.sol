//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./BalancerStrategy.sol";

contract BalancerStrategyMainnet_BALD_WETH is BalancerStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x868F0Efc81A6c1DF16298Dcc82f7926B9099946B);
    address usdc = address(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA);
    address bal = address(0x7c6b91D9Be155A6Db01f749217d76fF02A7227F2);
    address gauge = address(0x544BDCE27174EA8Ba829939bd3568efc6A6c9c53);
    BalancerStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      address(0xBA12222222228d8Ba445958a75a0704d566BF2C8), //balancer vault
      0x868f0efc81a6c1df16298dcc82f7926b9099946b00020000000000000000000b,  // Pool id
      weth   //depositToken
    );
    rewardTokens = [bal, usdc];
  }
}
