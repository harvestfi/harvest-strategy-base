//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./GeneralERC4626Strategy.sol";

contract IPORLendingStrategyMainnet_NVDA is GeneralERC4626Strategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xb20000000000000000000078ee7ce2fE4908108C);
    address fToken = address(0xFb132f4C6d9DCF4f80483Ea7D96C5A5dccfcFE83);
    address weth = address(0x4200000000000000000000000000000000000006);
    GeneralERC4626Strategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      fToken,
      weth
    );
  }
}
