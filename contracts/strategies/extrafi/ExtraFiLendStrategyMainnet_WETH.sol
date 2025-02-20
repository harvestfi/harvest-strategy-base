//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./ExtraFiLendStrategy.sol";

contract ExtraFiLendStrategyMainnet_WETH is ExtraFiLendStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x4200000000000000000000000000000000000006);
        address market = address(0xBB505c54D71E9e599cB8435b4F0cEEc05fC71cbD);
        address rewards = address(0x5F8d42635A2fa74D03b5F91c825dE6F44c443dA5);
        address extra = address(0x2dAD3a13ef0C6366220f989157009e501e7938F8);
        ExtraFiLendStrategy.initializeBaseStrategy(_storage, underlying, _vault, market, 1, rewards, extra);
        rewardTokens = [extra];
    }
}
