//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./MoonwellFoldStrategyV2.sol";

contract MoonwellFoldStrategyV2Mainnet_cbBTC is MoonwellFoldStrategyV2 {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf);
    address mToken = address(0xF877ACaFA28c19b96727966690b2f44d35aD5976);
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
      810,
      false
    );
    rewardTokens = [well];
  }
}