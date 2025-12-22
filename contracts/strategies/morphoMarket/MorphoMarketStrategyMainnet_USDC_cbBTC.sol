//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./MorphoMarketStrategy.sol";

contract MorphoMarketStrategyMainnet_USDC_cbBTC is MorphoMarketStrategy {

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
      0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836
    );
    rewardTokens = [morpho];
    distributionTime[morpho] = 86400;
  }
}
