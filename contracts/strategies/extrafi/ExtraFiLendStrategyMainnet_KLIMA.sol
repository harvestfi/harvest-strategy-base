//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./ExtraFiLendStrategy.sol";

contract ExtraFiLendStrategyMainnet_KLIMA is ExtraFiLendStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xDCEFd8C8fCc492630B943ABcaB3429F12Ea9Fea2);
        address market = address(0xBB505c54D71E9e599cB8435b4F0cEEc05fC71cbD);
        address rewards = address(0xCdc61440531107AC8218B11F311F400E4bFd8D0E);
        address extra = address(0x2dAD3a13ef0C6366220f989157009e501e7938F8);
        ExtraFiLendStrategy.initializeBaseStrategy(_storage, underlying, _vault, market, 60, rewards, extra);
        rewardTokens = [extra];
    }
}
