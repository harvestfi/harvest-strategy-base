//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./BasedStrategyV2.sol";

contract BasedStrategyMainnet_BASED_ETH_mock is BasedStrategyV2 {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xF4ecEbFe039e4bce40226663F54F8d1Edce80B2b);
    address rewardPool = address(0x87adb70b11C528EA63bD66E4291fC91D9d59270C);
    address bShare = address(0x8BE49607832a299FA33eE837038418ad0223333e);
    BasedStrategyV2.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      rewardPool,
      bShare,
      0
    );
    rewardTokens = [bShare];
  }
}
