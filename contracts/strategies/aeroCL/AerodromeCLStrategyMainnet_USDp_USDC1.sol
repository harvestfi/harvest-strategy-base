//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./AerodromeCLStrategy.sol";

contract AerodromeCLStrategyMainnet_USDp_USDC1 is AerodromeCLStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address gauge = address(0xd030DF11Fa453A222782F6458cC71954A48EA104);
        address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
        AerodromeCLStrategy.initializeBaseStrategy(_storage, _vault, gauge, aero);
        rewardTokens = [aero];
    }
}
