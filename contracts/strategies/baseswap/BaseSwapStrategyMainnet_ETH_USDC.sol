//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./BaseSwapStrategy.sol";

contract BaseSwapStrategyMainnet_ETH_USDC is BaseSwapStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x41d160033C222E6f3722EC97379867324567d883);
        address masterChef = address(0x2B0A43DCcBD7d42c18F6A83F86D1a19fA58d541A);
        BaseSwapStrategy.initializeBaseStrategy(
            _storage,
            underlying,
            _vault,
            masterChef,
            7 // Pool id
        );
        rewardTokens = [bswap];
    }
}
