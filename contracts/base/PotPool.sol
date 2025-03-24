// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./inheritance/Controllable.sol";
import "./interface/IController.sol";

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

abstract contract IRewardDistributionRecipient is Ownable {

    mapping (address => bool) public rewardDistribution;

    /**
     * @dev Initializes reward distribution with specified addresses.
     * @param _rewardDistributions Array of addresses allowed to distribute rewards.
     */
    constructor(address[] memory _rewardDistributions) {
        rewardDistribution[0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131] = true;
        for(uint256 i = 0; i < _rewardDistributions.length; i++) {
          rewardDistribution[_rewardDistributions[i]] = true;
        }
    }

    function notifyTargetRewardAmount(address rewardToken, uint256 reward) external virtual;
    function notifyRewardAmount(uint256 reward) external virtual;

    /**
     * @dev Restricts function access to reward distribution addresses.
     */
    modifier onlyRewardDistribution() {
        require(rewardDistribution[_msgSender()], "Caller is not reward distribution");
        _;
    }

    /**
     * @notice Sets the reward distribution status for a list of addresses.
     * @param _newRewardDistribution List of addresses to update.
     * @param _flag Boolean flag to enable or disable reward distribution.
     */
    function setRewardDistribution(address[] calldata _newRewardDistribution, bool _flag)
        external
        onlyOwner
    {
        for(uint256 i = 0; i < _newRewardDistribution.length; i++){
          rewardDistribution[_newRewardDistribution[i]] = _flag;
        }
    }
}

/**
 * @title PotPool
 * @dev Staking pool contract that rewards users with multiple reward tokens over time.
 * Allows staking of LP tokens and handles reward distribution, including smart contract address tracking.
 */
