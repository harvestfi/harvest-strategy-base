//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./BaseSwapStrategy.sol";

contract BaseSwapStrategyMainnet_CBETH_ETH is BaseSwapStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x07CFA5Df24fB17486AF0CBf6C910F24253a674D3);
        address masterChef = address(0x2B0A43DCcBD7d42c18F6A83F86D1a19fA58d541A);
        BaseSwapStrategy.initializeBaseStrategy(
            _storage,
            underlying,
            _vault,
            masterChef,
            6 // Pool id
        );
        rewardTokens = [bswap];
    }
}
