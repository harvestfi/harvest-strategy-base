// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/upgradability/BaseUpgradeableStrategy.sol";
import "../../base/interface/moonwell/MTokenInterfaces.sol";
import "../../base/interface/moonwell/ComptrollerInterface.sol";
import "../../base/interface/moonwell/IOracle.sol";
import "../../base/interface/aave/IPool.sol";
import "../../base/interface/weth/IWETH.sol";
import "./MoonwellViewer.sol";

import "hardhat/console.sol";

contract Moonwell2AssetFoldStrategy is BaseUpgradeableStrategy {

  using SafeERC20 for IERC20;

  enum FlashMode { Deposit, Withdraw }

  struct FlashParams {
    FlashMode mode;
    uint256 priceSupplyInBorrow;
    uint256 priceBorrowInSupply;
  }

  struct PositionSnap {
    uint256 suppliedUnderlying;
    uint256 borrowedBorrowAsset;
    uint256 borrowedInUnderlying;
    uint256 priceSupplyInBorrow;
    uint256 priceBorrowInSupply;
    uint256 health;
  }

  address public constant weth = address(0x4200000000000000000000000000000000000006);
  address public constant aavePool = address(0xA238Dd80C259a72e81d7e4664a9801593F98d1c5);
  address public constant harvestMSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);
  uint256 public constant BPS = 10_000;

  // additional storage slots (on top of BaseUpgradeableStrategy ones) are defined here
  bytes32 internal constant _SUPPLY_MTOKEN_SLOT = 0x5919a20ea6473dc6aa03868193793804048516941eec843dfc4ebf83cdee8205;
  bytes32 internal constant _BORROW_ASSET_SLOT = 0x88668f0e8611a9b718d9bea94e199da292e353b63b6c67696d85391874de1323;
  bytes32 internal constant _BORROW_MTOKEN_SLOT = 0xd0502c60148b6da9766e2c3019450fd4c4e9b2a0a434a3542b5bb13b7ba432f2;
  bytes32 internal constant _STORED_BALANCE_SLOT = 0x36be27dce5926377a73445ec8b6a6c16c485af64395bbacfbf8aac4c71f8043b;
  bytes32 internal constant _PENDING_FEE_SLOT = 0x0af7af9f5ccfa82c3497f40c7c382677637aee27293a6243a22216b51481bd97;
  bytes32 internal constant _COLLATERALFACTORNUMERATOR_SLOT = 0x129eccdfbcf3761d8e2f66393221fa8277b7623ad13ed7693a0025435931c64a;
  bytes32 internal constant _BORROWTARGETFACTORNUMERATOR_SLOT = 0xa65533f4b41f3786d877c8fdd4ae6d27ada84e1d9c62ea3aca309e9aa03af1cd;
  bytes32 internal constant _FOLD_SLOT = 0x1841be4c16015a744c9fbf595f7c6b32d40278c16c1fc7cf2de88c6348de44ba;
  bytes32 internal constant _SLIPPAGE_BPS_SLOT = 0x9739c2fea70b5edd7eea812db3dffa2fb7638aaecdd2d30770ef5020cd8b9208;

  // this would be reset on each upgrade
  address[] public rewardTokens;

  constructor() BaseUpgradeableStrategy() {
    assert(_SUPPLY_MTOKEN_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.supplyMToken")) - 1));
    assert(_BORROW_ASSET_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.borrowAsset")) - 1));
    assert(_BORROW_MTOKEN_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.borrowMToken")) - 1));
    assert(_STORED_BALANCE_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.storedBalance")) - 1));
    assert(_PENDING_FEE_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.pendingFee")) - 1));
    assert(_COLLATERALFACTORNUMERATOR_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.collateralFactorNumerator")) - 1));
    assert(_BORROWTARGETFACTORNUMERATOR_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.borrowTargetFactorNumerator")) - 1));
    assert(_FOLD_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.fold")) - 1));
    assert(_SLIPPAGE_BPS_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.slippageBps")) - 1));
  }

  function initializeBaseStrategy(
    address _storage,
    address _underlying,
    address _vault,
    address _supplyMToken,
    address _borrowAsset,
    address _borrowMToken,
    address _comptroller,
    address _rewardToken,
    uint256 _borrowTargetFactorNumerator,
    uint256 _collateralFactorNumerator,
    uint256 _slippageBps,
    bool _fold
  ) public initializer {
    BaseUpgradeableStrategy.initialize(
      _storage,
      _underlying,
      _vault,
      _comptroller,
      _rewardToken,
      harvestMSIG
    );

    require(MErc20Interface(_supplyMToken).underlying() == _underlying, "und");
    require(MErc20Interface(_borrowMToken).underlying() == _borrowAsset, "borrowAsset");

    _setSupplyMToken(_supplyMToken);
    _setBorrowAsset(_borrowAsset);
    _setBorrowMToken(_borrowMToken);

    require(_collateralFactorNumerator < BPS, "col");
    require(_borrowTargetFactorNumerator < _collateralFactorNumerator, "bor");
    setUint256(_COLLATERALFACTORNUMERATOR_SLOT, _collateralFactorNumerator);
    setUint256(_BORROWTARGETFACTORNUMERATOR_SLOT, _borrowTargetFactorNumerator);
    setBoolean(_FOLD_SLOT, _fold);
    require(_slippageBps < 500, "slip");
    setUint256(_SLIPPAGE_BPS_SLOT, _slippageBps);
    address[] memory markets = new address[](1);
    markets[0] = _supplyMToken;
    ComptrollerInterface(_comptroller).enterMarkets(markets);
  }

  function _snapPosition() internal returns (PositionSnap memory s) {
    address _supplyMToken = supplyMToken();
    address _borrowMToken = borrowMToken();

    s.priceSupplyInBorrow = MoonwellViewer(address(0x8ccCD2467adD6053c8273042ac742Eb438444389)).getPrice(_supplyMToken, _borrowMToken);
    s.priceBorrowInSupply = MoonwellViewer(address(0x8ccCD2467adD6053c8273042ac742Eb438444389)).getPrice(_borrowMToken, _supplyMToken);
    
    s.suppliedUnderlying = MTokenInterface(_supplyMToken).balanceOfUnderlying(address(this));
    s.borrowedBorrowAsset = MTokenInterface(_borrowMToken).borrowBalanceCurrent(address(this));

    s.borrowedInUnderlying = (s.borrowedBorrowAsset * s.priceBorrowInSupply) / 1e18;

    s.health = MoonwellViewer(address(0x8ccCD2467adD6053c8273042ac742Eb438444389)).getPositionHealth(_supplyMToken, _borrowMToken, collateralFactorNumerator());
  }

  function _currentBalance(PositionSnap memory s) internal pure returns (uint256) {
    // supplied - borrowed(value in underlying)
    return s.suppliedUnderlying - s.borrowedInUnderlying;
  }

  function currentBalance() public returns (uint256) {
    PositionSnap memory s = _snapPosition();
    return _currentBalance(s);
  }

  function positionSnap() external returns (PositionSnap memory) {
    return _snapPosition();
  }

  function targetHealth() public view returns (uint256) {
    if (!fold() || borrowTargetFactorNumerator() == 0) {
      return type(uint256).max;
    }
    return (uint256(collateralFactorNumerator()) * 1e18) / borrowTargetFactorNumerator();
  }

  // function checker() external view returns (bool canExec, bytes memory execPayload) {
  //   uint256 health = MoonwellViewer(address(0x8ccCD2467adD6053c8273042ac742Eb438444389)).getPositionHealth(supplyMToken(), borrowMToken(), collateralFactorNumerator());
  //   canExec = health < (targetHealth() * 99) / 100;
  //   execPayload = abi.encodeWithSelector(IController.doHardWork.selector, vault());
  // }

  function storedBalance() public view returns (uint256) {
    return getUint256(_STORED_BALANCE_SLOT);
  }

  function _updateStoredBalance() internal {
    uint256 balance = currentBalance();
    setUint256(_STORED_BALANCE_SLOT, balance);
  }

  function totalFeeNumerator() public view returns (uint256) {
    return strategistFeeNumerator() + platformFeeNumerator() + profitSharingNumerator();
  }

  function pendingFee() public view returns (uint256) {
    return getUint256(_PENDING_FEE_SLOT);
  }

  function _accrueFee() internal {
    PositionSnap memory s = _snapPosition();
    uint256 cur = _currentBalance(s);
    uint256 prev = storedBalance();
    uint256 fee = 0;
    if (cur > prev) {
      uint256 balanceIncrease = cur - prev;
      fee = (balanceIncrease * totalFeeNumerator()) / feeDenominator();
    }
    setUint256(_PENDING_FEE_SLOT, pendingFee() + fee);
    setUint256(_STORED_BALANCE_SLOT, cur);
  }

  function _handleFee() internal {
    _accrueFee();
    uint256 fee = pendingFee();
    if (fee > 1e13) {
      _redeem(fee);
      address _underlying = underlying();
      fee = Math.min(fee, IERC20(_underlying).balanceOf(address(this)));
      uint256 balanceIncrease = (fee * feeDenominator()) / totalFeeNumerator();
      _notifyProfitInRewardToken(_underlying, balanceIncrease);
      setUint256(_PENDING_FEE_SLOT, pendingFee() - fee);
    }
  }

  function depositArbCheck() public pure returns (bool) {
    // there's no arb here.
    return true;
  }

  function unsalvagableTokens(address token) public view returns (bool) {
    return (
      token == rewardToken() ||
      token == underlying() ||
      token == supplyMToken() ||
      token == borrowAsset() ||
      token == borrowMToken()
    );
  }

  /**
  * The strategy invests by supplying the underlying as a collateral.
  */
  function _investAllUnderlying() internal onlyNotPausedInvesting {
    address _underlying = underlying();
    uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));
    uint256 before = currentBalance();
    console.log("underlyingBalance to invest:", underlyingBalance);
    if (underlyingBalance > 0) _supply(underlyingBalance);

    if (fold()) {
      PositionSnap memory s = _snapPosition();
      _depositWithFlashloan(s);
    }
    if (underlyingBalance > 0) {
      console.log("increase in position:", currentBalance() - before);
      console.log("proportion:", ((currentBalance() - before) * 10000) / underlyingBalance);
    }
  }

  /**
  * Exits Moonwell and transfers everything to the vault.
  */
  function withdrawAllToVault() public restricted {
    address _underlying = underlying();
    _withdrawMaximum(true);
    if (IERC20(_underlying).balanceOf(address(this)) > 0) {
      IERC20(_underlying).safeTransfer(vault(), IERC20(_underlying).balanceOf(address(this)) - pendingFee());
    }
    _updateStoredBalance();
  }

  function emergencyExit() external onlyGovernance {
    _withdrawMaximum(false);
    _updateStoredBalance();
  }

  function _withdrawMaximum(bool claim) internal {
    if (claim) {
      _handleFee();
      _claimRewards();
      _liquidateRewards();
    } else {
      _accrueFee();
    }
    _redeemMaximum();
  }

  function withdrawToVault(uint256 amountUnderlying) public restricted {
    _accrueFee();
    address _underlying = underlying();
    uint256 balance = IERC20(_underlying).balanceOf(address(this));
    if (amountUnderlying <= balance) {
      IERC20(_underlying).safeTransfer(vault(), amountUnderlying);
      return;
    }
    uint256 positionBalanceBefore = currentBalance();
    uint256 toRedeem = amountUnderlying - balance;
    // get some of the underlying
    _redeemPartial(toRedeem);
    uint256 positionChange = positionBalanceBefore - currentBalance();
    if (positionChange > toRedeem) {
      amountUnderlying = amountUnderlying - (positionChange - toRedeem);
    }

    // transfer the amount requested (or the amount we have) back to vault()
    IERC20(_underlying).safeTransfer(vault(), amountUnderlying);
    balance = IERC20(_underlying).balanceOf(address(this));
    if (balance > 0) {
      _investAllUnderlying();
    }
    _updateStoredBalance();
  }

  /**
  * Withdraws all assets, liquidates XVS, and invests again in the required ratio.
  */
  function doHardWork() public restricted {
    _handleFee();
    _claimRewards();
    _liquidateRewards();
    _investAllUnderlying();
    _updateStoredBalance();
  }

  /**
  * Redeems maximum that can be redeemed from Venus.
  * Redeem the minimum of the underlying we own, and the underlying that the vToken can
  * immediately retrieve. Ensures that `redeemMaximum` doesn't fail silently.
  *
  * DOES NOT ensure that the strategy vUnderlying balance becomes 0.
  */
  function _redeemMaximum() internal {
    _redeemMaximumWithFlashloan();
  }

  /**
  * Redeems `amountUnderlying` or fails.
  */
  function _redeemPartial(uint256 amountUnderlying) internal {
    address _underlying = underlying();
    uint256 balanceBefore = IERC20(_underlying).balanceOf(address(this));
    _redeemWithFlashloan(
      amountUnderlying,
      fold()? borrowTargetFactorNumerator():0
    );
    uint256 balanceAfter = IERC20(_underlying).balanceOf(address(this));
    require(balanceAfter - balanceBefore >= amountUnderlying, "with amt");
  }

  /**
  * Salvages a token.
  */
  function salvage(address recipient, address token, uint256 amount) public onlyGovernance {
    // To make sure that governance cannot come in and take away the coins
    require(!unsalvagableTokens(token), "!salv");
    IERC20(token).safeTransfer(recipient, amount);
  }

  function _claimRewards() internal {
    ComptrollerInterface(rewardPool()).claimReward();
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
      if (token != _rewardToken && balance > 1e18){
        IERC20(token).safeApprove(_universalLiquidator, 0);
        IERC20(token).safeApprove(_universalLiquidator, balance);
        IUniversalLiquidator(_universalLiquidator).swap(token, _rewardToken, balance, 1, address(this));
      }
    }
    uint256 rewardBalance = IERC20(_rewardToken).balanceOf(address(this));

    if (rewardBalance < 1e18) {
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

  /**
  * Returns the current balance.
  */
  function investedUnderlyingBalance() public view returns (uint256) {
    uint256 balance = IERC20(underlying()).balanceOf(address(this));
    return balance + storedBalance() - pendingFee();
  }

  /**
  * Supplies to Moonwel
  */
  function _supply(uint256 amount) internal {
    if (amount == 0){
      return;
    }
    address _underlying = underlying();
    address _supplyMToken = supplyMToken();
    uint256 exchange = MTokenInterface(_supplyMToken).exchangeRateCurrent();
    if (amount < exchange / 1e18){
      return;
    }
    IERC20(_underlying).safeApprove(_supplyMToken, 0);
    IERC20(_underlying).safeApprove(_supplyMToken, amount);
    MErc20Interface(_supplyMToken).mint(amount);
  }

  /**
  * Borrows against the collateral
  */
  function _borrow(uint256 amountUnderlying) internal {
    if (amountUnderlying == 0){
      return;
    }
    // Borrow, check the balance for this contract's address
    MErc20Interface(borrowMToken()).borrow(amountUnderlying);
    if(borrowAsset() == weth){
      IWETH(weth).deposit{value: address(this).balance}();
    }
  }

  function _redeem(uint256 amountUnderlying) internal {
    address _supplyMToken = supplyMToken();
    uint256 exchange = MTokenInterface(_supplyMToken).exchangeRateCurrent();
    if (amountUnderlying < exchange / 1e18){
      MErc20Interface(_supplyMToken).redeem(1);
      if(underlying() == weth){
        IWETH(weth).deposit{value: address(this).balance}();
      }
      return;
    }
    uint256 supplied = MTokenInterface(supplyMToken()).balanceOfUnderlying(address(this));
    if (amountUnderlying >= supplied) {
      MErc20Interface(_supplyMToken).redeem(MTokenInterface(supplyMToken()).balanceOf(address(this)));
      if(underlying() == weth){
        IWETH(weth).deposit{value: address(this).balance}();
      }
      return;
    }
    MErc20Interface(_supplyMToken).redeemUnderlying(amountUnderlying);
    if(underlying() == weth){
      IWETH(weth).deposit{value: address(this).balance}();
    }
  }

  function _repay(uint256 amountUnderlying) internal {
    if (amountUnderlying == 0){
      return;
    }
    address _borrowAsset = borrowAsset();
    address _borrowMToken = borrowMToken();
    IERC20(_borrowAsset).safeApprove(_borrowMToken, 0);
    IERC20(_borrowAsset).safeApprove(_borrowMToken, amountUnderlying);
    MErc20Interface(_borrowMToken).repayBorrow(amountUnderlying);
  }

  function _redeemMaximumWithFlashloan() internal {
    address _supplyMToken = supplyMToken();
    // amount of liquidity in Radiant
    uint256 available = MTokenInterface(_supplyMToken).getCash();
    uint256 balance = currentBalance() - pendingFee();

    _redeemWithFlashloan(Math.min(available, balance), 0);
    uint256 supplied = MTokenInterface(_supplyMToken).balanceOfUnderlying(address(this));
    if (supplied > 0) {
      _redeem(type(uint).max);
    }
  }

  function _depositWithFlashloan(PositionSnap memory s) internal {
    uint _borrowNum = borrowTargetFactorNumerator();

    uint256 _targetHealth = targetHealth();
    if (s.health < (_targetHealth * 99) / 100) {
      _redeemPartial(0);
      return;
    }
    if (s.health < (_targetHealth * 101) / 100) {
      _handleDust(s);
      return;
    }

    uint256 balance = _currentBalance(s);
    uint256 borrowTarget = (((balance * _borrowNum) / (BPS - _borrowNum)) * s.priceSupplyInBorrow) / 1e18;
    
    uint256 borrowDiff = 0;
    if (borrowTarget > s.borrowedBorrowAsset) {
      borrowDiff = borrowTarget - s.borrowedBorrowAsset;
    }

    if (borrowDiff > 0) {
      bytes memory params = abi.encode(FlashParams({
        mode: FlashMode.Deposit,
        priceSupplyInBorrow: s.priceSupplyInBorrow,
        priceBorrowInSupply: s.priceBorrowInSupply
      }));
      IPool(aavePool).flashLoanSimple(
        address(this),
        borrowAsset(),
        borrowDiff,
        params,
        0
      );
    }
    _handleDust(s);
  }

  function _redeemWithFlashloan(uint256 amount, uint256 _borrowTargetFactorNumerator) internal {
    PositionSnap memory s = _snapPosition();
    
    uint256 oldBalance = _currentBalance(s);
    uint256 newBalance = oldBalance - amount;

    uint256 newBorrowTarget = (((newBalance * _borrowTargetFactorNumerator) / (BPS - _borrowTargetFactorNumerator)) * s.priceSupplyInBorrow) / 1e18;
    
    uint256 borrowDiff = 0;
    if (s.borrowedBorrowAsset > newBorrowTarget) {
      borrowDiff = s.borrowedBorrowAsset - newBorrowTarget;
    }
    
    uint256 borrowDiffInUnderlying = (borrowDiff * s.priceBorrowInSupply) / 1e18;

    if (borrowDiffInUnderlying > 0) {
      bytes memory params = abi.encode(FlashParams({
        mode: FlashMode.Withdraw,
        priceSupplyInBorrow: s.priceSupplyInBorrow,
        priceBorrowInSupply: s.priceBorrowInSupply
      }));
      IPool(aavePool).flashLoanSimple(
        address(this),
        underlying(),
        (borrowDiffInUnderlying * (BPS + slippageBps())) / BPS,
        params,
        0
      );
    }
    _redeem(amount);
  }

  function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes memory params) external nonReentrant() returns (bool) {
    require(msg.sender == address(aavePool), "not aave pool");
    require(initiator == address(this), "not initiated");
    FlashParams memory flashParams = abi.decode(params, (FlashParams));
    uint256 toRepay = amount + premium;
    
    if (flashParams.mode == FlashMode.Deposit){
      _onFlashDeposit(asset, amount, toRepay, flashParams.priceSupplyInBorrow, flashParams.priceBorrowInSupply);
    } else {
      _onFlashWithdraw(asset, amount, toRepay, flashParams.priceSupplyInBorrow, flashParams.priceBorrowInSupply);
    }

    IERC20(asset).safeApprove(aavePool, 0);
    IERC20(asset).safeApprove(aavePool, type(uint256).max);

    return true;
  }

  function _onFlashDeposit(address asset, uint256 amount, uint256 toRepay, uint256 priceSupplyInBorrow, uint256 priceBorrowInSupply) internal {
    address _underlying = underlying();
    _swap(asset, _underlying, amount, priceSupplyInBorrow, priceBorrowInSupply);
    _supply(IERC20(_underlying).balanceOf(address(this)));
    _borrow(toRepay);
  }

  function _onFlashWithdraw(address asset, uint256 amount, uint256 toRepay, uint256 priceSupplyInBorrow, uint256 priceBorrowInSupply) internal {
    address _borrowMToken = borrowMToken();
    address _borrowAsset = borrowAsset();
    _swap(asset, _borrowAsset, amount, priceSupplyInBorrow, priceBorrowInSupply);
    uint256 balance = IERC20(_borrowAsset).balanceOf(address(this));
    uint256 borrowed = MTokenInterface(_borrowMToken).borrowBalanceCurrent(address(this));
    uint256 repaying = Math.min(balance, borrowed);
    _repay(repaying);
    _redeem(toRepay);
  }

  function _minOut(
    address from,
    address to,
    uint256 amount,
    uint256 priceSupplyInBorrow,
    uint256 priceBorrowInSupply
  ) internal view returns (uint256) {
    uint256 bps = BPS - slippageBps();
    address _underlying = underlying();
    address _borrowAsset = borrowAsset();
    if (from == _underlying && to == _borrowAsset) {
      // underlying -> borrowAsset
      uint256 oracleOut = (amount * priceSupplyInBorrow) / 1e18;
      return (oracleOut * bps) / BPS;
    }
    if (from == _borrowAsset && to == _underlying) {
      // borrowAsset -> underlying
      uint256 oracleOut = (amount * priceBorrowInSupply) / 1e18;
      return (oracleOut * bps) / BPS;
    }
    revert("swap pair not allowed");
  }

  function _swap(address from, address to, uint256 amount, uint256 priceSupplyInBorrow, uint256 priceBorrowInSupply) internal {
    address _universalLiquidator = universalLiquidator();
    IERC20(from).safeApprove(_universalLiquidator, 0);
    IERC20(from).safeApprove(_universalLiquidator, amount);
    uint256 minOut = _minOut(from, to, amount, priceSupplyInBorrow, priceBorrowInSupply);
    IUniversalLiquidator(_universalLiquidator).swap(from, to, amount, minOut, address(this));

    console.log("Swap amount:", amount);
    uint256 oraclePrice = from == underlying() ? priceSupplyInBorrow : priceBorrowInSupply;
    console.log("oraclePrice:", oraclePrice);
    uint256 swappedAmount = IERC20(to).balanceOf(address(this));
    uint256 effectivePrice = (swappedAmount * 1e18) / amount;
    console.log("marketPrice:", effectivePrice);
    console.log("proportion:", (effectivePrice * 1000000) / oraclePrice);
  }

  function _handleDust(PositionSnap memory s) internal {
    uint256 baBalance = IERC20(borrowAsset()).balanceOf(address(this));
    uint256 borrowed = MTokenInterface(borrowMToken()).borrowBalanceCurrent(address(this));
    if (baBalance > 0) {
      if (borrowed > 0) _repay(Math.min(baBalance, borrowed));
      if (baBalance > borrowed) {
        _swap(borrowAsset(), underlying(), baBalance - borrowed, s.priceSupplyInBorrow, s.priceBorrowInSupply);
      }
    }
    _supply(IERC20(underlying()).balanceOf(address(this)));
  }

  // updating collateral factor
  // note 1: one should settle the loan first before calling this
  // note 2: collateralFactorDenominator is 10_000, therefore, for 20%, you need 2000
  function _setCollateralFactorNumerator(uint256 _numerator) public onlyGovernance {
    require(_numerator <= BPS, "coll-");
    require(_numerator > borrowTargetFactorNumerator(), "coll+");
    setUint256(_COLLATERALFACTORNUMERATOR_SLOT, _numerator);
  }

  function collateralFactorNumerator() public view returns (uint256) {
    return getUint256(_COLLATERALFACTORNUMERATOR_SLOT);
  }

  function setBorrowTargetFactorNumerator(uint256 _numerator) public onlyGovernance {
    require(_numerator < collateralFactorNumerator(), "Bor");
    setUint256(_BORROWTARGETFACTORNUMERATOR_SLOT, _numerator);
  }

  function borrowTargetFactorNumerator() public view returns (uint256) {
    return getUint256(_BORROWTARGETFACTORNUMERATOR_SLOT);
  }

  function setFold (bool _fold) public onlyGovernance {
    if (!_fold) {
      setBorrowTargetFactorNumerator(0);
      _redeemPartial(0);  
      uint256 borrowed = MTokenInterface(borrowMToken()).borrowBalanceCurrent(address(this));
      require (borrowed == 0, "setFold");
    }
    setBoolean(_FOLD_SLOT, _fold);
  }

  function fold() public view returns (bool) {
    return getBoolean(_FOLD_SLOT);
  }

  function setSlippageBps (uint256 _slippageBps) public onlyGovernance {
    require(_slippageBps <= 500, "slip");
    setUint256(_SLIPPAGE_BPS_SLOT, _slippageBps);
  }

  function slippageBps() public view returns (uint256) {
    return getUint256(_SLIPPAGE_BPS_SLOT);
  }

  function _setSupplyMToken (address _target) internal {
    setAddress(_SUPPLY_MTOKEN_SLOT, _target);
  }

  function supplyMToken() public view returns (address) {
    return getAddress(_SUPPLY_MTOKEN_SLOT);
  }

  function _setBorrowAsset (address _target) internal {
    setAddress(_BORROW_ASSET_SLOT, _target);
  }

  function borrowAsset() public view returns (address) {
    return getAddress(_BORROW_ASSET_SLOT);
  }

  function _setBorrowMToken (address _target) internal {
    setAddress(_BORROW_MTOKEN_SLOT, _target);
  }

  function borrowMToken() public view returns (address) {
    return getAddress(_BORROW_MTOKEN_SLOT);
  }

  function finalizeUpgrade() external onlyGovernance {
    _finalizeUpgrade();
    _updateStoredBalance();
  }

  receive() external payable {}
}