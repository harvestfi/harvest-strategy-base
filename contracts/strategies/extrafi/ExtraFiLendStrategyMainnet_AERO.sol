//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./ExtraFiLendStrategy.sol";

contract ExtraFiLendStrategyMainnet_AERO is ExtraFiLendStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    address market = address(0xBB505c54D71E9e599cB8435b4F0cEEc05fC71cbD);
    address rewards = address(0x8f480b12B321dac9D5427aAD8F3e560fca2b3216);
    address extra = address(0x2dAD3a13ef0C6366220f989157009e501e7938F8);
    ExtraFiLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      market,
      3,
      rewards,
      extra
    );
    rewardTokens = [extra];
  }
}