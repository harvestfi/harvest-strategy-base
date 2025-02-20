//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./AaveSupplyStrategy.sol";

contract AaveSupplyStrategyMainnet_cbBTC is AaveSupplyStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf);
        address aToken = address(0xBdb9300b7CDE636d9cD4AFF00f6F009fFBBc8EE6);
        AaveSupplyStrategy.initializeBaseStrategy(_storage, underlying, _vault, aToken);
    }
}
