//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./CurveStrategy.sol";

contract CurveStrategyMainnet_CBETH_ETH is CurveStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x98244d93D42b42aB3E3A4D12A5dc0B3e7f8F32f9);
    address gauge = address(0xE9c898BA654deC2bA440392028D2e7A194E6dc3e);
    address crv = address(0x8Ee73c484A26e0A5df2Ee2a4960B789967dd0415);
    address weth = address(0x4200000000000000000000000000000000000006);
    address depositPool = address(0x11C1fBd4b3De66bC0565779b35171a6CF3E71f59);
    CurveStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      crv,
      weth,
      depositPool,
      0,
      2
    );
    rewardTokens = [crv];
  }
}
