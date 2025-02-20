//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./BaseSwapStrategyV2.sol";

contract BaseSwapStrategyV2Mainnet_axlUSDC_ETH is BaseSwapStrategyV2 {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x9A0b05F3cF748A114A4f8351802b3BFfE07100D4);
        address nftPool = address(0x7d3cab8613e18534A2C11277b8EF2AaCaD94f842);
        address _xBSXVault = address(0x40455352Dd3c5D65A40729C22B12265C17B37b75);
        BaseSwapStrategyV2.initializeBaseStrategy(_storage, underlying, _vault, nftPool, _xBSXVault, address(0));
        rewardTokens = [bswap, bsx];
    }
}
