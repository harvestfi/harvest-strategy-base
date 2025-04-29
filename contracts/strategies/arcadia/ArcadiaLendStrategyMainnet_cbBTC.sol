//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./ArcadiaLendStrategy.sol";

contract ArcadiaLendStrategyMainnet_cbBTC is ArcadiaLendStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf);
    address fToken = address(0x9c63A4c499B323a25D389Da759c2ac1e385eEc92);
    address weth = address(0x4200000000000000000000000000000000000006);
    ArcadiaLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      fToken,
      weth
    );
  }
}