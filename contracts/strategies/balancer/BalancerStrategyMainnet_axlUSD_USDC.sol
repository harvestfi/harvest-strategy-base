//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./BalancerStrategy.sol";

contract BalancerStrategyMainnet_axlUSD_USDC is BalancerStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xE58cA65f418D4121d6C70d4C133E60cf6fDa363C);
    address usdc = address(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA);
    address bal = address(0x7c6b91D9Be155A6Db01f749217d76fF02A7227F2);
    address gauge = address(0x05257970368Efd323aeFfeC95F7e28C806c2e37F);
    BalancerStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      address(0xBA12222222228d8Ba445958a75a0704d566BF2C8), //balancer vault
      0xe58ca65f418d4121d6c70d4c133e60cf6fda363c000000000000000000000013,  // Pool id
      underlying   //depositToken
    );
    rewardTokens = [bal, usdc];
    _setRewardToken(usdc);
  }
}
