//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./ExtraFiLendStrategy.sol";

contract ExtraFiLendStrategyMainnet_USDplus is ExtraFiLendStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xB79DD08EA68A908A97220C76d19A6aA9cBDE4376);
        address market = address(0xBB505c54D71E9e599cB8435b4F0cEEc05fC71cbD);
        address rewards = address(0x7A883e7752f20f98869E3Ea7E29E0f2478CD34a2);
        address extra = address(0x2dAD3a13ef0C6366220f989157009e501e7938F8);
        ExtraFiLendStrategy.initializeBaseStrategy(_storage, underlying, _vault, market, 10, rewards, extra);
        rewardTokens = [extra];
    }
}
