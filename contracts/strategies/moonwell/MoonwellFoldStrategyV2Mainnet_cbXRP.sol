//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./MoonwellFoldStrategyV2.sol";

contract MoonwellFoldStrategyV2Mainnet_cbXRP is MoonwellFoldStrategyV2 {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xcb585250f852C6c6bf90434AB21A00f02833a4af);
    address mToken = address(0xb4fb8fed5b3AaA8434f0B19b1b623d977e07e86d);
    address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
    address well = address(0xA88594D404727625A9437C3f886C7643872296AE);
    MoonwellFoldStrategyV2.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      mToken,
      comptroller,
      well,
      680,
      699,
      true
    );
    rewardTokens = [well];
  }
}