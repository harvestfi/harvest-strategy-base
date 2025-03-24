// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IUniversalLiquidator {
    function swap(
        address _sellToken,
        address _buyToken,
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver
    ) external returns (uint256);
}
