//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./ExtraFiLendStrategy.sol";

contract ExtraFiLendStrategyMainnet_USDbC is ExtraFiLendStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA);
        address market = address(0xBB505c54D71E9e599cB8435b4F0cEEc05fC71cbD);
        address rewards = address(0x21C43d9B3b7c25C740B0D5dC9F62495aeC0d1ecC);
        address extra = address(0x2dAD3a13ef0C6366220f989157009e501e7938F8);
        ExtraFiLendStrategy.initializeBaseStrategy(_storage, underlying, _vault, market, 2, rewards, extra);
        rewardTokens = [extra];
    }
}
