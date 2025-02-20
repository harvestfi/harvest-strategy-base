//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;
pragma experimental ABIEncoderV2;

import "./FluidLendStrategy.sol";

contract FluidLendStrategyMainnet_ETH is FluidLendStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x4200000000000000000000000000000000000006);
        address fToken = address(0x9272D6153133175175Bc276512B2336BE3931CE9);
        address weth = address(0x4200000000000000000000000000000000000006);
        FluidLendStrategy.initializeBaseStrategy(_storage, underlying, _vault, fToken, weth);
    }
}
