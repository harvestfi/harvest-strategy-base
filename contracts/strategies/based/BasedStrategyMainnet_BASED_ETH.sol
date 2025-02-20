//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./BasedStrategy.sol";

contract BasedStrategyMainnet_BASED_ETH is BasedStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x5F45e48F9C053286cE9Ca08Db897f8b7eb3f7992);
        address rewardPool = address(0x8A75C6EdD19d9a72b31774F1EE2BC45663d30733);
        address based = address(0x9CBD543f1B1166b2Df36b68Eb6bB1DcE24E6aBDf);
        BasedStrategy.initializeBaseStrategy(_storage, underlying, _vault, rewardPool, based, 0);
        rewardTokens = [based];
    }
}
