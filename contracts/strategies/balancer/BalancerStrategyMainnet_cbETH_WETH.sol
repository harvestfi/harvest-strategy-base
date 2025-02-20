//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./BalancerStrategy.sol";

contract BalancerStrategyMainnet_cbETH_WETH is BalancerStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xFb4C2E6E6e27B5b4a07a36360C89EDE29bB3c9B6);
        address usdc = address(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA);
        address bal = address(0x7c6b91D9Be155A6Db01f749217d76fF02A7227F2);
        address gauge = address(0x2279abf4bdAb8CF29EAe4036262c62dBA6460306);
        BalancerStrategy.initializeBaseStrategy(
            _storage,
            underlying,
            _vault,
            gauge,
            address(0xBA12222222228d8Ba445958a75a0704d566BF2C8), //balancer vault
            0xfb4c2e6e6e27b5b4a07a36360c89ede29bb3c9b6000000000000000000000026, // Pool id
            underlying //depositToken
        );
        rewardTokens = [bal, usdc];
    }
}
