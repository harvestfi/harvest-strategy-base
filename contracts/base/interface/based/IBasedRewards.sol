//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

interface IBasedRewards {
    function poolInfo(uint) external view returns (address, uint, uint, uint, bool);
    function userInfo(uint, address) external view returns (uint, uint);
    function deposit(uint _pid, uint _amount) external;
    function emergencyWithdraw(uint _pid) external;
    function withdraw(uint _pid, uint _amount) external;
}