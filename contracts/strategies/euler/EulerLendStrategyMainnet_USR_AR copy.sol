//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./EulerLendStrategy.sol";

contract EulerLendStrategyMainnet_USR_AR is EulerLendStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x35E5dB674D8e93a03d814FA0ADa70731efe8a4b9);
    address eulerVault = address(0x29Dbce367F5157B924Af5093617bb128477D7A5C);
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