//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./MoonwellFoldStrategyV2.sol";

contract MoonwellFoldStrategyV2Mainnet_MORPHO is MoonwellFoldStrategyV2 {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842);
    address mToken = address(0x6308204872BdB7432dF97b04B42443c714904F3E);
    address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
    address well = address(0xA88594D404727625A9437C3f886C7643872296AE);
    MoonwellFoldStrategyV2.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      mToken,
      comptroller,
      well,
      630,
      650,
      true
    );
    rewardTokens = [well];
  }
}