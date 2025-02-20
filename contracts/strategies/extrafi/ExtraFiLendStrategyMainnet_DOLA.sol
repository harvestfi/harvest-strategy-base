//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./ExtraFiLendStrategy.sol";

contract ExtraFiLendStrategyMainnet_DOLA is ExtraFiLendStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4621b7A9c75199271F773Ebd9A499dbd165c3191);
    address market = address(0xBB505c54D71E9e599cB8435b4F0cEEc05fC71cbD);
    address rewards = address(0x79a5a9e97Dc8f4a1c2370E1049dB960275431793);
    address extra = address(0x2dAD3a13ef0C6366220f989157009e501e7938F8);
    ExtraFiLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      market,
      12,
      rewards,
      extra
    );
    rewardTokens = [extra];
  }
}