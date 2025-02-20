//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

interface Gauge {
    function deposit(uint256) external;
    function balanceOf(address) external view returns (uint256);
    function withdraw(uint256) external;
    function user_checkpoint(address) external;
    function claim_rewards() external;
    function bal_pseudo_minter() external view returns (address);
}

interface VotingEscrow {
    function create_lock(uint256 v, uint256 time) external;
    function increase_amount(uint256 _value) external;
    function increase_unlock_time(uint256 _unlock_time) external;
    function withdraw() external;
}

interface Mintr {
    function mint(address) external;
}
