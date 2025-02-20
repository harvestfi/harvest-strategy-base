//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./MoonwellSupplyStrategy.sol";

contract MoonwellSupplyStrategyMainnet_AERO is MoonwellSupplyStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    address mToken = address(0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6);
    address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
    address well = address(0xA88594D404727625A9437C3f886C7643872296AE);
    MoonwellSupplyStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      mToken,
      comptroller,
      well
    );
    rewardTokens = [well];
  }
}