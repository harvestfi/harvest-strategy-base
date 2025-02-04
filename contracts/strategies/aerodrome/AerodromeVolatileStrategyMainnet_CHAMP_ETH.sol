//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_CHAMP_ETH is AerodromeVolatileStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x26029Ed89A19B919b5698F10cf776a4f4AEA1529);
    address gauge = address(0xf2c38dE50A250C0060fB45eBE4504B67f6F1be3C);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    AerodromeVolatileStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      aero
    );
    rewardTokens = [aero];
  }
}
