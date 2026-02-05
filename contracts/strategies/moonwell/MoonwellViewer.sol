// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "../../base/interface/moonwell/MTokenInterfaces.sol";
import "../../base/interface/moonwell/ComptrollerInterface.sol";
import "../../base/interface/moonwell/IOracle.sol";


contract MoonwellViewer {
    using SafeMath for uint256;

    address public constant comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);

    function getPrice(address assetMToken, address quoteMToken) public view returns (uint256) {
        uint256 assetPrice = IOracle(ComptrollerInterface(comptroller).oracle())
            .getUnderlyingPrice(assetMToken).mul(10**ERC20(MErc20Interface(assetMToken).underlying()).decimals()).div(1e18);
        uint256 quotePrice = IOracle(ComptrollerInterface(comptroller).oracle())
            .getUnderlyingPrice(quoteMToken).mul(10**ERC20(MErc20Interface(quoteMToken).underlying()).decimals()).div(1e18);
        return assetPrice.mul(1e18).div(quotePrice);
    }

    function getPositionHealth(address supplyMToken, address borrowMToken, uint256 collateralFactorNumerator) public view returns (uint256) {
        (,uint256 supplied,,uint256 exchangeRate) = MTokenInterface(supplyMToken).getAccountSnapshot(msg.sender);
        supplied = supplied.mul(exchangeRate).div(1e18);
        (,,uint256 borrowed,) = MTokenInterface(borrowMToken).getAccountSnapshot(msg.sender);
        borrowed = borrowed.mul(getPrice(borrowMToken, supplyMToken)).div(1e18);
        if (borrowed == 0){
          return type(uint256).max;
        }
        return supplied.mul(1e18).mul(collateralFactorNumerator).div(1000).div(borrowed);
    }
}