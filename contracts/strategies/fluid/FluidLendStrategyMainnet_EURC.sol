//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./FluidLendStrategy.sol";

contract FluidLendStrategyMainnet_EURC is FluidLendStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42);
    address fToken = address(0x1943FA26360f038230442525Cf1B9125b5DCB401);
    address weth = address(0x4200000000000000000000000000000000000006);
    FluidLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      fToken,
      weth
    );
  }
}