//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./EulerLendStrategy.sol";

contract EulerLendStrategyMainnet_ETH_CSF is EulerLendStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4200000000000000000000000000000000000006);
    address eulerVault = address(0xDc4eFB20ce286B421F6361734a2A006a1f24Af8D);
    address farm = address(0xD08a2917653d4E460893203471f0000826fb4034);
    address usdc = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    EulerLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      eulerVault,
      farm
    );
    rewardTokens.push(usdc);
  }
}