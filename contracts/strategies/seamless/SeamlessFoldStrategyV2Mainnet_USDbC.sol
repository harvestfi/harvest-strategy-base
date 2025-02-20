//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./SeamlessFoldStrategyV2.sol";

contract SeamlessFoldStrategyV2Mainnet_USDbC is SeamlessFoldStrategyV2 {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA);
        address aToken = address(0x13A13869B814Be8F13B86e9875aB51bda882E391);
        address debtToken = address(0x326441fA5016d946e6E82e807875fDfdc3041B3B);
        address seam = address(0x1C7a460413dD4e964f96D8dFC56E7223cE88CD85);
        SeamlessFoldStrategyV2.initializeBaseStrategy(
            _storage, underlying, _vault, aToken, debtToken, seam, 750, 770, 1000, true
        );
        rewardTokens = [seam];
    }
}
