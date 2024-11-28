// SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

interface IPool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, bool);
}