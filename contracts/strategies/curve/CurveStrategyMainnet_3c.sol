//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./CurveStrategy.sol";

contract CurveStrategyMainnet_3c is CurveStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xA450487D8C8F355611EFF9553337BE67261Af26f);
    address gauge = address(0x6616CCfA456F72104452341fa470E9B08A11b1aB);
    address crv = address(0x8Ee73c484A26e0A5df2Ee2a4960B789967dd0415);
    address crvusd = address(0x417Ac0e078398C154EdFadD9Ef675d30Be60Af93);
    CurveStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      crv,
      crvusd,
      underlying,
      2,
      3
    );
    rewardTokens = [crv];
  }
}
