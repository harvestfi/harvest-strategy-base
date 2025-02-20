//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./SeamlessFoldStrategy.sol";

contract SeamlessFoldStrategyMainnet_DAI is SeamlessFoldStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb);
        address aToken = address(0x37eF72fAC21904EDd7e69f7c7AC98172849efF8e);
        address debtToken = address(0x2733e1DA7d35c5ea3ed246ed6b613DC3dA97Ce2E);
        address seam = address(0x1C7a460413dD4e964f96D8dFC56E7223cE88CD85);
        SeamlessFoldStrategy.initializeBaseStrategy(
            _storage, underlying, _vault, aToken, debtToken, seam, 750, 770, 1000, true
        );
        rewardTokens = [seam];
    }
}
