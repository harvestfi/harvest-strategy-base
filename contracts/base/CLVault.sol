// SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts-upgradeable/math/MathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/IERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721HolderUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import "./interface/IStrategy.sol";
import "./interface/IController.sol";
import "./interface/IUpgradeSource.sol";
import "./inheritance/ControllableInit.sol";
import "./CLVaultStorage.sol";
import "./interface/concentrated-liquidity/INonfungiblePositionManager.sol";
import "./interface/concentrated-liquidity/IFactory.sol";
import "./interface/concentrated-liquidity/IPool.sol";
import "./interface/concentrated-liquidity/TickMath.sol";
import "./interface/concentrated-liquidity/LiquidityAmounts.sol";

contract CLVault is ERC20Upgradeable, ERC721HolderUpgradeable, IUpgradeSource, ControllableInit, CLVaultStorage {
  using SafeERC20Upgradeable for IERC20Upgradeable;
  using AddressUpgradeable for address;
  using SafeMathUpgradeable for uint256;

  /**
   * Caller has exchanged assets for shares, and transferred those shares to owner.
   *
   * MUST be emitted when tokens are deposited into the Vault via the mint and deposit methods.
   */
  event Deposit(
      address indexed sender,
      address indexed receiver,
      uint256 amount0,
      uint256 amount1,
      uint256 shares
  );

  /**
   * Caller has exchanged shares, owned by owner, for assets, and transferred those assets to receiver.
   *
   * MUST be emitted when shares are withdrawn from the Vault in ERC4626.redeem or ERC4626.withdraw methods.
   */
  event Withdraw(
      address indexed sender,
      address indexed receiver,
      address indexed owner,
      uint256 amount0,
      uint256 amount1,
      uint256 shares
  );
  event StrategyAnnounced(address newStrategy, uint256 time);
  event StrategyChanged(address newStrategy, address oldStrategy);


  constructor() public {
  }

  // the function is name differently to not cause inheritance clash in truffle and allows tests
  function initializeVault(
    address _storage,
    uint256 _posId,
    address _posManager
  ) public initializer {
    ControllableInit.initialize(_storage);

    IERC721Upgradeable(_posManager).transferFrom(msg.sender, address(this), _posId);

    CLVaultStorage.initialize(_posId, _posManager);

    (,,
      address _token0,
      address _token1,
      int24 _tickSpacing,
      int24 _tickLower,
      int24 _tickUpper,
      uint256 _initialLiquidity,
    ,,,) = INonfungiblePositionManager(_posManager).positions(_posId);

    __ERC20_init(
      string(abi.encodePacked("fCL_", ERC20Upgradeable(_token0).symbol(), "_", ERC20Upgradeable(_token1).symbol())),
      string(abi.encodePacked("fCL_", ERC20Upgradeable(_token0).symbol(), "_", ERC20Upgradeable(_token1).symbol()))
    );
    _setupDecimals(18);

    _setToken0(_token0);
    _setToken1(_token1);
    _setTickSpacing(_tickSpacing);
    _setTickLower(_tickLower);
    _setTickUpper(_tickUpper);

    _mint(msg.sender, _initialLiquidity);
  }

  function strategy() public view returns(address) {
    return _strategy();
  }

  function token0() public view returns(address) {
    return _token0();
  }

  function token1() public view returns(address) {
    return _token1();
  }

  function posId() public view returns(uint256) {
    return _posId();
  }

  function posManager() public view returns(address) {
    return _posManager();
  }

  function tickSpacing() public view returns(int24) {
    return _tickSpacing();
  }

  function tickLower() public view returns(int24) {
    return _tickLower();
  }

  function tickUpper() public view returns(int24) {
    return _tickUpper();
  }

  function underlyingUnit() public view returns(uint256) {
    return _underlyingUnit();
  }

  function nextImplementation() public view returns(address) {
    return _nextImplementation();
  }

  function nextImplementationTimestamp() public view returns(uint256) {
    return _nextImplementationTimestamp();
  }

  function nextImplementationDelay() public view returns (uint256) {
    return IController(controller()).nextImplementationDelay();
  }

  modifier whenStrategyDefined() {
    require(address(strategy()) != address(0), "Strategy must be defined");
    _;
  }

  // Only smart contracts will be affected by this modifier
  modifier defense() {
    require(
      (msg.sender == tx.origin) ||                // If it is a normal user and not smart contract,
                                                  // then the requirement will pass
      !IController(controller()).greyList(msg.sender), // If it is a smart contract, then
      "This smart contract has been grey listed"  // make sure that it is not on our greyList.
    );
    _;
  }

  /**
  * Chooses the best strategy and re-invests. If the strategy did not change, it just calls
  * doHardWork on the current strategy. Call this through controller to claim hard rewards.
  */
  function doHardWork() whenStrategyDefined onlyControllerOrGovernance external {
    // ensure that new funds are invested too
    invest();
    IStrategy(strategy()).doHardWork();
  }

  /* Returns the current underlying (e.g., DAI's) balance together with
   * the invested amount (if DAI is invested elsewhere by the strategy).
  */
  function underlyingBalanceWithInvestment() view public returns (uint256) {
    // note that the liquidity is not a token, so there is no local balance added
    (,,,,,,, uint128 liquidity,,,,) = INonfungiblePositionManager(posManager()).positions(posId());
    return liquidity;
  }

  function getPricePerFullShare() public view returns (uint256) {
    return totalSupply() == 0
      ? underlyingUnit()
      : underlyingUnit().mul(underlyingBalanceWithInvestment()).div(totalSupply());
  }

  /* get the user's share (in underlying)
  */
  function underlyingBalanceWithInvestmentForHolder(address holder) view external returns (uint256) {
    if (totalSupply() == 0) {
      return 0;
    }
    return underlyingBalanceWithInvestment()
      .mul(balanceOf(holder))
      .div(totalSupply());
  }

  function nextStrategy() public view returns (address) {
    return _nextStrategy();
  }

  function nextStrategyTimestamp() public view returns (uint256) {
    return _nextStrategyTimestamp();
  }

  function canUpdateStrategy(address _strategy) public view returns (bool) {
    bool isStrategyNotSetYet = strategy() == address(0);
    bool hasTimelockPassed = block.timestamp > nextStrategyTimestamp() && nextStrategyTimestamp() != 0;
    return isStrategyNotSetYet || (_strategy == nextStrategy() && hasTimelockPassed);
  }

  /**
  * Indicates that the strategy update will happen in the future
  */
  function announceStrategyUpdate(address _strategy) public onlyControllerOrGovernance {
    // records a new timestamp
    uint256 when = block.timestamp.add(nextImplementationDelay());
    _setNextStrategyTimestamp(when);
    _setNextStrategy(_strategy);
    emit StrategyAnnounced(_strategy, when);
  }

  /**
  * Finalizes (or cancels) the strategy update by resetting the data
  */
  function finalizeStrategyUpdate() public onlyControllerOrGovernance {
    _setNextStrategyTimestamp(0);
    _setNextStrategy(address(0));
  }

  function setStrategy(address _strategy) public onlyControllerOrGovernance {
    require(canUpdateStrategy(_strategy),
      "The strategy exists and switch timelock did not elapse yet");
    require(_strategy != address(0), "new _strategy cannot be empty");
    require(IStrategy(_strategy).vault() == address(this), "the strategy does not belong to this vault");

    emit StrategyChanged(_strategy, strategy());
    if (address(_strategy) != address(strategy())) {
      if (address(strategy()) != address(0)) { // if the original strategy (no underscore) is defined
        IStrategy(strategy()).withdrawAllToVault();
      }
      _setStrategy(_strategy);
    }
    finalizeStrategyUpdate();
  }

  function invest() internal whenStrategyDefined {
    address _posManager = posManager();
    uint256 _posId = posId();
    bool nftInVault = INonfungiblePositionManager(_posManager).ownerOf(_posId) == address(this);
    if (nftInVault) {
      IERC721Upgradeable(_posManager).transferFrom(address(this), strategy(), _posId);
    }
  }

  /*
  * Allows for depositing the underlying asset in exchange for shares.
  * Approval is assumed.
  */
  function deposit(uint256 amount0, uint256 amount1, uint256 amountOutMin) external nonReentrant defense returns (uint256 minted) {
    minted = _deposit(amount0, amount1, amountOutMin, msg.sender, msg.sender);
  }

  /*
  * Allows for depositing the underlying asset in exchange for shares
  * assigned to the holder.
  * This facilitates depositing for someone else (using DepositHelper)
  */
  function depositFor(uint256 amount0, uint256 amount1, uint256 amountOutMin, address holder) public nonReentrant defense returns (uint256 minted) {
    minted = _deposit(amount0, amount1, amountOutMin, msg.sender, holder);
  }

  function withdraw(uint256 shares, uint256 amount0OutMin, uint256 amount1OutMin) external nonReentrant defense returns (uint256 amount0, uint256 amount1) {
    (amount0, amount1) = _withdraw(shares, amount0OutMin, amount1OutMin, msg.sender, msg.sender);
  }

  function withdrawAll() public onlyControllerOrGovernance whenStrategyDefined {
    IStrategy(strategy()).withdrawAllToVault();
  }

  function _deposit(uint256 amount0, uint256 amount1, uint256 amountOutMin, address sender, address beneficiary) internal returns (uint256) {
    require(beneficiary != address(0), "holder must be defined");
    
    if (strategy() != address(0)) {
      withdrawAll();
    }

    address _token0 = token0();
    address _token1 = token1();
    IERC20Upgradeable(_token0).safeTransferFrom(sender, address(this), amount0);
    IERC20Upgradeable(_token1).safeTransferFrom(sender, address(this), amount1);
    
    uint256 liquidityBefore = underlyingBalanceWithInvestment();
    
    address _posManager = posManager();
    IERC20Upgradeable(_token0).safeApprove(_posManager, 0);
    IERC20Upgradeable(_token0).safeApprove(_posManager, amount0);
    IERC20Upgradeable(_token1).safeApprove(_posManager, 0);
    IERC20Upgradeable(_token1).safeApprove(_posManager, amount1);

    (uint128 _liquidity,,) = INonfungiblePositionManager(_posManager).increaseLiquidity(
      INonfungiblePositionManager.IncreaseLiquidityParams({
        tokenId: posId(),
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0,
        amount1Min: 0,
        deadline: block.timestamp
      })
    );

    uint256 toMint = totalSupply() == 0
      ? uint256(_liquidity)
      : uint256(_liquidity).mul(totalSupply()).div(liquidityBefore);
    
    require(toMint >= amountOutMin, "Too little received");
    
    _mint(beneficiary, toMint);
    emit Deposit(sender, beneficiary, amount0, amount1, toMint);

    _transferLeftOverTo(beneficiary);
    if (strategy() != address(0)) {
      invest();
    }
    return toMint;
  }

  function _withdraw(uint256 numberOfShares, uint256 amount0OutMin, uint256 amount1OutMin, address receiver, address owner) internal returns (uint256, uint256) {
    require(totalSupply() > 0, "Vault has no shares");
    require(numberOfShares > 0, "numberOfShares must be greater than 0");

    if (strategy() != address(0)) {
      withdrawAll();
    }

    uint128 liquidityShare = uint128(underlyingBalanceWithInvestment().mul(numberOfShares).div(totalSupply()));

    if (msg.sender != owner) {
      uint256 currentAllowance = allowance(owner, msg.sender);
      if (currentAllowance != uint(-1)) {
        require(currentAllowance >= numberOfShares, "ERC20: transfer amount exceeds allowance");
        _approve(owner, msg.sender, currentAllowance - numberOfShares);
      }
    }

    _burn(owner, numberOfShares);

    (uint256 received0, uint256 received1) = _removeFromPosition(liquidityShare, amount0OutMin, amount1OutMin);

    _transferLeftOverTo(receiver);
    emit Withdraw(msg.sender, receiver, owner, received0, received1, numberOfShares);

    if (strategy() != address(0)) {
      invest();
    }
    return (received0, received1);
  }

  function _removeFromPosition(uint128 liquidityAmount, uint256 amount0Min, uint256 amount1Min) internal returns (uint256, uint256) {
    address _posManager = posManager();
    uint256 _posId = posId();
    // withdraw liquidity from the NFT
    (uint256 _receivedToken0, uint256 _receivedToken1) = INonfungiblePositionManager(_posManager).decreaseLiquidity(
      INonfungiblePositionManager.DecreaseLiquidityParams({
        tokenId: _posId,
        liquidity: liquidityAmount,
        amount0Min: amount0Min,
        amount1Min: amount1Min,
        deadline: block.timestamp
      })
    );
    // collect the amount fetched above
    INonfungiblePositionManager(_posManager).collect(
      INonfungiblePositionManager.CollectParams({
        tokenId: _posId,
        recipient: address(this),
        amount0Max: uint128(_receivedToken0), // collect all token0 accounted for the liquidity
        amount1Max: uint128(_receivedToken1) // collect all token1 accounted for the liquidity
      })
    );
    return(_receivedToken0, _receivedToken1);
  }

  /**
     * @dev Handles transferring the leftovers
     */
  function _transferLeftOverTo(address _to) internal {
    address _token0 = token0();
    address _token1 = token1();
    uint256 balance0 = IERC20Upgradeable(_token0).balanceOf(address(this));
    uint256 balance1 = IERC20Upgradeable(_token1).balanceOf(address(this));
    if (balance0 > 0) {
      IERC20Upgradeable(_token0).safeTransfer(_to, balance0);
    }
    if (balance1 > 0) {
      IERC20Upgradeable(_token1).safeTransfer(_to, balance1);
    }
  }

  function sweepDust() external onlyControllerOrGovernance {
    _transferLeftOverTo(governance());
  }

  /**
  * @dev Convenience getter for the current sqrtPriceX96 of the Uniswap pool.
  */
  function getSqrtPriceX96() public view returns (uint160) {
    address factory = INonfungiblePositionManager(posManager()).factory();
    address poolAddr = IFactory(factory).getPool(token0(), token1(), tickSpacing());
    (uint160 sqrtPriceX96,,,,,) = IPool(poolAddr).slot0();
    return sqrtPriceX96;
  }

  function getCurrentTokenAmounts() public view returns (uint256 amount0, uint256 amount1) {
    (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
      getSqrtPriceX96(),
      TickMath.getSqrtRatioAtTick(tickLower()),
      TickMath.getSqrtRatioAtTick(tickUpper()),
      uint128(underlyingBalanceWithInvestment())
    );
  }

  function expectedAmount1ForAmount0(uint256 amount0) public view returns (uint256 expectedAmount1) {
    (uint256 current0, uint256 current1) = getCurrentTokenAmounts();
    expectedAmount1 = amount0.mul(current1).div(current0);
  }

  function getCurrentTokenWeights() public view returns (uint256 weight0, uint256 weight1) {
    uint256 sqrtPrice = uint256(getSqrtPriceX96());
    uint256 price0In1 = sqrtPrice.mul(sqrtPrice).mul(1e18).div(uint(2**(96 * 2)));
    (uint256 amount0, uint256 amount1) = getCurrentTokenAmounts();

    uint256 totalBalanceIn1 = amount0.mul(price0In1).div(1e18).add(amount1);
    weight0 = amount0.mul(1e18).mul(price0In1).div(1e18).div(totalBalanceIn1);
    weight1 = amount1.mul(1e18).div(totalBalanceIn1);
  }

  /**
  * Schedules an upgrade for this vault's proxy.
  */
  function scheduleUpgrade(address impl) public onlyGovernance {
    _setNextImplementation(impl);
    _setNextImplementationTimestamp(block.timestamp.add(nextImplementationDelay()));
  }

  function shouldUpgrade() external view override returns (bool, address) {
    return (
      nextImplementationTimestamp() != 0
        && block.timestamp > nextImplementationTimestamp()
        && nextImplementation() != address(0),
      nextImplementation()
    );
  }

  function finalizeUpgrade() external override onlyGovernance {
    _setNextImplementation(address(0));
    _setNextImplementationTimestamp(0);
  }
}