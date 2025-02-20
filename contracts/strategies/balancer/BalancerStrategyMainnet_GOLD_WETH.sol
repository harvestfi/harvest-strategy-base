//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./BalancerStrategy.sol";

contract BalancerStrategyMainnet_GOLD_WETH is BalancerStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xE40cBcCba664C7B1a953827C062F5070B78de868);
    address bal = address(0x7c6b91D9Be155A6Db01f749217d76fF02A7227F2);
    address gold = address(0xbeFD5C25A59ef2C1316c5A4944931171F30Cd3E4);
    address gauge = address(0xe2f2AED19fa245AFf66342c2b849BE6f411fB28f);
    BalancerStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      address(0xBA12222222228d8Ba445958a75a0704d566BF2C8), //balancer vault
      0xe40cbccba664c7b1a953827c062f5070b78de86800020000000000000000001b,  // Pool id
      weth   //depositToken
    );
    rewardTokens = [bal, gold, weth];
  }
}
