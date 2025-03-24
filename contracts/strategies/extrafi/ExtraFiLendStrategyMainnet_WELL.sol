//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./ExtraFiLendStrategy.sol";

contract ExtraFiLendStrategyMainnet_WELL is ExtraFiLendStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xA88594D404727625A9437C3f886C7643872296AE);
    address market = address(0xBB505c54D71E9e599cB8435b4F0cEEc05fC71cbD);
    address rewards = address(0xDFe1738AD66b7438C6EB8C1Df5900a6E836feF48);
    address extra = address(0x2dAD3a13ef0C6366220f989157009e501e7938F8);
    ExtraFiLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      market,
      54,
      rewards,
      extra
    );
    rewardTokens = [extra];
  }
}