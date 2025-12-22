//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./MorphoMarketStrategy.sol";

contract MorphoMarketStrategyMainnet_USDC_wstETH is MorphoMarketStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address weth = address(0x4200000000000000000000000000000000000006);
    address morpho = address(0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842);
    MorphoMarketStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      weth,
      0x13c42741a359ac4a8aa8287d2be109dcf28344484f91185f9a79bd5a805a55ae
    );
    rewardTokens = [morpho];
    distributionTime[morpho] = 86400;
  }
}