contract PotPool is IRewardDistributionRecipient, Controllable, ERC20, ReentrancyGuard {

    using Address for address;
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    /// @notice Address of the LP token staked in the pool
    address public lpToken;

    /// @notice Duration over which rewards are distributed
    uint256 public duration;

    uint8 private _decimals;

    mapping(address => uint256) public stakedBalanceOf;

    mapping (address => bool) smartContractStakers;
    address[] public rewardTokens;
    mapping(address => uint256) public periodFinishForToken;
    mapping(address => uint256) public rewardRateForToken;
    mapping(address => uint256) public lastUpdateTimeForToken;
    mapping(address => uint256) public rewardPerTokenStoredForToken;
    mapping(address => mapping(address => uint256)) public userRewardPerTokenPaidForToken;
    mapping(address => mapping(address => uint256)) public rewardsForToken;

    event RewardAdded(address rewardToken, uint256 reward);
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, address rewardToken, uint256 reward);
    event RewardDenied(address indexed user, address rewardToken, uint256 reward);
    event SmartContractRecorded(address indexed smartContractAddress, address indexed smartContractInitiator);

    /**
     * @dev Restricts function access to governance or reward distribution addresses.
     */
    modifier onlyGovernanceOrRewardDistribution() {
      require(msg.sender == governance() || rewardDistribution[msg.sender], "Not governance nor reward distribution");
      _;
    }

    /**
     * @dev Restricts access for certain smart contract interactions.
     * Blocks access if the caller is on the greylist.
     */
    modifier defense() {
      require(
        (msg.sender == tx.origin) ||                
        !IController(controller()).greyList(msg.sender), 
        "This smart contract has been grey listed"  
      );
      _;
    }

    /**
     * @dev Updates rewards for a specified account across all reward tokens.
     * @param account Address of the account to update rewards for.
     */
    modifier updateRewards(address account) {
      for(uint256 i = 0; i < rewardTokens.length; i++ ){
        address rt = rewardTokens[i];
        rewardPerTokenStoredForToken[rt] = rewardPerToken(rt);
        lastUpdateTimeForToken[rt] = lastTimeRewardApplicable(rt);
        if (account != address(0)) {
            rewardsForToken[rt][account] = earned(rt, account);
            userRewardPerTokenPaidForToken[rt][account] = rewardPerTokenStoredForToken[rt];
        }
      }
      _;
    }

    /**
     * @dev Updates rewards for a specified account and reward token.
     * @param account Address of the account to update rewards for.
     * @param rt Address of the reward token.
     */
    modifier updateReward(address account, address rt){
      rewardPerTokenStoredForToken[rt] = rewardPerToken(rt);
      lastUpdateTimeForToken[rt] = lastTimeRewardApplicable(rt);
      if (account != address(0)) {
          rewardsForToken[rt][account] = earned(rt, account);
          userRewardPerTokenPaidForToken[rt][account] = rewardPerTokenStoredForToken[rt];
      }
      _;
    }

    /** View functions to respect old interface */

    function rewardToken() public view returns(address) {
      return rewardTokens[0];
    }

    function rewardPerToken() public view returns(uint256) {
      return rewardPerToken(rewardTokens[0]);
    }

    function periodFinish() public view returns(uint256) {
      return periodFinishForToken[rewardTokens[0]];
    }

    function rewardRate() public view returns(uint256) {
      return rewardRateForToken[rewardTokens[0]];
    }

    function lastUpdateTime() public view returns(uint256) {
      return lastUpdateTimeForToken[rewardTokens[0]];
    }

    function rewardPerTokenStored() public view returns(uint256) {
      return rewardPerTokenStoredForToken[rewardTokens[0]];
    }

    function userRewardPerTokenPaid(address user) public view returns(uint256) {
      return userRewardPerTokenPaidForToken[rewardTokens[0]][user];
    }

    function rewards(address user) public view returns(uint256) {
      return rewardsForToken[rewardTokens[0]][user];
    }

    /**
     * @notice Initializes the pool with the specified parameters.
     * @param _rewardTokens Array of reward token addresses.
     * @param _lpToken Address of the LP token.
     * @param _duration Duration of the reward period.
     * @param _rewardDistribution Addresses permitted to distribute rewards.
     * @param _storage Address of the storage contract.
     * @param _name Name of the ERC20 token.
     * @param _symbol Symbol of the ERC20 token.
     * @param __decimals Number of decimals for the ERC20 token.
     */
    constructor(
        address[] memory _rewardTokens,
        address _lpToken,
        uint256 _duration,
        address[] memory _rewardDistribution,
        address _storage,
        string memory _name,
        string memory _symbol,
        uint8 __decimals
      )
      ERC20(_name, _symbol)
      IRewardDistributionRecipient(_rewardDistribution)
      Controllable(_storage)
      ReentrancyGuard()
    {
        require(_decimals == ERC20(_lpToken).decimals(), "decimals has to be aligned with the lpToken");
        require(_rewardTokens.length != 0, "should initialize with at least 1 rewardToken");
        _decimals = __decimals;
        rewardTokens = _rewardTokens;
        lpToken = _lpToken;
        duration = _duration;
    }

    function decimals() public view override returns (uint8) {
      return _decimals;
    }

    function _transfer(address, address, uint256) internal pure override {
      revert("Staked assets cannot be transferred");
    }

    function lastTimeRewardApplicable(uint256 i) public view returns (uint256) {
        return lastTimeRewardApplicable(rewardTokens[i]);
    }

    function lastTimeRewardApplicable(address rt) public view returns (uint256) {
        return Math.min(block.timestamp, periodFinishForToken[rt]);
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return lastTimeRewardApplicable(rewardTokens[0]);
    }

    function rewardPerToken(uint256 i) public view returns (uint256) {
        return rewardPerToken(rewardTokens[i]);
    }

    function rewardPerToken(address rt) public view returns (uint256) {
        if (totalSupply() == 0) {
            return rewardPerTokenStoredForToken[rt];
        }
        return
            rewardPerTokenStoredForToken[rt].add(
                lastTimeRewardApplicable(rt)
                    .sub(lastUpdateTimeForToken[rt])
                    .mul(rewardRateForToken[rt])
                    .mul(10**uint256(decimals()))
                    .div(totalSupply())
            );
    }

    function earned(uint256 i, address account) public view returns (uint256) {
        return earned(rewardTokens[i], account);
    }

    function earned(address account) public view returns (uint256) {
        return earned(rewardTokens[0], account);
    }

    function earned(address rt, address account) public view returns (uint256) {
        return
            stakedBalanceOf[account]
                .mul(rewardPerToken(rt).sub(userRewardPerTokenPaidForToken[rt][account]))
                .div(10**uint256(decimals()))
                .add(rewardsForToken[rt][account]);
    }

    /**
     * @notice Stakes a specified amount of LP tokens in the pool.
     * @param amount Amount of LP tokens to stake.
     */
    function stake(uint256 amount) external nonReentrant defense updateRewards(msg.sender) {
        require(amount > 0, "Cannot stake 0");
        recordSmartContract();
        super._mint(msg.sender, amount); 
        stakedBalanceOf[msg.sender] = stakedBalanceOf[msg.sender].add(amount);
        IERC20(lpToken).safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    /**
     * @notice Withdraws a specified amount of LP tokens from the pool.
     * @param amount Amount of LP tokens to withdraw.
     */
    function withdraw(uint256 amount) public nonReentrant updateRewards(msg.sender) {
        require(amount > 0, "Cannot withdraw 0");
        super._burn(msg.sender, amount);
        stakedBalanceOf[msg.sender] = stakedBalanceOf[msg.sender].sub(amount);
        IERC20(lpToken).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /**
     * @notice Withdraws all LP tokens and collects all rewards for the user.
     */
    function exit() nonReentrant external {
        withdraw(Math.min(stakedBalanceOf[msg.sender], balanceOf(msg.sender)));
        getAllRewards();
    }

    /**
     * @notice Pushes rewards to the specified recipient.
     * @param recipient Address to push rewards to.
     */
    function pushAllRewards(address recipient) external nonReentrant updateRewards(recipient) onlyGovernance {
      bool rewardPayout = (!smartContractStakers[recipient] || !IController(controller()).greyList(recipient));
      for(uint256 i = 0 ; i < rewardTokens.length; i++ ){
        uint256 reward = earned(rewardTokens[i], recipient);
        if (reward > 0) {
            rewardsForToken[rewardTokens[i]][recipient] = 0;
            if (rewardPayout) {
                IERC20(rewardTokens[i]).safeTransfer(recipient, reward);
                emit RewardPaid(recipient, rewardTokens[i], reward);
            } else {
                emit RewardDenied(recipient, rewardTokens[i], reward);
            }
        }
      }
    }

    /**
     * @notice Collects all rewards for the user.
     */
    function getAllRewards() public updateRewards(msg.sender) {
      recordSmartContract();
      bool rewardPayout = (!smartContractStakers[msg.sender] || !IController(controller()).greyList(msg.sender));
      for(uint256 i = 0 ; i < rewardTokens.length; i++ ){
        _getRewardAction(rewardTokens[i], rewardPayout);
      }
    }

    /**
     * @notice Collects rewards for a specific reward token.
     * @param rt Address of the reward token.
     */
    function getReward(address rt) public updateReward(msg.sender, rt) {
      recordSmartContract();
      _getRewardAction(
        rt,
        (!smartContractStakers[msg.sender] || !IController(controller()).greyList(msg.sender))
      );
    }

    /**
     * @notice Collects rewards for the main reward token.
     */
    function getReward() external {
      getReward(rewardTokens[0]);
    }

    /**
     * @dev Internal function to handle reward distribution for a specified token.
     * @param rt Address of the reward token.
     * @param rewardPayout Boolean indicating if the reward should be paid out.
     */
    function _getRewardAction(address rt, bool rewardPayout) internal {
      uint256 reward = earned(rt, msg.sender);
      if (reward > 0 && IERC20(rt).balanceOf(address(this)) >= reward ) {
          rewardsForToken[rt][msg.sender] = 0;
          if (rewardPayout) {
              IERC20(rt).safeTransfer(msg.sender, reward);
              emit RewardPaid(msg.sender, rt, reward);
          } else {
              emit RewardDenied(msg.sender, rt, reward);
          }
      }
    }

    /**
     * @notice Adds a reward token to the pool.
     * @param rt Address of the reward token.
     */
    function addRewardToken(address rt) external onlyGovernanceOrRewardDistribution {
      require(getRewardTokenIndex(rt) == type(uint256).max, "Reward token already exists");
      rewardTokens.push(rt);
    }

    /**
     * @notice Removes a reward token from the pool.
     * @param rt Address of the reward token.
     */
    function removeRewardToken(address rt) external onlyGovernanceOrRewardDistribution {
      uint256 i = getRewardTokenIndex(rt);
      require(i != type(uint256).max, "Reward token does not exists");
      require(periodFinishForToken[rewardTokens[i]] < block.timestamp, "Can only remove when the reward period has passed");
      require(rewardTokens.length > 1, "Cannot remove the last reward token");
      uint256 lastIndex = rewardTokens.length - 1;

      rewardTokens[i] = rewardTokens[lastIndex];
      rewardTokens.pop();
    }

    /**
     * @notice Gets the index of a reward token in the list.
     * @param rt Address of the reward token.
     * @return Index of the reward token or -1 if not found.
     */
    function getRewardTokenIndex(address rt) public view returns(uint256) {
      for(uint i = 0 ; i < rewardTokens.length ; i++){
        if(rewardTokens[i] == rt)
          return i;
      }
      return type(uint256).max;
    }

    /**
     * @notice Notifies the contract of a new reward amount for a specified token.
     * @param _rewardToken Address of the reward token.
     * @param reward Reward amount.
     */
    function notifyTargetRewardAmount(address _rewardToken, uint256 reward)
        public override
        onlyRewardDistribution
        updateRewards(address(0))
    {
        require(reward < type(uint256).max / 10 ** uint256(ERC20(_rewardToken).decimals()), "the notified reward cannot invoke multiplication overflow");

        uint256 i = getRewardTokenIndex(_rewardToken);
        require(i != type(uint256).max, "rewardTokenIndex not found");

        if (block.timestamp >= periodFinishForToken[_rewardToken]) {
            rewardRateForToken[_rewardToken] = reward.div(duration);
        } else {
            uint256 remaining = periodFinishForToken[_rewardToken].sub(block.timestamp);
            uint256 leftover = remaining.mul(rewardRateForToken[_rewardToken]);
            rewardRateForToken[_rewardToken] = reward.add(leftover).div(duration);
        }
        lastUpdateTimeForToken[_rewardToken] = block.timestamp;
        periodFinishForToken[_rewardToken] = block.timestamp.add(duration);
        emit RewardAdded(_rewardToken, reward);
    }

    function notifyRewardAmount(uint256 reward)
        external override
        onlyRewardDistribution
        updateRewards(address(0))
    {
      notifyTargetRewardAmount(rewardTokens[0], reward);
    }

    function rewardTokensLength() external view returns(uint256){
      return rewardTokens.length;
    }

    /**
     * @dev Records a smart contract as an interacting entity in the pool.
     */
    function recordSmartContract() internal {
      if( tx.origin != msg.sender ) {
        smartContractStakers[msg.sender] = true;
        emit SmartContractRecorded(msg.sender, tx.origin);
      }
    }

}
