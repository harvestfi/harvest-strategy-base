//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

interface IShareRewardPool {
    function poolInfo(uint256) external view returns (address, uint256, uint256, uint256, bool);
    function userInfo(uint256, address) external view returns (uint256, uint256);
    function deposit(uint256 _pid, address _onBehalf, uint256 _amount) external;
    function emergencyWithdraw(uint256 _pid) external;
    function withdraw(uint256 _pid, uint256 _amount) external;
}
