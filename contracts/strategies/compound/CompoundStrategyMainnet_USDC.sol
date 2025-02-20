//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./CompoundStrategy.sol";

contract CompoundStrategyMainnet_USDC is CompoundStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
        address market = address(0xb125E6687d4313864e53df431d5425969c15Eb2F);
        address rewards = address(0x123964802e6ABabBE1Bc9547D72Ef1B69B00A6b1);
        address comp = address(0x9e1028F5F1D5eDE59748FFceE5532509976840E0);
        CompoundStrategy.initializeBaseStrategy(_storage, underlying, _vault, market, rewards, comp);
    }
}
