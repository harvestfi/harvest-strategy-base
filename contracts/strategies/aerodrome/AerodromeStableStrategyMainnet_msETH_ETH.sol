//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeStableStrategy.sol";

contract AerodromeStableStrategyMainnet_msETH_ETH is AerodromeStableStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xDE4FB30cCC2f1210FcE2c8aD66410C586C8D1f9A);
    address gauge = address(0x62940D9643a130b80CA0f8bc7e94De5b7ec496C5);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    AerodromeStableStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      aero
    );
    rewardTokens = [aero];
  }
}
