//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./MoonwellFoldStrategyV2.sol";

contract MoonwellFoldStrategyV2Mainnet_tBTC is MoonwellFoldStrategyV2 {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b);
    address mToken = address(0x9A858ebfF1bEb0D3495BB0e2897c1528eD84A218);
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
      809,
      false
    );
    rewardTokens = [well];
  }
}