//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./ExtraFiLendStrategy.sol";

contract ExtraFiLendStrategyMainnet_OVN is ExtraFiLendStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xA3d1a8DEB97B111454B294E2324EfAD13a9d8396);
        address market = address(0xBB505c54D71E9e599cB8435b4F0cEEc05fC71cbD);
        address rewards = address(0x9138A810947422CFA4f82FF14a57890f0D2BBbb3);
        address extra = address(0x2dAD3a13ef0C6366220f989157009e501e7938F8);
        ExtraFiLendStrategy.initializeBaseStrategy(_storage, underlying, _vault, market, 28, rewards, extra);
        rewardTokens = [extra];
    }
}
