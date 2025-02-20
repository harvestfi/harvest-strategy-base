//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./MoonwellFoldStrategy.sol";

contract MoonwellFoldStrategyMainnet_CBETH is MoonwellFoldStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22);
    address mToken = address(0x3bf93770f2d4a794c3d9EBEfBAeBAE2a8f09A5E5);
    address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
    address well = address(0xFF8adeC2221f9f4D8dfbAFa6B9a297d17603493D);
    MoonwellFoldStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      mToken,
      comptroller,
      well,
      710,
      730,
      1000,
      true
    );
  }
}