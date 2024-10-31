// SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./inheritance/Governable.sol";
import "./interface/IController.sol";
import "./interface/IRewardForwarder.sol";
import "./interface/IProfitSharingReceiver.sol";
import "./interface/IStrategy.sol";
import "./interface/IUniversalLiquidator.sol";
import "./inheritance/Controllable.sol";

/**
 * @title RewardForwarder
 * @dev This contract receives rewards from strategies, handles reward liquidation, and distributes fees to specified
 * parties. It converts rewards into target tokens or profit tokens for the DAO.
 * Inherits from `Controllable` to ensure governance and controller-controlled access.
 */
contract RewardForwarder is Controllable {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    /// @notice Address of the iFARM token used for profit-sharing
    address public constant iFARM = address(0xE7798f023fC62146e8Aa1b36Da45fb70855a77Ea);

    /**
     * @notice Initializes the RewardForwarder contract.
     * @param _storage Address of the storage contract.
     */
    constructor(address _storage) public Controllable(_storage) {}

    /**
     * @notice Routes fees collected from a strategy to designated recipients.
     * @param _token Address of the token being used for the fee payment.
     * @param _profitSharingFee Amount allocated for profit sharing.
     * @param _strategistFee Amount allocated for the strategist.
     * @param _platformFee Amount allocated as the platform fee.
     */
    function notifyFee(
        address _token,
        uint256 _profitSharingFee,
        uint256 _strategistFee,
        uint256 _platformFee
    ) external {
        _notifyFee(_token, _profitSharingFee, _strategistFee, _platformFee);
    }

    /**
     * @dev Internal function to handle fee distribution and token conversion if necessary.
     * @param _token Address of the fee token.
     * @param _profitSharingFee Amount allocated for profit sharing.
     * @param _strategistFee Amount allocated for the strategist.
     * @param _platformFee Amount allocated as the platform fee.
     * Transfers the specified amounts to the designated recipients, converting tokens if necessary.
     */
    function _notifyFee(
        address _token,
        uint256 _profitSharingFee,
        uint256 _strategistFee,
        uint256 _platformFee
    ) internal {
        address _controller = controller();
        address liquidator = IController(_controller).universalLiquidator();

        uint totalTransferAmount = _profitSharingFee.add(_strategistFee).add(_platformFee);
        require(totalTransferAmount > 0, "totalTransferAmount should not be 0");
        
        IERC20(_token).safeTransferFrom(msg.sender, address(this), totalTransferAmount);

        address _targetToken = IController(_controller).targetToken();

        if (_token != _targetToken) {
            IERC20(_token).safeApprove(liquidator, 0);
            IERC20(_token).safeApprove(liquidator, _platformFee);

            uint amountOutMin = 1;

            if (_platformFee > 0) {
                IUniversalLiquidator(liquidator).swap(
                    _token,
                    _targetToken,
                    _platformFee,
                    amountOutMin,
                    IController(_controller).protocolFeeReceiver()
                );
            }
        } else {
            IERC20(_targetToken).safeTransfer(IController(_controller).protocolFeeReceiver(), _platformFee);
        }

        if (_token != iFARM) {
            IERC20(_token).safeApprove(liquidator, 0);
            IERC20(_token).safeApprove(liquidator, _profitSharingFee.add(_strategistFee));

            uint amountOutMin = 1;

            if (_profitSharingFee > 0) {
                IUniversalLiquidator(liquidator).swap(
                    _token,
                    iFARM,
                    _profitSharingFee,
                    amountOutMin,
                    IController(_controller).profitSharingReceiver()
                );
            }
            if (_strategistFee > 0) {
                IUniversalLiquidator(liquidator).swap(
                    _token,
                    iFARM,
                    _strategistFee,
                    amountOutMin,
                    IStrategy(msg.sender).strategist()
                );
            }
        } else {
            if (_strategistFee > 0) {
                IERC20(iFARM).safeTransfer(IStrategy(msg.sender).strategist(), _strategistFee);
            }
            IERC20(iFARM).safeTransfer(IController(_controller).profitSharingReceiver(), _profitSharingFee);
        }
    }
}
