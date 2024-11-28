//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./AerodromeCLStrategy.sol";

contract AerodromeCLStrategyMainnet_superOETH_ETH1 is AerodromeCLStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address gauge = address(0xdD234DBe2efF53BED9E8fC0e427ebcd74ed4F429);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    AerodromeCLStrategy.initializeBaseStrategy(
      _storage,
      _vault,
      gauge,
      aero
    );
    rewardTokens = [aero];
  }
}
