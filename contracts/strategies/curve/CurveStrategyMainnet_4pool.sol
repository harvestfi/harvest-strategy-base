//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./CurveStrategy.sol";

contract CurveStrategyMainnet_4pool is CurveStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xf6C5F01C7F3148891ad0e19DF78743D31E390D1f);
        address gauge = address(0x79edc58C471Acf2244B8f93d6f425fD06A439407);
        address crv = address(0x8Ee73c484A26e0A5df2Ee2a4960B789967dd0415);
        address crvusd = address(0x417Ac0e078398C154EdFadD9Ef675d30Be60Af93);
        CurveStrategy.initializeBaseStrategy(_storage, underlying, _vault, gauge, crv, crvusd, underlying, 3, 4);
        rewardTokens = [crv, crvusd];
    }
}
