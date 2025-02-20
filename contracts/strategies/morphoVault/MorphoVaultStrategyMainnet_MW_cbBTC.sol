//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "./MorphoVaultStrategy.sol";

contract MorphoVaultStrategyMainnet_MW_cbBTC is MorphoVaultStrategy {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf);
        address morphoVault = address(0x543257eF2161176D7C8cD90BA65C2d4CaEF5a796);
        address weth = address(0x4200000000000000000000000000000000000006);
        address well = address(0xA88594D404727625A9437C3f886C7643872296AE);
        address morpho = address(0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842);
        MorphoVaultStrategy.initializeBaseStrategy(_storage, underlying, _vault, morphoVault, weth);
        rewardTokens = [well, morpho];
    }
}
