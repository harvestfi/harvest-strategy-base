//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./Moonwell2AssetFoldStrategy.sol";

contract Moonwell2AssetFoldStrategyMainnet_wstETH_ETH is Moonwell2AssetFoldStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452);
    address mToken = address(0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b);
    address weth = address(0x4200000000000000000000000000000000000006);
    address wethMToken = address(0x628ff693426583D9a7FB391E54366292F509D457);
    address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
    address well = address(0xA88594D404727625A9437C3f886C7643872296AE);
    Moonwell2AssetFoldStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      mToken,
      weth,
      wethMToken,
      comptroller,
      well,
      7700,
      8099,
      50,
      true
    );
    rewardTokens = [well];
  }
}