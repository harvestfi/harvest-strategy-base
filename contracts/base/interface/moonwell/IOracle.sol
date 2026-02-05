//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

interface IOracle {
    function getUnderlyingPrice(address mToken) external view returns (uint256);
}