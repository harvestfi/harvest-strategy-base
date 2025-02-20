//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./SeamlessRecovery.sol";

contract SeamlessRecoveryMainnet_wstETH is SeamlessRecovery {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452);
        address aToken = address(0xfA48A40DAD139e9B1aF8dc82F37Da58cC3cA2867);
        address debtToken = address(0x51fB9021d61c464674b419C0e3082B5b9223Fc17);
        address seam = address(0x1C7a460413dD4e964f96D8dFC56E7223cE88CD85);
        SeamlessRecovery.initializeBaseStrategy(
            _storage, underlying, _vault, aToken, debtToken, seam, 630, 650, 1000, true
        );
        rewardTokens = [seam];
    }
}
