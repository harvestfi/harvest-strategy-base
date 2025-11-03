//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

interface IPrimePool {
    function tokenAddress() external view returns (address);
    function deposit(uint256 _amount) external;
    function instantWithdraw(uint256 _amount) external;
    function grantRole(bytes32 role, address account) external;
}