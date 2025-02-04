//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./MoonwellFoldStrategyV2.sol";

contract MoonwellFoldStrategyV2Mainnet_WELL is MoonwellFoldStrategyV2 {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xA88594D404727625A9437C3f886C7643872296AE);
    address mToken = address(0xdC7810B47eAAb250De623F0eE07764afa5F71ED1);
    address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
    address weth = address(0x4200000000000000000000000000000000000006);
    MoonwellFoldStrategyV2.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      mToken,
      comptroller,
      weth,
      630,
      649,
      true
    );
    rewardTokens = [weth];
  }
}