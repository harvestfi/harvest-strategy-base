//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./AaveSupplyStrategy.sol";

contract AaveSupplyStrategyMainnet_USDbC is AaveSupplyStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA);
        address aToken = address(0x0a1d576f3eFeF75b330424287a95A366e8281D54);
        AaveSupplyStrategy.initializeBaseStrategy(_storage, underlying, _vault, aToken);
    }
}
