//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./BaseSwapStrategyV2.sol";

contract BaseSwapStrategyV2Mainnet_USDC_ETH is BaseSwapStrategyV2 {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xab067c01C7F5734da168C699Ae9d23a4512c9FdB);
        address nftPool = address(0x179A0348DeCf6CBF2cF7b0527E3D6260e2068552);
        address _xBSXVault = address(0x40455352Dd3c5D65A40729C22B12265C17B37b75);
        BaseSwapStrategyV2.initializeBaseStrategy(_storage, underlying, _vault, nftPool, _xBSXVault, address(0));
        rewardTokens = [bswap, bsx];
    }
}
