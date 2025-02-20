//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./CurveStrategy.sol";

contract CurveStrategyMainnet_tricrypto is CurveStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x6e53131F68a034873b6bFA15502aF094Ef0c5854);
    address gauge = address(0x93933FA992927284e9d508339153B31eb871e1f4);
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
      0,
      3
    );
    rewardTokens = [crv];
  }
}
