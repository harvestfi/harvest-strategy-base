//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_VIRTUAL_ETH is AerodromeVolatileStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x21594b992F68495dD28d605834b58889d0a727c7);
    address gauge = address(0xBD62Cad65b49b4Ad9C7aa9b8bDB89d63221F7af5);
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
