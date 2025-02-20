//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./AerodromeCLStrategy.sol";

contract AerodromeCLStrategyMainnet_ETH_USDC100 is AerodromeCLStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address gauge = address(0xF33a96b5932D9E9B9A0eDA447AbD8C9d48d2e0c8);
        address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
        AerodromeCLStrategy.initializeBaseStrategy(_storage, _vault, gauge, aero);
        rewardTokens = [aero];
    }
}
