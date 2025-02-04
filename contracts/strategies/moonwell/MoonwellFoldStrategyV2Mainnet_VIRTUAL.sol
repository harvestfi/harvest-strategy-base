//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./MoonwellFoldStrategyV2.sol";

contract MoonwellFoldStrategyV2Mainnet_VIRTUAL is MoonwellFoldStrategyV2 {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b);
    address mToken = address(0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64);
    address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
    address well = address(0xA88594D404727625A9437C3f886C7643872296AE);
    MoonwellFoldStrategyV2.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      mToken,
      comptroller,
      well,
      0,
      649,
      false
    );
    rewardTokens = [well];
  }
}