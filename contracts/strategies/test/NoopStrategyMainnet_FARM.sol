//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

import "../../base/noop/NoopStrategyUpgradeable.sol";

contract NoopStrategyMainnet_FARM is NoopStrategyUpgradeable {
    constructor() public {}

    function initializeStrategy(address _storage, address _vault) public initializer {
        address underlying = address(0xD08a2917653d4E460893203471f0000826fb4034);
        NoopStrategyUpgradeable.initializeBaseStrategy(_storage, underlying, _vault);
    }
}
