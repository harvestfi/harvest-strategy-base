//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./CurveStrategy.sol";

contract CurveStrategyMainnet_CRV_crvUSD is CurveStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x6DfE79cecE4f64c1a34F48cF5802492aB595257E);
    address gauge = address(0x89289DC2192914a9F0674f1E9A17C56456549b8A);
    address crv = address(0x8Ee73c484A26e0A5df2Ee2a4960B789967dd0415);
    address depositPool = address(0xDE37E221442Fa15C35dc19FbAE11Ed106ba52fB2);
    CurveStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      crv,
      crv,
      depositPool,
      0,
      2
    );
    rewardTokens = [crv];
  }
}
