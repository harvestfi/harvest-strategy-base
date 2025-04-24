// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./inheritance/Controllable.sol";
import "./interface/IERC4626.sol";

contract Drip is Controllable {
    using SafeERC20 for IERC20;
    using Address for address;
    using SafeMath for uint256;

    event DripAdded(DripMode mode, address vault, uint256 perSecond, uint256 endTime);
    event DripRemoved(DripMode mode, address vault, uint256 perSecond, uint256 endTime);
    event Dripped(address vault, uint256 amount);

    enum DripMode { TokenAmount, FixedRate}

    struct DripInfo {
        DripMode mode;
        address vault;
        uint256 perSecond;
        uint256 lastDripTime;
        uint256 endTime;
    }

    DripInfo[] public drips;

    constructor(address _storage) Controllable(_storage) {}

    function addDrip(DripMode _mode, address _vault, uint256 _perSecond, uint256 _endTime) public onlyGovernance {
        drips.push(DripInfo({
            mode: _mode,
            vault: _vault,
            perSecond: _perSecond,
            lastDripTime: block.timestamp,
            endTime: _endTime
        }));
        emit DripAdded(_mode, _vault, _perSecond, _endTime);
    }

    function removeDrip(uint256 _dripIndex) public onlyGovernance {
        require(_dripIndex < drips.length, "Invalid index");
        emit DripRemoved(drips[_dripIndex].mode, drips[_dripIndex].vault, drips[_dripIndex].perSecond, drips[_dripIndex].endTime);
        drips[_dripIndex] = drips[drips.length - 1];
        drips.pop();
    }

    function drip(uint256 _dripIndex) public {
        require(_dripIndex < drips.length, "Invalid index");
        DripInfo storage dripInfo = drips[_dripIndex];
        if (dripInfo.endTime > block.timestamp) {
            uint256 timePassed = block.timestamp.sub(dripInfo.lastDripTime);
            if (timePassed > 0) {
                uint256 rate = getCurrentRate(_dripIndex);
                uint256 amount = rate.mul(timePassed).div(1e18);
                address token = IERC4626(dripInfo.vault).asset();
                uint256 balance = IERC20(token).balanceOf(address(this));
                if (Math.min(amount, balance) > 0) {
                    dripInfo.lastDripTime = block.timestamp;
                    IERC20(token).safeTransfer(dripInfo.vault, Math.min(amount, balance));
                    emit Dripped(dripInfo.vault, Math.min(amount, balance));
                }
            }
        }
    }

    function getCurrentRate(uint256 _dripIndex) public view returns (uint256) {
        require(_dripIndex < drips.length, "Invalid index");
        DripInfo storage dripInfo = drips[_dripIndex];
        if (dripInfo.endTime > block.timestamp) {
            uint256 timeToEnd = dripInfo.endTime.sub(dripInfo.lastDripTime);
            uint256 rate;
            if (dripInfo.mode == DripMode.TokenAmount) {
                rate = dripInfo.perSecond.mul(1e18);
            } else if (dripInfo.mode == DripMode.FixedRate) {
                uint256 totalAssets = IERC4626(dripInfo.vault).totalAssets();
                rate = totalAssets.mul(dripInfo.perSecond);
            } else {
                revert("Invalid drip mode");
            }
            address token = IERC4626(dripInfo.vault).asset();
            uint256 balance = IERC20(token).balanceOf(address(this));
            uint256 maxRate = balance.mul(1e18).div(timeToEnd);
            if (rate > maxRate) {
                return maxRate;
            } else {
                return rate;
            }
        }
        return 0;
    }

    function dripAll() public {
        for (uint256 i = 0; i < drips.length; i++) {
            drip(i);
        }
    }

    function salvage(address _token, uint256 _amount) public onlyGovernance {
        IERC20(_token).safeTransfer(governance(), _amount);
    }
}
