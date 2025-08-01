// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./inheritance/Controllable.sol";
import "./interface/IERC4626.sol";
import "./interface/IVault.sol";

contract IncentivesGeneral is Controllable {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    event IncentiveAdded(address indexed vault, address indexed token, uint256 amount, uint256 duration);
    event IncentiveRemoved(address indexed strategy, address indexed token, uint256 claimed, uint256 returned, address receiver);
    event IncentiveClaimed(address indexed strategy, address indexed token, uint256 amount);

    struct IncentiveInfo {
        address vault;
        address strategy;
        address token;
        uint256 perSecond;
        uint256 lastTime;
        uint256 endTime;
    }

    mapping(address => IncentiveInfo[]) public strategyIncentives;

    constructor(address _storage) Controllable(_storage) {}

    function addIncentive(address _vault, address _token, uint256 _amount, uint256 _duration) public onlyGovernance {
        require(_amount > 0, "Amount must be greater than zero");
        require(_duration > 0, "Duration must be greater than zero");

        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
        uint256 perSecond = _amount.div(_duration);
        address strategy = IVault(_vault).strategy();
        strategyIncentives[strategy].push(IncentiveInfo({
            vault: _vault,
            strategy: strategy,
            token: _token,
            perSecond: perSecond,
            lastTime: block.timestamp,
            endTime: block.timestamp.add(_duration)
        }));
        emit IncentiveAdded(_vault, _token, _amount, _duration);
    }

    function removeIncentive(address _strategy, uint256 _index, address _receiver) public onlyGovernance {
        require(_index < strategyIncentives[_strategy].length, "Invalid index");
        require(_receiver != address(0), "Receiver cannot be zero address");
        IncentiveInfo storage incentive = strategyIncentives[_strategy][_index];

        uint256 timeElapsed = block.timestamp.sub(incentive.lastTime);
        uint256 amountToClaim = incentive.perSecond.mul(timeElapsed);
        uint256 amountToReturn;
        if (block.timestamp < incentive.endTime) {
            amountToReturn = incentive.perSecond.mul(incentive.endTime.sub(block.timestamp));
        } else {
            amountToReturn = 0;
        }

        // Remove the incentive from the list
        strategyIncentives[_strategy][_index] = strategyIncentives[_strategy][strategyIncentives[_strategy].length - 1];
        strategyIncentives[_strategy].pop();

        IERC20(incentive.token).safeTransfer(incentive.strategy, amountToClaim);
        IERC20(incentive.token).safeTransfer(_receiver, amountToReturn);

        emit IncentiveRemoved(_strategy, incentive.token, amountToClaim, amountToReturn, _receiver);
    }

    function claim() public {
        IncentiveInfo[] storage incentives = strategyIncentives[msg.sender];
        uint256 i = 0;
        while ( i < incentives.length) {
            IncentiveInfo storage incentive = incentives[i];
            if (block.timestamp > incentive.lastTime && block.timestamp < incentive.endTime) {
                uint256 timeElapsed = block.timestamp.sub(incentive.lastTime);
                uint256 amountToClaim = incentive.perSecond.mul(timeElapsed);
                incentive.lastTime = block.timestamp;
                IERC20(incentive.token).safeTransfer(msg.sender, amountToClaim);
                emit IncentiveClaimed(msg.sender, incentive.token, amountToClaim);
                i++;
            } else if (block.timestamp >= incentive.endTime) {
                uint256 timeElapsed = incentive.endTime.sub(incentive.lastTime);
                uint256 amountToClaim = incentive.perSecond.mul(timeElapsed);
                incentives[i] = incentives[incentives.length - 1];
                incentives.pop();
                IERC20(incentive.token).safeTransfer(msg.sender, amountToClaim);
                emit IncentiveClaimed(msg.sender, incentive.token, amountToClaim);
            } else {
                i++;
            }
        }
    }

    function salvage(address _token, uint256 _amount) public onlyGovernance {
        IERC20(_token).safeTransfer(governance(), _amount);
    }

    function pendingFor(address strategy, uint256 idx) external view returns (uint256) {
        IncentiveInfo storage inf = strategyIncentives[strategy][idx];
        uint256 until = block.timestamp < inf.endTime ? block.timestamp : inf.endTime;
        return inf.perSecond * (until - inf.lastTime);
    }

    function activeIncentives(address strategy) external view returns (uint256) {
        return strategyIncentives[strategy].length;
    }
}
