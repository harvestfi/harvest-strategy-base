//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./BaseSwapStrategy.sol";

contract BaseSwapStrategyMainnet_DAI_USDC is BaseSwapStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x6D3c5a4a7aC4B1428368310E4EC3bB1350d01455);
        address masterChef = address(0x2B0A43DCcBD7d42c18F6A83F86D1a19fA58d541A);
        BaseSwapStrategy.initializeBaseStrategy(
            _storage,
            underlying,
            _vault,
            masterChef,
            5 // Pool id
        );
        rewardTokens = [bswap];
    }
}
