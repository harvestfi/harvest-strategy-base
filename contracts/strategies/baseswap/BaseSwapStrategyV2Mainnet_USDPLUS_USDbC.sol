//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./BaseSwapStrategyV2.sol";

contract BaseSwapStrategyV2Mainnet_USDPLUS_USDbC is BaseSwapStrategyV2 {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x696b4d181Eb58cD4B54a59d2Ce834184Cf7Ac31A);
        address nftPool = address(0xB404b32D20F780c7c2Fa44502096675867DecA1e);
        address _xBSXVault = address(0x40455352Dd3c5D65A40729C22B12265C17B37b75);
        BaseSwapStrategyV2.initializeBaseStrategy(_storage, underlying, _vault, nftPool, _xBSXVault, address(0));
        rewardTokens = [bswap, bsx];
    }
}
