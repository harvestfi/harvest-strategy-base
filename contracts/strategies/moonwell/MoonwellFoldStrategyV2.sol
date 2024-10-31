// SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/upgradability/BaseUpgradeableStrategy.sol";
import "../../base/interface/moonwell/MTokenInterfaces.sol";
import "../../base/interface/moonwell/ComptrollerInterface.sol";
import "../../base/interface/balancer/IBVault.sol";
import "../../base/interface/weth/IWETH.sol";

/**
 * @title MoonwellFoldStrategyV2
 * @dev Strategy contract to manage assets on the Moonwell lending platform,
 *      allowing folding (reinvesting borrowed assets) for optimized yield.
 */
contract MoonwellFoldStrategyV2 is BaseUpgradeableStrategy {

  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  address public constant weth = address(0x4200000000000000000000000000000000000006);
  address public constant bVault = address(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
  address public constant harvestMSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);

  // Additional storage slots (on top of BaseUpgradeableStrategy ones) are defined here
  bytes32 internal constant _MTOKEN_SLOT = 0x21e6ad38ea5ca89af03560d16f1da9e505dccbd1ec61d0683be425888164fec3;
  bytes32 internal constant _COLLATERALFACTORNUMERATOR_SLOT = 0x129eccdfbcf3761d8e2f66393221fa8277b7623ad13ed7693a0025435931c64a;
  bytes32 internal constant _FACTORDENOMINATOR_SLOT = 0x4e92df66cc717205e8df80bec55fc1429f703d590a2d456b97b74f0008b4a3ee;
  bytes32 internal constant _BORROWTARGETFACTORNUMERATOR_SLOT = 0xa65533f4b41f3786d877c8fdd4ae6d27ada84e1d9c62ea3aca309e9aa03af1cd;
  bytes32 internal constant _FOLD_SLOT = 0x1841be4c16015a744c9fbf595f7c6b32d40278c16c1fc7cf2de88c6348de44ba;

  uint256 public suppliedInUnderlying;
  uint256 public borrowedInUnderlying;

  bool internal makingFlashDeposit;
  bool internal makingFlashWithdrawal;

  // Reward tokens would be reset on each upgrade
  address[] public rewardTokens;

  /**
   * @notice Initializes the strategy and verifies that storage slots are correctly configured.
   */
  constructor() public BaseUpgradeableStrategy() {
    assert(_MTOKEN_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.mToken")) - 1));
    assert(_COLLATERALFACTORNUMERATOR_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.collateralFactorNumerator")) - 1));
    assert(_FACTORDENOMINATOR_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.factorDenominator")) - 1));
    assert(_BORROWTARGETFACTORNUMERATOR_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.borrowTargetFactorNumerator")) - 1));
    assert(_FOLD_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.fold")) - 1));
  }

  /**
   * @notice Sets up the strategy and enters the specified markets on the Moonwell platform.
   * @param _storage The address of the storage contract.
   * @param _underlying The address of the underlying asset for the strategy.
   * @param _vault The address of the vault to manage.
   * @param _mToken The Moonwell token (mToken) representing the asset.
   * @param _comptroller The address of the Comptroller for managing lending markets.
   * @param _rewardToken The address of the reward token (e.g., the token used for yield rewards).
   * @param _borrowTargetFactorNumerator The numerator for calculating the borrow target factor.
   * @param _collateralFactorNumerator The numerator for calculating the collateral factor.
   * @param _factorDenominator The denominator for calculating factors.
   * @param _fold Determines if the strategy should perform folding (recursive borrowing and lending).
   */
  function initializeBaseStrategy(
    address _storage,
    address _underlying,
    address _vault,
    address _mToken,
    address _comptroller,
    address _rewardToken,
    uint256 _borrowTargetFactorNumerator,
    uint256 _collateralFactorNumerator,
    uint256 _factorDenominator,
    bool _fold
  )
  public initializer {
    BaseUpgradeableStrategy.initialize(
      _storage,
      _underlying,
      _vault,
      _comptroller,
      _rewardToken,
      harvestMSIG
    );

    require(MErc20Interface(_mToken).underlying() == _underlying, "Underlying mismatch");

    _setMToken(_mToken);

    require(_collateralFactorNumerator < _factorDenominator, "Numerator should be smaller than denominator");
    require(_borrowTargetFactorNumerator < _collateralFactorNumerator, "Target should be lower than limit");
    _setFactorDenominator(_factorDenominator);
    setUint256(_COLLATERALFACTORNUMERATOR_SLOT, _collateralFactorNumerator);
    setUint256(_BORROWTARGETFACTORNUMERATOR_SLOT, _borrowTargetFactorNumerator);
    setBoolean(_FOLD_SLOT, _fold);
    address[] memory markets = new address[](1);
    markets[0] = _mToken;
    ComptrollerInterface(_comptroller).enterMarkets(markets);
  }

  /**
   * @dev Modifier to update the supply and borrow amounts at the end of function execution.
   */
  modifier updateSupplyInTheEnd() {
    _;
    address _mToken = mToken();
    suppliedInUnderlying = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
    borrowedInUnderlying = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
  }

  /**
   * @notice Checks if a token is unsalvageable (i.e., should not be removed).
   * @param token The address of the token to check.
   * @return True if the token is defined as unsalvageable, false otherwise.
   */
  function unsalvagableTokens(address token) public view returns (bool) {
    return (token == rewardToken() || token == underlying() || token == mToken());
  }

  /**
   * @notice Supplies all available underlying assets as collateral and optionally performs folding.
   */
  function _investAllUnderlying() internal onlyNotPausedInvesting updateSupplyInTheEnd {
    address _underlying = underlying();
    uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));
    if (underlyingBalance > 0) {
      _supply(underlyingBalance);
    }
    if (!fold()) {
      return;
    }
    _depositWithFlashloan();
  }

  /**
   * @notice Withdraws all assets from the lending platform and transfers to the vault.
   */
  function withdrawAllToVault() public restricted updateSupplyInTheEnd {
    address _underlying = underlying();
    _withdrawMaximum(true);
    if (IERC20(_underlying).balanceOf(address(this)) > 0) {
      IERC20(_underlying).safeTransfer(vault(), IERC20(_underlying).balanceOf(address(this)));
    }
  }

  /**
   * @notice Performs an emergency exit, withdrawing all available funds without reinvestment.
   */
  function emergencyExit() external onlyGovernance updateSupplyInTheEnd {
    _withdrawMaximum(false);
  }

  /**
   * @dev Withdraws the maximum possible amount from the lending platform.
   * @param claim Determines if rewards should be claimed and liquidated during withdrawal.
   */
  function _withdrawMaximum(bool claim) internal updateSupplyInTheEnd {
    if (claim) {
      _claimRewards();
      _liquidateRewards();
    }
    _redeemMaximum();
  }

  /**
   * @notice Withdraws a specified amount of underlying assets to the vault.
   * @param amountUnderlying The amount of underlying assets to withdraw.
   */
  function withdrawToVault(uint256 amountUnderlying) public restricted updateSupplyInTheEnd {
    address _underlying = underlying();
    uint256 balance = IERC20(_underlying).balanceOf(address(this));
    if (amountUnderlying <= balance) {
      IERC20(_underlying).safeTransfer(vault(), amountUnderlying);
      return;
    }
    uint256 toRedeem = amountUnderlying.sub(balance);
    _redeemPartial(toRedeem);
    IERC20(_underlying).safeTransfer(vault(), amountUnderlying);
    balance = IERC20(_underlying).balanceOf(address(this));
    if (balance > 0) {
      _investAllUnderlying();
    }
  }

  /**
  * @notice Performs routine actions to maintain the investment strategy.
  * @dev Restricted function to execute key strategy operations:
  * - Claims rewards.
  * - Liquidates rewards to the underlying token.
  * - Invests all underlying tokens into the investment pool.
  */
  function doHardWork() public restricted {
    _claimRewards();
    _liquidateRewards();
    _investAllUnderlying();
  }

  /**
  * @notice Redeems the maximum possible amount using flashloan support.
  * @dev Uses internal flashloan redemption to maximize returns.
  */
  function _redeemMaximum() internal {
    _redeemMaximumWithFlashloan();
  }

  /**
  * @notice Partially redeems a specified amount of the underlying asset.
  * @param amountUnderlying The target amount of underlying tokens to redeem.
  * @dev Requires that the specified amount is successfully redeemed.
  */
  function _redeemPartial(uint256 amountUnderlying) internal {
    address _underlying = underlying();
    uint256 balanceBefore = IERC20(_underlying).balanceOf(address(this));
    _redeemWithFlashloan(
      amountUnderlying,
      fold() ? borrowTargetFactorNumerator() : 0
    );
    uint256 balanceAfter = IERC20(_underlying).balanceOf(address(this));
    require(balanceAfter.sub(balanceBefore) >= amountUnderlying, "Unable to withdraw the entire amountUnderlying");
  }

  /**
  * @notice Transfers salvaged tokens to a specified recipient.
  * @param recipient The address to receive the salvaged tokens.
  * @param token The address of the token to salvage.
  * @param amount The amount of the token to transfer.
  * @dev Restricted to governance. Ensures the token is not unsalvageable.
  */
  function salvage(address recipient, address token, uint256 amount) public onlyGovernance {
    require(!unsalvagableTokens(token), "token is defined as not salvagable");
    IERC20(token).safeTransfer(recipient, amount);
  }

  /**
  * @notice Claims any rewards from the reward pool.
  * @dev Internal function to claim available rewards.
  */
  function _claimRewards() internal {
    ComptrollerInterface(rewardPool()).claimReward();
  }

  /**
  * @notice Adds a new token to the list of reward tokens.
  * @param _token The address of the new reward token to add.
  * @dev Restricted to governance.
  */
  function addRewardToken(address _token) public onlyGovernance {
    rewardTokens.push(_token);
  }

  /**
  * @notice Liquidates all available rewards and converts to the underlying asset.
  * @dev Converts rewards to the underlying token and manages the remaining balance.
  * Emits `ProfitsNotCollected` if rewards are not sold.
  */
  function _liquidateRewards() internal {
    if (!sell()) {
      emit ProfitsNotCollected(sell(), false);
      return;
    }
    address _rewardToken = rewardToken();
    address _universalLiquidator = universalLiquidator();
    for (uint256 i; i < rewardTokens.length; i++) {
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

    if (rewardBalance < 1e8) {
      return;
    }

    _notifyProfitInRewardToken(_rewardToken, rewardBalance);
    uint256 remainingRewardBalance = IERC20(_rewardToken).balanceOf(address(this));

    if (remainingRewardBalance < 1e10) {
      return;
    }
  
    address _underlying = underlying();
    if (_underlying != _rewardToken) {
      IERC20(_rewardToken).safeApprove(_universalLiquidator, 0);
      IERC20(_rewardToken).safeApprove(_universalLiquidator, remainingRewardBalance);
      IUniversalLiquidator(_universalLiquidator).swap(_rewardToken, _underlying, remainingRewardBalance, 1, address(this));
    }
  }

  /**
  * @notice Returns the current balance of the invested underlying assets.
  * @return The total balance of the underlying asset, including supplied and borrowed amounts.
  */
  function investedUnderlyingBalance() public view returns (uint256) {
    return IERC20(underlying()).balanceOf(address(this))
    .add(suppliedInUnderlying)
    .sub(borrowedInUnderlying);
  }

  /**
  * @notice Supplies a specified amount of underlying tokens to the pool.
  * @param amount The amount of underlying tokens to supply.
  * @dev Checks supply cap and adjusts the supply amount if necessary.
  */
  function _supply(uint256 amount) internal {
    if (amount == 0){
      return;
    }
    address _underlying = underlying();
    address _mToken = mToken();
    uint256 balance = IERC20(_underlying).balanceOf(address(this));
    if (amount < balance) {
      balance = amount;
    }
    uint256 supplyCap = ComptrollerInterface(rewardPool()).supplyCaps(_mToken);
    uint256 currentSupplied = MTokenInterface(_mToken).totalSupply().mul(MTokenInterface(_mToken).exchangeRateCurrent()).div(1e18);
    if (currentSupplied >= supplyCap) {
      return;
    } else if (supplyCap.sub(currentSupplied) <= balance) {
      balance = supplyCap.sub(currentSupplied).sub(2);
    }
    IERC20(_underlying).safeApprove(_mToken, 0);
    IERC20(_underlying).safeApprove(_mToken, balance);
    MErc20Interface(_mToken).mint(balance);
  }

  /**
  * @notice Borrows a specified amount of the underlying token.
  * @param amountUnderlying The amount of underlying tokens to borrow.
  * @dev Converts borrowed ETH to WETH if applicable.
  */
  function _borrow(uint256 amountUnderlying) internal {
    if (amountUnderlying == 0){
      return;
    }
    MErc20Interface(mToken()).borrow(amountUnderlying);
    if(underlying() == weth){
      IWETH(weth).deposit{value: address(this).balance}();
    }
  }

  /**
  * @notice Redeems a specified amount of the underlying token.
  * @param amountUnderlying The amount of underlying tokens to redeem.
  * @dev Converts redeemed ETH to WETH if applicable.
  */
  function _redeem(uint256 amountUnderlying) internal {
    if (amountUnderlying == 0){
      return;
    }
    MErc20Interface(mToken()).redeemUnderlying(amountUnderlying);
    if(underlying() == weth){
      IWETH(weth).deposit{value: address(this).balance}();
    }
  }

  /**
  * @notice Repays a specified amount of the underlying token for borrowing.
  * @param amountUnderlying The amount of underlying tokens to repay.
  */
  function _repay(uint256 amountUnderlying) internal {
    if (amountUnderlying == 0){
      return;
    }
    address _underlying = underlying();
    address _mToken = mToken();
    IERC20(_underlying).safeApprove(_mToken, 0);
    IERC20(_underlying).safeApprove(_mToken, amountUnderlying);
    MErc20Interface(_mToken).repayBorrow(amountUnderlying);
  }

  /**
  * @notice Redeems the maximum amount with a flashloan.
  * @dev Utilizes flashloan redemption with capped amounts for maximum liquidity.
  */
  function _redeemMaximumWithFlashloan() internal {
    address _mToken = mToken();
    uint256 available = MTokenInterface(_mToken).getCash();
    uint256 supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
    uint256 borrowed = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
    uint256 balance = supplied.sub(borrowed);

    _redeemWithFlashloan(Math.min(available, balance), 0);
    supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
    if (supplied > 0) {
      _redeem(type(uint).max);
    }
  }

  /**
  * @notice Executes deposit with flashloan support.
  * @dev Calculates the borrow difference and initiates a flashloan if necessary.
  * If borrowDiff is not covered by Balancer's available funds, defaults to `_depositNoFlash`.
  */
  function _depositWithFlashloan() internal {
    address _mToken = mToken();
    uint _denom = factorDenominator();
    uint _borrowNum = borrowTargetFactorNumerator();
    uint256 supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
    uint256 borrowed = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
    uint256 balance = supplied.sub(borrowed);
    uint256 borrowTarget = balance.mul(_borrowNum).div(_denom.sub(_borrowNum));
    uint256 borrowDiff;
    if (borrowed > borrowTarget) {
      _redeemPartial(0);
      borrowDiff = 0;
    } else {
      borrowDiff = borrowTarget.sub(borrowed);
      address _rewardPool = rewardPool();
      uint256 supplyCap = ComptrollerInterface(_rewardPool).supplyCaps(_mToken);
      uint256 currentSupplied = MTokenInterface(_mToken).totalSupply().mul(MTokenInterface(_mToken).exchangeRateCurrent()).div(1e18);
      uint256 borrowCap = ComptrollerInterface(_rewardPool).borrowCaps(_mToken);
      uint256 totalBorrows = MTokenInterface(_mToken).totalBorrows();
      uint256 borrowAvail;
      if (totalBorrows < borrowCap) {
        borrowAvail = borrowCap.sub(totalBorrows).sub(1);
        if (currentSupplied < supplyCap) {
          borrowAvail = Math.min(supplyCap.sub(currentSupplied).sub(2), borrowAvail);
        } else {
          borrowAvail = 0;
        }
      } else {
        borrowAvail = 0;
      }
      if (borrowDiff > borrowAvail){
        borrowDiff = borrowAvail;
      }
    }
    address _underlying = underlying();
    uint256 balancerBalance = IERC20(_underlying).balanceOf(bVault);

    if (borrowDiff > balancerBalance) {
      _depositNoFlash(supplied, borrowed, _mToken, _denom, _borrowNum);
    } else {
      address[] memory tokens = new address[](1);
      uint256[] memory amounts = new uint256[](1);
      bytes memory userData = abi.encode(0);
      tokens[0] = underlying();
      amounts[0] = borrowDiff;
      makingFlashDeposit = true;
      IBVault(bVault).flashLoan(address(this), tokens, amounts, userData);
      makingFlashDeposit = false;
    }
  }

  /**
  * @notice Redeems a specified amount using flashloan support.
  * @param amount The amount to redeem from the underlying assets.
  * @param borrowTargetFactorNumerator The borrow target factor for calculations.
  * @dev Uses flashloan if the calculated borrow difference is greater than Balancer's balance.
  */
  function _redeemWithFlashloan(uint256 amount, uint256 borrowTargetFactorNumerator) internal {
    address _mToken = mToken();
    uint256 supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
    uint256 borrowed = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
    uint256 newBorrowTarget;
    {
        uint256 oldBalance = supplied.sub(borrowed);
        uint256 newBalance = oldBalance.sub(amount);
        newBorrowTarget = newBalance.mul(borrowTargetFactorNumerator).div(factorDenominator().sub(borrowTargetFactorNumerator));
    }
    uint256 borrowDiff;
    if (borrowed < newBorrowTarget) {
      borrowDiff = 0;
    } else {
      borrowDiff = borrowed.sub(newBorrowTarget);
    }
    address _underlying = underlying();
    uint256 balancerBalance = IERC20(_underlying).balanceOf(bVault);

    if (borrowDiff > balancerBalance) {
      _redeemNoFlash(amount, supplied, borrowed, _mToken, factorDenominator(), borrowTargetFactorNumerator);
    } else {
      address[] memory tokens = new address[](1);
      uint256[] memory amounts = new uint256[](1);
      bytes memory userData = abi.encode(0);
      tokens[0] = _underlying;
      amounts[0] = borrowDiff;
      makingFlashWithdrawal = true;
      IBVault(bVault).flashLoan(address(this), tokens, amounts, userData);
      makingFlashWithdrawal = false;
      _redeem(amount);
    }
  }

  /**
  * @notice Processes the flashloan received, handling both deposit and redemption scenarios.
  * @param amounts The amounts received in the flashloan.
  * @param feeAmounts The fees associated with the flashloan.
  * @dev Executes deposit or redemption flows depending on the operation in progress.
  */
  function receiveFlashLoan(IERC20[] memory /*tokens*/, uint256[] memory amounts, uint256[] memory feeAmounts, bytes memory /*userData*/) external {
    require(msg.sender == bVault);
    require(!makingFlashDeposit || !makingFlashWithdrawal, "Only one can be true");
    require(makingFlashDeposit || makingFlashWithdrawal, "One has to be true");
    address _underlying = underlying();
    uint256 toRepay = amounts[0].add(feeAmounts[0]);
    if (makingFlashDeposit){
      _supply(amounts[0]);
      _borrow(toRepay);
    } else {
      address _mToken = mToken();
      uint256 borrowed = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
      uint256 repaying = Math.min(amounts[0], borrowed);
      IERC20(_underlying).safeApprove(_mToken, 0);
      IERC20(_underlying).safeApprove(_mToken, repaying);
      _repay(repaying);
      _redeem(toRepay);
    }
    IERC20(_underlying).safeTransfer(bVault, toRepay);
  }

  /**
  * @notice Deposits without using flashloan.
  * @param supplied The total amount supplied in underlying tokens.
  * @param borrowed The total amount borrowed in underlying tokens.
  * @param _mToken The address of the mToken contract.
  * @param _denom The denominator for factor calculations.
  * @param _borrowNum The borrow target factor numerator.
  * @dev Adjusts borrow target and executes borrowing and supplying actions in a loop until the target is reached.
  */
  function _depositNoFlash(uint256 supplied, uint256 borrowed, address _mToken, uint256 _denom, uint256 _borrowNum) internal {
    address _underlying = underlying();
    uint256 balance = supplied.sub(borrowed);
    uint256 borrowTarget = balance.mul(_borrowNum).div(_denom.sub(_borrowNum));
    {
      address _rewardPool = rewardPool();
      uint256 supplyCap = ComptrollerInterface(_rewardPool).supplyCaps(_mToken);
      uint256 currentSupplied = MTokenInterface(_mToken).totalSupply().mul(MTokenInterface(_mToken).exchangeRateCurrent()).div(1e18);
      uint256 borrowCap = ComptrollerInterface(_rewardPool).borrowCaps(_mToken);
      uint256 totalBorrows = MTokenInterface(_mToken).totalBorrows();
      uint256 borrowAvail;
      if (totalBorrows < borrowCap) {
        borrowAvail = borrowCap.sub(totalBorrows).sub(1);
        if (currentSupplied < supplyCap) {
          borrowAvail = Math.min(supplyCap.sub(currentSupplied).sub(2), borrowAvail);
        } else {
          borrowAvail = 0;
        }
      } else {
        borrowAvail = 0;
      }
      if (borrowTarget.sub(borrowed) > borrowAvail) {
        borrowTarget = borrowed.add(borrowAvail);
      }
    }
    while (borrowed < borrowTarget) {
      uint256 wantBorrow = borrowTarget.sub(borrowed);
      uint256 maxBorrow = supplied.mul(collateralFactorNumerator()).div(_denom).sub(borrowed);
      _borrow(Math.min(wantBorrow, maxBorrow));
      uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));
      if (underlyingBalance > 0) {
        _supply(underlyingBalance);
      }
      borrowed = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
      supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
      balance = supplied.sub(borrowed);
    }
  }

  /**
  * @notice Redeems without using flashloan.
  * @param amount The amount to redeem from the underlying assets.
  * @param supplied The total amount supplied in underlying tokens.
  * @param borrowed The total amount borrowed in underlying tokens.
  * @param _mToken The address of the mToken contract.
  * @param _denom The denominator for factor calculations.
  * @param _borrowNum The borrow target factor numerator.
  * @dev Adjusts borrow target and executes redemption and repayment actions in a loop until the target is reached.
  */
  function _redeemNoFlash(uint256 amount, uint256 supplied, uint256 borrowed, address _mToken, uint256 _denom, uint256 _borrowNum) internal {
    address _underlying = underlying();
    uint256 newBorrowTarget;
    {
        uint256 oldBalance = supplied.sub(borrowed);
        uint256 newBalance = oldBalance.sub(amount);
        newBorrowTarget = newBalance.mul(_borrowNum).div(_denom.sub(_borrowNum));
    }
    while (borrowed > newBorrowTarget) {
      uint256 requiredCollateral = borrowed.mul(_denom).div(collateralFactorNumerator());
      uint256 toRepay = borrowed.sub(newBorrowTarget);
      uint256 toRedeem = Math.min(supplied.sub(requiredCollateral), amount.add(toRepay));
      _redeem(toRedeem);
      uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));
      _repay(Math.min(toRepay, underlyingBalance));
      borrowed = MTokenInterface(_mToken).borrowBalanceCurrent(address(this));
      supplied = MTokenInterface(_mToken).balanceOfUnderlying(address(this));
    }
    uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));
    if (underlyingBalance < amount) {
      uint256 toRedeem = amount.sub(underlyingBalance);
      uint256 balance = supplied.sub(borrowed);
      _redeem(Math.min(toRedeem, balance));
    }
  }

  /**
  * @notice Sets the collateral factor numerator.
  * @param _numerator The new collateral factor numerator to set.
  * @dev Restricted to governance, ensures the value is within acceptable bounds.
  */
  function _setCollateralFactorNumerator(uint256 _numerator) public onlyGovernance {
    require(_numerator <= factorDenominator(), "Collateral factor cannot be this high");
    require(_numerator > borrowTargetFactorNumerator(), "Collateral factor should be higher than borrow target");
    setUint256(_COLLATERALFACTORNUMERATOR_SLOT, _numerator);
  }

  /**
  * @notice Retrieves the collateral factor numerator.
  * @return The current collateral factor numerator.
  */
  function collateralFactorNumerator() public view returns (uint256) {
    return getUint256(_COLLATERALFACTORNUMERATOR_SLOT);
  }

  /**
  * @notice Sets the factor denominator for collateral calculations.
  * @param _denominator The new factor denominator.
  * @dev Restricted to internal usage.
  */
  function _setFactorDenominator(uint256 _denominator) internal {
    setUint256(_FACTORDENOMINATOR_SLOT, _denominator);
  }

  /**
  * @notice Returns the factor denominator.
  * @return The current factor denominator.
  */
  function factorDenominator() public view returns (uint256) {
    return getUint256(_FACTORDENOMINATOR_SLOT);
  }

  /**
  * @notice Sets the borrow target factor numerator.
  * @param _numerator The new borrow target factor numerator.
  * @dev Restricted to governance and must be below the collateral factor.
  */
  function setBorrowTargetFactorNumerator(uint256 _numerator) public onlyGovernance {
    require(_numerator < collateralFactorNumerator(), "Target should be lower than collateral limit");
    setUint256(_BORROWTARGETFACTORNUMERATOR_SLOT, _numerator);
  }

  /**
  * @notice Returns the borrow target factor numerator.
  * @return The current borrow target factor numerator.
  */
  function borrowTargetFactorNumerator() public view returns (uint256) {
    return getUint256(_BORROWTARGETFACTORNUMERATOR_SLOT);
  }

  /**
  * @notice Enables or disables the folding strategy.
  * @param _fold A boolean to set folding status.
  * @dev Restricted to governance.
  */
  function setFold (bool _fold) public onlyGovernance {
    setBoolean(_FOLD_SLOT, _fold);
  }

  /**
  * @notice Checks if folding is enabled.
  * @return Boolean indicating if folding is enabled.
  */
  function fold() public view returns (bool) {
    return getBoolean(_FOLD_SLOT);
  }

  /**
  * @notice Sets the mToken address.
  * @param _target The mToken address to set.
  * @dev Restricted to internal usage.
  */
  function _setMToken (address _target) internal {
    setAddress(_MTOKEN_SLOT, _target);
  }

  /**
  * @notice Returns the current mToken address.
  * @return The address of the mToken.
  */
  function mToken() public view returns (address) {
    return getAddress(_MTOKEN_SLOT);
  }

  /**
  * @notice Finalizes any upgrade process.
  * @dev Restricted to governance, ensures supply updates at completion.
  */
  function finalizeUpgrade() external onlyGovernance updateSupplyInTheEnd {
    _finalizeUpgrade();
  }

  receive() external payable {}
}