//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./EulerLendStrategy.sol";

contract EulerLendStrategyMainnet_cbBTC_YO is EulerLendStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf);
    address eulerVault = address(0xe72eA97aAF905c5f10040f78887cc8dE8eAec7E4);
    address weth = address(0x4200000000000000000000000000000000000006);
    EulerLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      eulerVault,
      weth
    );
  }
}