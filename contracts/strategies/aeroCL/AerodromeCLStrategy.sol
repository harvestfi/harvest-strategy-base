//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/utils/ERC721HolderUpgradeable.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/interface/ICLVault.sol";
import "../../base/upgradability/BaseUpgradeableStrategyCL.sol";
import "../../base/interface/aerodrome/ICLGauge.sol";
import "../../base/interface/concentrated-liquidity/INonfungiblePositionManager.sol";

contract AerodromeCLStrategy is BaseUpgradeableStrategyCL, ERC721HolderUpgradeable {

  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  address public constant harvestMSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);

  // this would be reset on each upgrade
  address[] public rewardTokens;

  constructor() BaseUpgradeableStrategyCL() {
  }

  function initializeBaseStrategy(
    address _storage,
    address _vault,
    address _gauge,
    address _rewardToken
  ) public initializer {

    BaseUpgradeableStrategyCL.initialize(
      _storage,
      _vault,
      _gauge,
      _rewardToken,
      harvestMSIG
    );
  }

  function _nftStaked() internal view returns (bool staked) {
    staked = INonfungiblePositionManager(posManager()).ownerOf(posId()) == rewardPool();
  }

  function _nftInStrategy() internal view returns (bool inStrategy) {
    inStrategy = INonfungiblePositionManager(posManager()).ownerOf(posId()) == address(this);
  }

  function _emergencyExitRewardPool() internal {
    _withdraw();
  }

  function _withdraw() internal {
    if (_nftStaked()) {
      ICLGauge(rewardPool()).withdraw(posId());
    }
  }

  function _stake() internal {
    address _rewardPool = rewardPool();
    uint256 _posId = posId();
    IERC721(posManager()).approve(_rewardPool, _posId);
    ICLGauge(_rewardPool).deposit(_posId);
  }

  function _investAllUnderlying() internal onlyNotPausedInvesting {
    if(_nftInStrategy()) {
      _stake();
    }
  }

  /*
  *   In case there are some issues discovered about the pool or underlying asset
  *   Governance can exit the pool properly
  *   The function is only used for emergency to exit the pool
  */
  function emergencyExit() public onlyGovernance {
    _emergencyExitRewardPool();
    _setPausedInvesting(true);
  }

  /*
  *   Resumes the ability to invest into the underlying reward pools
  */
  function continueInvesting() public onlyGovernance {
    _setPausedInvesting(false);
  }

  function unsalvagableTokens(address token) public view returns (bool) {
    return (token == rewardToken());
  }

  function addRewardToken(address _token) public onlyGovernance {
    rewardTokens.push(_token);
  }

  function _liquidateReward() internal {
    if (!sell()) {
      // Profits can be disabled for possible simplified and rapid exit
      emit ProfitsNotCollected(sell(), false);
      return;
    }

    address _rewardToken = rewardToken();
    address _universalLiquidator = universalLiquidator();
    for(uint256 i = 0; i < rewardTokens.length; i++){
      address token = rewardTokens[i];
      uint256 balance = IERC20(token).balanceOf(address(this));
      if (balance == 0) {
        continue;
      }
      if (token != _rewardToken){
        IERC20(token).safeApprove(_universalLiquidator, 0);
        IERC20(token).safeApprove(_universalLiquidator, balance);
        IUniversalLiquidator(_universalLiquidator).swap(token, _rewardToken, balance, 1, address(this));
      }
    }

    uint256 rewardBalance = IERC20(_rewardToken).balanceOf(address(this));
    _notifyProfitInRewardToken(_rewardToken, rewardBalance);
    uint256 remainingRewardBalance = IERC20(_rewardToken).balanceOf(address(this));

    if (remainingRewardBalance < 1e12) {
      return;
    }

    address _token0 = token0();
    address _token1 = token1();

    (uint256 token0Weight ,uint256 token1Weight) = ICLVault(vault()).getCurrentTokenWeights();

    if (_token0 != _rewardToken) {
      IERC20(_rewardToken).safeApprove(_universalLiquidator, 0);
      IERC20(_rewardToken).safeApprove(_universalLiquidator, remainingRewardBalance);
      IUniversalLiquidator(_universalLiquidator).swap(_rewardToken, _token0, remainingRewardBalance, 1, address(this));
    }

    uint256 token0Balance = IERC20(token0()).balanceOf(address(this));
    uint256 token1Balance = IERC20(token1()).balanceOf(address(this));
    (uint256 currentWeight0, uint256 currentWeight1) = _getBalanceWeights(token0Balance, token1Balance);

    if (currentWeight0 < token0Weight) {
      uint256 toToken0 = token1Balance.mul(token0Weight.sub(currentWeight0)).div(1e18);
      if (toToken0 > token1Balance) {
        toToken0 = token1Balance;
      }
      IERC20(_token1).safeApprove(_universalLiquidator, 0);
      IERC20(_token1).safeApprove(_universalLiquidator, toToken0);
      IUniversalLiquidator(_universalLiquidator).swap(_token1, _token0, toToken0, 1, address(this));
    } else if (currentWeight1 < token1Weight) {
      uint256 toToken1 = token0Balance.mul(token1Weight.sub(currentWeight1)).div(1e18);
      if (toToken1 > token0Balance) {
        toToken1 = token0Balance;
      }
      IERC20(_token0).safeApprove(_universalLiquidator, 0);
      IERC20(_token0).safeApprove(_universalLiquidator, toToken1);
      IUniversalLiquidator(_universalLiquidator).swap(_token0, _token1, toToken1, 1, address(this));
    }

    token0Balance = IERC20(_token0).balanceOf(address(this));
    token1Balance = IERC20(_token1).balanceOf(address(this));
    
    address _posManager = posManager();
    // provide token1 and token2 to BaseSwap
    IERC20(_token0).safeApprove(_posManager, 0);
    IERC20(_token0).safeApprove(_posManager, token0Balance);

    IERC20(_token1).safeApprove(_posManager, 0);
    IERC20(_token1).safeApprove(_posManager, token1Balance);

    INonfungiblePositionManager(_posManager).increaseLiquidity(
      INonfungiblePositionManager.IncreaseLiquidityParams({
        tokenId: posId(),
        amount0Desired: token0Balance,
        amount1Desired: token1Balance,
        amount0Min: 0,
        amount1Min: 0,
        deadline: block.timestamp
      })
    );
  }

  function _getBalanceWeights(uint256 token0Balance, uint256 token1Balance) internal view returns (uint256, uint256) {
    uint256 sqrtPrice = uint256(ICLVault(vault()).getSqrtPriceX96());
    uint256 price0In1 = sqrtPrice.mul(sqrtPrice).mul(1e18).div(uint(2**(96 * 2)));
    uint256 totalBalanceIn1 = token0Balance.mul(price0In1).div(1e18).add(token1Balance);
    uint256 currentWeight0 = token0Balance.mul(price0In1).div(totalBalanceIn1);
    uint256 currentWeight1 = token1Balance.mul(1e18).div(totalBalanceIn1);
    uint256 totalWeight = currentWeight0.add(currentWeight1);
    if (totalWeight != 1e18) {
      currentWeight0 = currentWeight0.mul(1e18).div(totalWeight);
      currentWeight1 = uint256(1e18).sub(currentWeight0);
    }
    return (currentWeight0, currentWeight1);
  }


  /*
  *   Withdraws all the asset to the vault
  */
  function withdrawAllToVault(bool compound) public restricted {
    _withdraw();
    if (compound) {
      _liquidateReward();
    }
    if (_nftInStrategy()) {
      IERC721(posManager()).transferFrom(address(this), vault(), posId());
    }
  }

  /*
  *   Governance or Controller can claim coins that are somehow transferred into the contract
  *   Note that they cannot come in take away coins that are used and defined in the strategy itself
  */
  function salvage(address recipient, address token, uint256 amount) external onlyControllerOrGovernance {
     // To make sure that governance cannot come in and take away the coins
    require(!unsalvagableTokens(token), "token is defined as not salvagable");
    IERC20(token).safeTransfer(recipient, amount);
  }

  /*
  *   Get the reward, sell it in exchange for underlying, invest what you got.
  *   It's not much, but it's honest work.
  *
  *   Note that although `onlyNotPausedInvesting` is not added here,
  *   calling `investAllUnderlying()` affectively blocks the usage of `doHardWork`
  *   when the investing is being paused by governance.
  */
  function doHardWork() external onlyNotPausedInvesting restricted {
    _withdraw();
    _liquidateReward();
    _investAllUnderlying();
  }

  function setGauge(address _newGauge) external onlyGovernance {
    _withdraw();
    _liquidateReward();

    _setRewardPool(_newGauge);
    _investAllUnderlying();
  }

  /**
  * Can completely disable claiming UNI rewards and selling. Good for emergency withdraw in the
  * simplest possible way.
  */
  function setSell(bool s) public onlyGovernance {
    _setSell(s);
  }

  function finalizeUpgrade() external virtual onlyGovernance {
    _finalizeUpgrade();
  }
}