//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./SeamlessFoldStrategy.sol";

contract SeamlessFoldStrategyMainnet_cbETH is SeamlessFoldStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22);
    address aToken = address(0x2c159A183d9056E29649Ce7E56E59cA833D32624);
    address debtToken = address(0x72Dbdbe3423cdA5e92A3cC8ba9BFD41F67EE9168);
    address seam = address(0x1C7a460413dD4e964f96D8dFC56E7223cE88CD85);
    SeamlessFoldStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      aToken,
      debtToken,
      seam,
      630,
      650,
      1000,
      true
    );
    rewardTokens = [seam];
  }
}