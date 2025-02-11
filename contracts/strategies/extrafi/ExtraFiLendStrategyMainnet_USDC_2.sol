//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./ExtraFiLendStrategy.sol";

contract ExtraFiLendStrategyMainnet_USDC_2 is ExtraFiLendStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address market = address(0xBB505c54D71E9e599cB8435b4F0cEEc05fC71cbD);
    address rewards = address(0xE61662C09c30E1F3f3CbAeb9BC1F13838Ed18957);
    address extra = address(0x2dAD3a13ef0C6366220f989157009e501e7938F8);
    ExtraFiLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      market,
      25,
      rewards,
      extra
    );
    rewardTokens = [extra];
  }
}