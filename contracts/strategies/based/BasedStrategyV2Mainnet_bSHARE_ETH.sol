//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./BasedStrategyV2.sol";

contract BasedStrategyV2Mainnet_bSHARE_ETH is BasedStrategyV2 {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xbE23ce31C665225E27521D3d7DB9Bb7E5A76aeb8);
    address rewardPool = address(0x227F33775f1320959bAA17280310Fab9ACc4Aa6C);
    address bShare = address(0xD0A96c9b21565a7B73d006C02E56E09438b51C1B);
    address weth = address(0x4200000000000000000000000000000000000006);
    BasedStrategyV2.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      rewardPool,
      weth,
      1
    );
    rewardTokens = [bShare];
  }
}
