// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.21;

interface IProfitSharingReceiver {
    function governance() external view returns (address);

    function withdrawTokens(address[] calldata _tokens) external;
}
