//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./CompoundStrategy.sol";

contract CompoundStrategyMainnet_ETH is CompoundStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x4200000000000000000000000000000000000006);
        address market = address(0x46e6b214b524310239732D51387075E0e70970bf);
        address rewards = address(0x123964802e6ABabBE1Bc9547D72Ef1B69B00A6b1);
        address comp = address(0x9e1028F5F1D5eDE59748FFceE5532509976840E0);
        CompoundStrategy.initializeBaseStrategy(_storage, underlying, _vault, market, rewards, comp);
    }
}
