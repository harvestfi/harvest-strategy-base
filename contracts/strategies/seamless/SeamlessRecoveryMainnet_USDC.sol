//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./SeamlessRecovery.sol";

contract SeamlessRecoveryMainnet_USDC is SeamlessRecovery {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address aToken = address(0x53E240C0F985175dA046A62F26D490d1E259036e);
    address debtToken = address(0x27Ce7E89312708FB54121ce7E44b13FBBB4C7661);
    address seam = address(0x1C7a460413dD4e964f96D8dFC56E7223cE88CD85);
    SeamlessRecovery.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      aToken,
      debtToken,
      seam,
      750,
      770,
      1000,
      true
    );
    rewardTokens = [seam];
  }
}