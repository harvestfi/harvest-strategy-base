//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

interface ITranche {
    function LENDING_POOL() external view returns (address);
}