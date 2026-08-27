//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./GeneralERC4626Strategy.sol";

contract IPORLendingStrategyMainnet_AAPL is GeneralERC4626Strategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xb200000000000000000000C2e324d24d7eEcd1fb);
    address fToken = address(0x31744E44d6aF88225C1dBEFbe5Df8308fAeA641B);
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
