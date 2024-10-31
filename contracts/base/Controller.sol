// SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./inheritance/Governable.sol";
import "./interface/IController.sol";
import "./interface/IStrategy.sol";
import "./interface/IVault.sol";

import "./RewardForwarder.sol";

/**
 * @title Controller
 * @dev Manages protocol parameters, profit-sharing, and fee distribution for strategies and vaults.
 * Provides governance-controlled configuration and allows whitelisted smart contracts to interact 
 * with the protocol.
 */
contract Controller is Governable {
    using SafeERC20 for IERC20;
    using Address for address;
    using SafeMath for uint256;

    // ========================= State Variables =========================

    /// @notice Token used for rewards and fees within the protocol.
    address public targetToken;

    /// @notice Addresses for protocol-related fee and profit-sharing recipients.
    address public protocolFeeReceiver;
    address public profitSharingReceiver;
    address public rewardForwarder;
    address public universalLiquidator;

    /// @notice Delay time for scheduling parameter changes.
    uint256 public nextImplementationDelay;

    /// @notice Profit-sharing and fee configuration parameters.
    uint256 public profitSharingNumerator = 700;
    uint256 public nextProfitSharingNumerator = 0;
    uint256 public nextProfitSharingNumeratorTimestamp = 0;

    uint256 public strategistFeeNumerator = 0;
    uint256 public nextStrategistFeeNumerator = 0;
    uint256 public nextStrategistFeeNumeratorTimestamp = 0;

    uint256 public platformFeeNumerator = 300;
    uint256 public nextPlatformFeeNumerator = 0;
    uint256 public nextPlatformFeeNumeratorTimestamp = 0;

    uint256 public tempNextImplementationDelay = 0;
    uint256 public tempNextImplementationDelayTimestamp = 0;

    /// @dev Constants for fee calculations.
    uint256 public constant MAX_TOTAL_FEE = 3000;
    uint256 public constant FEE_DENOMINATOR = 10000;

    /// @notice Whitelisted addresses and code hashes for greylisting contracts.
    mapping(address => bool) public addressWhitelist;
    mapping(bytes32 => bool) public codeWhitelist;

    /// @notice List of addresses allowed to perform certain operations within the protocol.
    mapping(address => bool) public hardWorkers;

    // ========================= Events =========================

    event QueueProfitSharingChange(uint profitSharingNumerator, uint validAtTimestamp);
    event ConfirmProfitSharingChange(uint profitSharingNumerator);

    event QueueStrategistFeeChange(uint strategistFeeNumerator, uint validAtTimestamp);
    event ConfirmStrategistFeeChange(uint strategistFeeNumerator);

    event QueuePlatformFeeChange(uint platformFeeNumerator, uint validAtTimestamp);
    event ConfirmPlatformFeeChange(uint platformFeeNumerator);

    event QueueNextImplementationDelay(uint implementationDelay, uint validAtTimestamp);
    event ConfirmNextImplementationDelay(uint implementationDelay);

    event AddedAddressToWhitelist(address indexed _address);
    event RemovedAddressFromWhitelist(address indexed _address);

    event AddedCodeToWhitelist(address indexed _address);
    event RemovedCodeFromWhitelist(address indexed _address);

    event SharePriceChangeLog(
        address indexed vault,
        address indexed strategy,
        uint256 oldSharePrice,
        uint256 newSharePrice,
        uint256 timestamp
    );

    // ========================= Modifiers =========================

    /**
     * @dev Restricts access to governance or addresses marked as hard workers.
     */
    modifier onlyHardWorkerOrGovernance() {
        require(
            hardWorkers[msg.sender] || (msg.sender == governance()),
            "only hard worker can call this"
        );
        _;
    }

    /**
     * @notice Constructor to initialize the controller with necessary addresses and parameters.
     * @param _storage Address of the storage contract.
     * @param _targetToken Address of the target token.
     * @param _protocolFeeReceiver Address that receives protocol fees.
     * @param _profitSharingReceiver Address that receives profit sharing.
     * @param _rewardForwarder Address responsible for forwarding rewards.
     * @param _universalLiquidator Address of the universal liquidator contract.
     * @param _nextImplementationDelay Delay before a scheduled upgrade can occur.
     */
    constructor(
        address _storage,
        address _targetToken,
        address _protocolFeeReceiver,
        address _profitSharingReceiver,
        address _rewardForwarder,
        address _universalLiquidator,
        uint _nextImplementationDelay
    ) Governable(_storage) public {
        require(_targetToken != address(0), "_targetToken should not be empty");
        require(_protocolFeeReceiver != address(0), "_protocolFeeReceiver should not be empty");
        require(_profitSharingReceiver != address(0), "_profitSharingReceiver should not be empty");
        require(_rewardForwarder != address(0), "_rewardForwarder should not be empty");
        require(_nextImplementationDelay > 0, "_nextImplementationDelay should be gt 0");

        targetToken = _targetToken;
        protocolFeeReceiver = _protocolFeeReceiver;
        profitSharingReceiver = _profitSharingReceiver;
        rewardForwarder = _rewardForwarder;
        universalLiquidator = _universalLiquidator;
        nextImplementationDelay = _nextImplementationDelay;
    }

    // ========================= Functions =========================

    /**
     * @notice Checks if an address is in the greylist.
     * @param _addr Address to check.
     * @return True if the address is in the greylist, false otherwise.
     */
    function greyList(address _addr) external view returns (bool) {
        return !addressWhitelist[_addr] && !codeWhitelist[getContractHash(_addr)];
    }

    /**
     * @notice Adds an address to the whitelist.
     * @param _target Address to be whitelisted.
     */
    function addToWhitelist(address _target) external onlyGovernance {
        addressWhitelist[_target] = true;
        emit AddedAddressToWhitelist(_target);
    }

    /**
     * @notice Adds multiple addresses to the whitelist.
     * @param _targets Array of addresses to be whitelisted.
     */
    function addMultipleToWhitelist(address[] memory _targets) external onlyGovernance {
        for (uint256 i = 0; i < _targets.length; i++) {
            addressWhitelist[_targets[i]] = true;
        }
    }

    /**
     * @notice Removes an address from the whitelist.
     * @param _target Address to be removed from the whitelist.
     */
    function removeFromWhitelist(address _target) external onlyGovernance {
        addressWhitelist[_target] = false;
        emit RemovedAddressFromWhitelist(_target);
    }

    /**
     * @notice Removes multiple addresses from the whitelist.
     * @param _targets Array of addresses to be removed from the whitelist.
     */
    function removeMultipleFromWhitelist(address[] memory _targets) external onlyGovernance {
        for (uint256 i = 0; i < _targets.length; i++) {
            addressWhitelist[_targets[i]] = false;
        }
    }

    /**
     * @notice Returns the code hash of a contract.
     * @param a Address of the contract to hash.
     * @return hash Code hash of the contract.
     */
    function getContractHash(address a) public view returns (bytes32 hash) {
        assembly {
            hash := extcodehash(a)
        }
    }

    /**
     * @notice Adds a contract's code hash to the whitelist.
     * @param _target Address of the contract.
     */
    function addCodeToWhitelist(address _target) external onlyGovernance {
        codeWhitelist[getContractHash(_target)] = true;
        emit AddedCodeToWhitelist(_target);
    }

    /**
     * @notice Removes a contract's code hash from the whitelist.
     * @param _target Address of the contract.
     */
    function removeCodeFromWhitelist(address _target) external onlyGovernance {
        codeWhitelist[getContractHash(_target)] = false;
        emit RemovedCodeFromWhitelist(_target);
    }

    /**
     * @notice Sets the reward forwarder address.
     * @param _rewardForwarder Address of the new reward forwarder.
     */
    function setRewardForwarder(address _rewardForwarder) external onlyGovernance {
        require(_rewardForwarder != address(0), "new reward forwarder should not be empty");
        rewardForwarder = _rewardForwarder;
    }

    /**
     * @notice Sets the target token.
     * @param _targetToken Address of the new target token.
     */
    function setTargetToken(address _targetToken) external onlyGovernance {
        require(_targetToken != address(0), "new target token should not be empty");
        targetToken = _targetToken;
    }

    /**
     * @notice Sets the profit-sharing receiver address.
     * @param _profitSharingReceiver Address of the new profit-sharing receiver.
     */
    function setProfitSharingReceiver(address _profitSharingReceiver) external onlyGovernance {
        require(_profitSharingReceiver != address(0), "new profit sharing receiver should not be empty");
        profitSharingReceiver = _profitSharingReceiver;
    }

    /**
     * @notice Sets the protocol fee receiver address.
     * @param _protocolFeeReceiver Address of the new protocol fee receiver.
     */
    function setProtocolFeeReceiver(address _protocolFeeReceiver) external onlyGovernance {
        require(_protocolFeeReceiver != address(0), "new protocol fee receiver should not be empty");
        protocolFeeReceiver = _protocolFeeReceiver;
    }

    /**
     * @notice Sets the universal liquidator address.
     * @param _universalLiquidator Address of the new universal liquidator.
     */
    function setUniversalLiquidator(address _universalLiquidator) external onlyGovernance {
        require(_universalLiquidator != address(0), "new universal liquidator should not be empty");
        universalLiquidator = _universalLiquidator;
    }

    /**
     * @notice Returns the price per full share of a given vault.
     * @param _vault Address of the vault.
     * @return The price per full share.
     */
    function getPricePerFullShare(address _vault) external view returns (uint256) {
        return IVault(_vault).getPricePerFullShare();
    }

    /**
     * @notice Executes `doHardWork` for a specific vault.
     * @param _vault Address of the vault.
     */
    function doHardWork(address _vault) external onlyHardWorkerOrGovernance {
        uint256 oldSharePrice = IVault(_vault).getPricePerFullShare();
        IVault(_vault).doHardWork();
        emit SharePriceChangeLog(
            _vault,
            IVault(_vault).strategy(),
            oldSharePrice,
            IVault(_vault).getPricePerFullShare(),
            block.timestamp
        );
    }

    /**
     * @notice Adds an address as a hard worker.
     * @param _worker Address to be added as a hard worker.
     */
    function addHardWorker(address _worker) external onlyGovernance {
        require(_worker != address(0), "_worker must be defined");
        hardWorkers[_worker] = true;
    }

    /**
     * @notice Removes an address from the list of hard workers.
     * @param _worker Address to be removed from the list of hard workers.
     */
    function removeHardWorker(address _worker) external onlyGovernance {
        require(_worker != address(0), "_worker must be defined");
        hardWorkers[_worker] = false;
    }

    /**
     * @notice Salvages a specified amount of tokens to the governance address.
     * @param _token Address of the token to salvage.
     * @param _amount Amount of tokens to salvage.
     */
    function salvage(address _token, uint256 _amount) external onlyGovernance {
        IERC20(_token).safeTransfer(governance(), _amount);
    }

    /**
     * @notice Salvages tokens from a specific strategy.
     * @param _strategy Address of the strategy.
     * @param _token Address of the token to salvage.
     * @param _amount Amount of tokens to salvage.
     */
    function salvageStrategy(address _strategy, address _token, uint256 _amount) external onlyGovernance {
        IStrategy(_strategy).salvageToken(governance(), _token, _amount);
    }

    /**
     * @notice Returns the denominator used in fee calculations.
     * @return The fee denominator value.
     */
    function feeDenominator() external pure returns (uint) {
        return FEE_DENOMINATOR;
    }

    /**
     * @notice Schedules an update for the profit-sharing numerator.
     * @param _profitSharingNumerator New profit-sharing numerator.
     */
    function setProfitSharingNumerator(uint _profitSharingNumerator) external onlyGovernance {
        require(
            _profitSharingNumerator.add(strategistFeeNumerator).add(platformFeeNumerator) <= MAX_TOTAL_FEE,
            "total fee too high"
        );

        nextProfitSharingNumerator = _profitSharingNumerator;
        nextProfitSharingNumeratorTimestamp = block.timestamp.add(nextImplementationDelay);
        emit QueueProfitSharingChange(nextProfitSharingNumerator, nextProfitSharingNumeratorTimestamp);
    }

    /**
     * @notice Confirms the scheduled profit-sharing numerator change.
     */
    function confirmSetProfitSharingNumerator() external onlyGovernance {
        require(
            nextProfitSharingNumerator != 0
            && nextProfitSharingNumeratorTimestamp != 0
            && block.timestamp >= nextProfitSharingNumeratorTimestamp,
            "invalid timestamp or no new profit sharing numerator confirmed"
        );
        require(
            nextProfitSharingNumerator.add(strategistFeeNumerator).add(platformFeeNumerator) <= MAX_TOTAL_FEE,
            "total fee too high"
        );

        profitSharingNumerator = nextProfitSharingNumerator;
        nextProfitSharingNumerator = 0;
        nextProfitSharingNumeratorTimestamp = 0;
        emit ConfirmProfitSharingChange(profitSharingNumerator);
    }

    /**
     * @notice Schedules an update for the strategist fee numerator.
     * @param _strategistFeeNumerator New strategist fee numerator.
     */
    function setStrategistFeeNumerator(uint _strategistFeeNumerator) external onlyGovernance {
        require(
            _strategistFeeNumerator.add(platformFeeNumerator).add(profitSharingNumerator) <= MAX_TOTAL_FEE,
            "total fee too high"
        );

        nextStrategistFeeNumerator = _strategistFeeNumerator;
        nextStrategistFeeNumeratorTimestamp = block.timestamp.add(nextImplementationDelay);
        emit QueueStrategistFeeChange(nextStrategistFeeNumerator, nextStrategistFeeNumeratorTimestamp);
    }

    /**
     * @notice Confirms the scheduled strategist fee numerator change.
     */
    function confirmSetStrategistFeeNumerator() external onlyGovernance {
        require(
            nextStrategistFeeNumerator != 0
            && nextStrategistFeeNumeratorTimestamp != 0
            && block.timestamp >= nextStrategistFeeNumeratorTimestamp,
            "invalid timestamp or no new strategist fee numerator confirmed"
        );
        require(
            nextStrategistFeeNumerator.add(platformFeeNumerator).add(profitSharingNumerator) <= MAX_TOTAL_FEE,
            "total fee too high"
        );

        strategistFeeNumerator = nextStrategistFeeNumerator;
        nextStrategistFeeNumerator = 0;
        nextStrategistFeeNumeratorTimestamp = 0;
        emit ConfirmStrategistFeeChange(strategistFeeNumerator);
    }

    /**
     * @notice Schedules an update for the platform fee numerator.
     * @param _platformFeeNumerator New platform fee numerator.
     */
    function setPlatformFeeNumerator(uint _platformFeeNumerator) external onlyGovernance {
        require(
            _platformFeeNumerator.add(strategistFeeNumerator).add(profitSharingNumerator) <= MAX_TOTAL_FEE,
            "total fee too high"
        );

        nextPlatformFeeNumerator = _platformFeeNumerator;
        nextPlatformFeeNumeratorTimestamp = block.timestamp.add(nextImplementationDelay);
        emit QueuePlatformFeeChange(nextPlatformFeeNumerator, nextPlatformFeeNumeratorTimestamp);
    }

    /**
     * @notice Confirms the scheduled platform fee numerator change.
     */
    function confirmSetPlatformFeeNumerator() external onlyGovernance {
        require(
            nextPlatformFeeNumerator != 0
            && nextPlatformFeeNumeratorTimestamp != 0
            && block.timestamp >= nextPlatformFeeNumeratorTimestamp,
            "invalid timestamp or no new platform fee numerator confirmed"
        );
        require(
            nextPlatformFeeNumerator.add(strategistFeeNumerator).add(profitSharingNumerator) <= MAX_TOTAL_FEE,
            "total fee too high"
        );

        platformFeeNumerator = nextPlatformFeeNumerator;
        nextPlatformFeeNumerator = 0;
        nextPlatformFeeNumeratorTimestamp = 0;
        emit ConfirmPlatformFeeChange(platformFeeNumerator);
    }

    /**
     * @notice Sets a new delay for implementation upgrades.
     * @param _nextImplementationDelay New delay value.
     */
    function setNextImplementationDelay(uint256 _nextImplementationDelay) external onlyGovernance {
        require(
            _nextImplementationDelay > 0,
            "invalid _nextImplementationDelay"
        );

        tempNextImplementationDelay = _nextImplementationDelay;
        tempNextImplementationDelayTimestamp = block.timestamp.add(nextImplementationDelay);
        emit QueueNextImplementationDelay(tempNextImplementationDelay, tempNextImplementationDelayTimestamp);
    }

    /**
     * @notice Confirms the scheduled implementation delay change.
     */
    function confirmNextImplementationDelay() external onlyGovernance {
        require(
            tempNextImplementationDelayTimestamp != 0 && block.timestamp >= tempNextImplementationDelayTimestamp,
            "invalid timestamp or no new implementation delay confirmed"
        );
        nextImplementationDelay = tempNextImplementationDelay;
        tempNextImplementationDelay = 0;
        tempNextImplementationDelayTimestamp = 0;
        emit ConfirmNextImplementationDelay(nextImplementationDelay);
    }
}
