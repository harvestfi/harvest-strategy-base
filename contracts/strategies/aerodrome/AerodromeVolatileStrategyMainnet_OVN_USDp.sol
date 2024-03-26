//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_OVN_USDp is AerodromeVolatileStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x61366A4e6b1DB1b85DD701f2f4BFa275EF271197);
    address gauge = address(0x00B2149d89677a5069eD4D303941614A33700146);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    address ovn = address(0xA3d1a8DEB97B111454B294E2324EfAD13a9d8396);
    address usdp = address(0xB79DD08EA68A908A97220C76d19A6aA9cBDE4376);
    AerodromeVolatileStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      aero
    );
    rewardTokens = [aero, ovn, usdp];
  }
}
