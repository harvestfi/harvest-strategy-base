// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/upgradability/BaseUpgradeableStrategy.sol";
import "../../base/interface/morpho/IMorpho.sol";
import "../../base/interface/IRewardPrePay.sol";

contract MorphoMarketStrategy is BaseUpgradeableStrategy {

  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  address public constant harvestMSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);
  address public constant morphoMorpho = address(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);

  // additional storage slots (on top of BaseUpgradeableStrategy ones) are defined here
  bytes32 internal constant _MARKET_ID_SLOT = 0x54fed29e040f8360ca8b822de4be5728a7f0714b74e8d5dd23a1d1ac0c75c6a7;
  bytes32 internal constant _STORED_SUPPLIED_SLOT = 0x280539da846b4989609abdccfea039bd1453e4f710c670b29b9eeaca0730c1a2;
  bytes32 internal constant _PENDING_FEE_SLOT = 0x0af7af9f5ccfa82c3497f40c7c382677637aee27293a6243a22216b51481bd97;

    // this would be reset on each upgrade
  address[] public rewardTokens;

  mapping(address => uint256) public rewardBalanceLast;
  mapping(address => uint256) public lastRewardTime;
  mapping(address => uint256) public rewardPerSec;
  mapping(address => uint256) public distributionTime;

  constructor() BaseUpgradeableStrategy() {
    assert(_MARKET_ID_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.marketId")) - 1));
    assert(_STORED_SUPPLIED_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.storedSupplied")) - 1));
    assert(_PENDING_FEE_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.pendingFee")) - 1));
  }

  function initializeBaseStrategy(
    address _storage,
    address _underlying,
    address _vault,
    address _rewardToken,
    bytes32 _marketId
  )
  public initializer {
    BaseUpgradeableStrategy.initialize(
      _storage,
      _underlying,
      _vault,
      morphoMorpho,
      _rewardToken,
      harvestMSIG
    );

    MarketParams memory m = IMorpho(morphoMorpho).idToMarketParams(Id.wrap(_marketId));
    require(m.loanToken == _underlying, "Underlying mismatch");
    _setMarketId(_marketId);
  }

  function currentSupplied() public view returns (uint256) {
    Id _marketId = marketId();
    Market memory m = IMorpho(morphoMorpho).market(_marketId);
    Position memory p = IMorpho(morphoMorpho).position(_marketId, address(this));
    return p.supplyShares.mul(m.totalSupplyAssets).div(m.totalSupplyShares);
  }

  function storedSupplied() public view returns (uint256) {
    return getUint256(_STORED_SUPPLIED_SLOT);
  }

  function _updateStoredSupplied() internal {
    setUint256(_STORED_SUPPLIED_SLOT, currentSupplied());
  }

  function totalFeeNumerator() public view returns (uint256) {
    return strategistFeeNumerator().add(platformFeeNumerator()).add(profitSharingNumerator());
  }

  function pendingFee() public view returns (uint256) {
    return getUint256(_PENDING_FEE_SLOT);
  }

  function _accrueFee() internal {
    IMorpho(morphoMorpho).accrueInterest(IMorpho(morphoMorpho).idToMarketParams(marketId()));
    uint256 fee;
    if (currentSupplied() > storedSupplied()) {
      uint256 balanceIncrease = currentSupplied().sub(storedSupplied());
      fee = balanceIncrease.mul(totalFeeNumerator()).div(feeDenominator());
    }
    setUint256(_PENDING_FEE_SLOT, pendingFee().add(fee));
  }

  function _handleFee() internal {
    _accrueFee();
    uint256 fee = pendingFee();
    if (fee > 1e4) {
      _redeem(fee);
      address _underlying = underlying();
      fee = Math.min(fee, IERC20(_underlying).balanceOf(address(this)));
      uint256 balanceIncrease = fee.mul(feeDenominator()).div(totalFeeNumerator());
      _notifyProfitInRewardToken(_underlying, balanceIncrease);
      setUint256(_PENDING_FEE_SLOT, pendingFee().sub(fee));
    }
  }
  
  function depositArbCheck() public pure returns (bool) {
    // there's no arb here.
    return true;
  }

  function unsalvagableTokens(address token) public view returns (bool) {
    return (token == underlying());
  }

  /**
  * Exits Moonwell and transfers everything to the vault.
  */
  function withdrawAllToVault() public restricted {
    address _underlying = underlying();
    _handleFee();
    _liquidateRewards();
    _redeemMaximum();
    if (IERC20(_underlying).balanceOf(address(this)) > 0) {
      IERC20(_underlying).safeTransfer(vault(), IERC20(_underlying).balanceOf(address(this)));
    }
    _updateStoredSupplied();
  }

  function emergencyExit() external onlyGovernance {
    _accrueFee();
    _redeemMaximum();
    _updateStoredSupplied();
  }

  function withdrawToVault(uint256 amountUnderlying) public restricted {
    _accrueFee();
    address _underlying = underlying();
    uint256 balance = IERC20(_underlying).balanceOf(address(this));
    if (amountUnderlying <= balance) {
      IERC20(_underlying).safeTransfer(vault(), amountUnderlying);
      return;
    }
    uint256 toRedeem = amountUnderlying.sub(balance);
    // get some of the underlying
    _redeem(toRedeem);
    // transfer the amount requested (or the amount we have) back to vault()
    IERC20(_underlying).safeTransfer(vault(), amountUnderlying);
    balance = IERC20(_underlying).balanceOf(address(this));
    if (balance > 1e4) {
      _supply(balance);
    }
    _updateStoredSupplied();
  }

  function addRewardToken(address _token) public onlyGovernance {
    rewardTokens.push(_token);
  }

  function _liquidateRewards() internal {
    if (!sell()) {
      // Profits can be disabled for possible simplified and rapid exit
      emit ProfitsNotCollected(sell(), false);
      return;
    }
    address _rewardToken = rewardToken();
    address _universalLiquidator = universalLiquidator();
    for (uint256 i; i < rewardTokens.length; i++) {
      address token = rewardTokens[i];
      uint256 balance = IERC20(token).balanceOf(address(this));
      if (balance > rewardBalanceLast[token] || rewardBalanceLast[token] == 0) {
        _updateDist(balance, token);
      }
      balance = _getAmt(token);
      if (balance > 0 && token != _rewardToken){
        IERC20(token).safeApprove(_universalLiquidator, 0);
        IERC20(token).safeApprove(_universalLiquidator, balance);
        IUniversalLiquidator(_universalLiquidator).swap(token, _rewardToken, balance, 1, address(this));
      }
    }
    uint256 rewardBalance = IERC20(_rewardToken).balanceOf(address(this));
    if (rewardBalance <= 1e12) {
      return;
    }
    _notifyProfitInRewardToken(_rewardToken, rewardBalance);
    uint256 remainingRewardBalance = IERC20(_rewardToken).balanceOf(address(this));
  
    address _underlying = underlying();
    if (_underlying != _rewardToken) {
      IERC20(_rewardToken).safeApprove(_universalLiquidator, 0);
      IERC20(_rewardToken).safeApprove(_universalLiquidator, remainingRewardBalance);
      IUniversalLiquidator(_universalLiquidator).swap(_rewardToken, _underlying, remainingRewardBalance, 1, address(this));
    }
  }

  function _updateDist(uint256 balance, address token) internal {
    rewardBalanceLast[token] = balance;
    if (distributionTime[token] > 0) {
      lastRewardTime[token] = lastRewardTime[token] < block.timestamp.sub(distributionTime[token]) ? 
        block.timestamp.sub(distributionTime[token].div(20)) : lastRewardTime[token];
      rewardPerSec[token] = balance.div(distributionTime[token]);
    }
  }

  function _getAmt(address token) internal returns (uint256) {
    uint256 balance = IERC20(token).balanceOf(address(this));
    if (distributionTime[token] == 0) {
      return balance;
    }
    uint256 earned = Math.min(block.timestamp.sub(lastRewardTime[token]).mul(rewardPerSec[token]), balance);
    rewardBalanceLast[token] = balance.sub(earned);
    lastRewardTime[token] = block.timestamp;
    return earned;
  }

  /**
  * Withdraws all assets, liquidates XVS, and invests again in the required ratio.
  */
  function doHardWork() public restricted {
    _handleFee();
    _claimGeneralIncentives();
    _liquidateRewards();
    _supply(IERC20(underlying()).balanceOf(address(this)));
    _updateStoredSupplied();
  }

  /**
  * Salvages a token.
  */
  function salvage(address recipient, address token, uint256 amount) public onlyGovernance {
    // To make sure that governance cannot come in and take away the coins
    require(!unsalvagableTokens(token), "token is defined as not salvagable");
    IERC20(token).safeTransfer(recipient, amount);
  }

  /**
  * Returns the current balance.
  */
  function investedUnderlyingBalance() public view returns (uint256) {
    // underlying in this strategy + underlying redeemable from Radiant - debt
    return IERC20(underlying()).balanceOf(address(this))
    .add(storedSupplied())
    .sub(pendingFee());
  }

  /**
  * Supplies to Moonwel
  */
  function _supply(uint256 amount) internal {
    if (amount == 0){
      return;
    }
    address _underlying = underlying();
    IERC20(_underlying).safeApprove(morphoMorpho, 0);
    IERC20(_underlying).safeApprove(morphoMorpho, amount);
    IMorpho(morphoMorpho).supply(
      IMorpho(morphoMorpho).idToMarketParams(marketId()),
      amount,
      0,
      address(this),
      bytes("")
    );
  }

  function _redeem(uint256 amountUnderlying) internal {
    if (amountUnderlying == 0){
      return;
    }
    IMorpho(morphoMorpho).withdraw(
      IMorpho(morphoMorpho).idToMarketParams(marketId()),
      amountUnderlying,
      0,
      address(this),
      address(this)
    );
  }

  function _redeemMaximum() internal {
    if (currentSupplied() > 0) {
      Position memory p = IMorpho(morphoMorpho).position(marketId(), address(this));
      IMorpho(morphoMorpho).withdraw(
        IMorpho(morphoMorpho).idToMarketParams(marketId()),
        0,
        p.supplyShares,
        address(this),
        address(this)
      );
    }
  }

  function _setMarketId (bytes32 _target) internal {
    setBytes32(_MARKET_ID_SLOT, _target);
  }

  function marketId() public view returns (Id) {
    bytes32 _marketId = getBytes32(_MARKET_ID_SLOT);
    return Id.wrap(_marketId);
  }

  function finalizeUpgrade() external virtual onlyGovernance {
    _finalizeUpgrade();
  }

  function setDistributionTime(address token, uint256 time) external onlyGovernance {
    distributionTime[token] = time;
  }

  receive() external payable {}
}