//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./ExtraFiLendStrategy.sol";

contract ExtraFiLendStrategyMainnet_VIRTUAL is ExtraFiLendStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b);
    address market = address(0xBB505c54D71E9e599cB8435b4F0cEEc05fC71cbD);
    address rewards = address(0xF510c4EE0F5060F384865761B2452EF0d2E5821E);
    address extra = address(0x2dAD3a13ef0C6366220f989157009e501e7938F8);
    ExtraFiLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      market,
      44,
      rewards,
      extra
    );
    rewardTokens = [extra];
  }
}