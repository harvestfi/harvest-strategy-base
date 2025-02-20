//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./BalancerStrategy.sol";

contract BalancerStrategyMainnet_DAI_USDC is BalancerStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x6FbFcf88DB1aADA31F34215b2a1Df7fafb4883e9);
        address usdc = address(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA);
        address bal = address(0x7c6b91D9Be155A6Db01f749217d76fF02A7227F2);
        address gauge = address(0xC97fa65107AE7b94FB749cF05abb01005c14351E);
        BalancerStrategy.initializeBaseStrategy(
            _storage,
            underlying,
            _vault,
            gauge,
            address(0xBA12222222228d8Ba445958a75a0704d566BF2C8), //balancer vault
            0x6fbfcf88db1aada31f34215b2a1df7fafb4883e900000000000000000000000c, // Pool id
            underlying //depositToken
        );
        rewardTokens = [bal, usdc];
        _setRewardToken(usdc);
    }
}
