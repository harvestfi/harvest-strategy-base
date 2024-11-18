//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./ExtraFiLendStrategy.sol";

contract ExtraFiLendStrategyMainnet_cbBTC is ExtraFiLendStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf);
    address market = address(0xBB505c54D71E9e599cB8435b4F0cEEc05fC71cbD);
    address rewards = address(0x5e322a2521d06F0BD98271943E522245303B646F);
    address extra = address(0x2dAD3a13ef0C6366220f989157009e501e7938F8);
    ExtraFiLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      market,
      76,
      rewards,
      extra
    );
    rewardTokens = [extra];
  }
}