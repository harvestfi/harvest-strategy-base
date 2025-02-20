//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./AerodromeStableStrategy.sol";

contract AerodromeStableStrategyMainnet_USDC_USDbC is AerodromeStableStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0x27a8Afa3Bd49406e48a074350fB7b2020c43B2bD);
        address gauge = address(0x1Cfc45C5221A07DA0DE958098A319a29FbBD66fE);
        address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
        AerodromeStableStrategy.initializeBaseStrategy(_storage, underlying, _vault, gauge, aero);
        rewardTokens = [aero];
    }
}
