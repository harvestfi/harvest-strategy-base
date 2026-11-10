// Utilities
const Utils = require("../utilities/Utils.js");
const {
  impersonates,
  setupCoreProtocol,
  depositVault,
} = require("../utilities/hh-utils.js");

const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");
const IERC20 = artifacts.require("IERC20");
const IAeroV2Dex = artifacts.require("IAeroV2Dex");
const IAeroV2Gauge = artifacts.require("IAeroV2Gauge");
const IAeroV2GaugeFactory = artifacts.require("IAeroV2GaugeFactory");
const IAeroV2LeafVoter = artifacts.require("IAeroV2LeafVoter");
const IAeroV2Pool = artifacts.require("IAeroV2Pool");
const IAeroV2PoolFactory = artifacts.require("IAeroV2PoolFactory");
const IUniversalLiquidatorRegistry = artifacts.require("IUniversalLiquidatorRegistry");
const IWETH = artifacts.require("IWETH");
const StrategyProxy = artifacts.require("StrategyProxy");
const VolatileStrategy = artifacts.require("AerodromeV2VolatileStrategy");

//const Strategy = artifacts.require("");
const Strategy = artifacts.require("AerodromeV2VolatileStrategyMainnet_AERO_USDC");

// GaugeFactory.sol functions that the strategy never calls (governance, gauge creation, constants), so
// IAeroV2GaugeFactory leaves them out
const gaugeFactoryGovernanceAbi = [
  { type: "function", name: "penaltyConfig", stateMutability: "view", inputs: [], outputs: [{ type: "tuple", name: "",
    components: [{ type: "uint256", name: "minStakeBlocks" }, { type: "uint256", name: "penaltyRate" }] }] },
  { type: "function", name: "setPenaltyConfig", stateMutability: "nonpayable", outputs: [],
    inputs: [{ type: "uint256", name: "_minStakeBlocksValue" }, { type: "uint256", name: "_penaltyRate" }] },
  { type: "function", name: "setEmissionCap", stateMutability: "nonpayable", outputs: [],
    inputs: [{ type: "address", name: "_gauge" }, { type: "uint128", name: "_cap" }] },
  { type: "function", name: "MAX_MIN_STAKE_BLOCKS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256", name: "" }] },
  { type: "function", name: "GAUGE_MANAGER", stateMutability: "view", inputs: [], outputs: [{ type: "address", name: "" }] },
  { type: "function", name: "computeGaugeAddress", stateMutability: "view", inputs: [{ type: "address", name: "_pool" }],
    outputs: [{ type: "address", name: "_gauge" }] },
  { type: "function", name: "createGauge", stateMutability: "nonpayable",
    inputs: [{ type: "address", name: "_target" }, { type: "bytes", name: "_factoryData" }],
    outputs: [{ type: "address", name: "_gauge" }, { type: "address", name: "_rewards" }] },
];

// Pool.sol fee accounting that IAeroV2Pool leaves out (the strategy only calls claimFees)
const poolFeeAccountingAbi = [
  { type: "function", name: "poolFees", stateMutability: "view", inputs: [], outputs: [{ type: "address", name: "" }] },
  { type: "function", name: "pendingFees", stateMutability: "view", inputs: [{ type: "address", name: "_account" }],
    outputs: [{ type: "uint256", name: "amount0" }, { type: "uint256", name: "amount1" }] },
  { type: "function", name: "claimFees", stateMutability: "nonpayable", inputs: [{ type: "address", name: "_recipient" }],
    outputs: [{ type: "uint256", name: "amount0" }, { type: "uint256", name: "amount1" }] },
  { type: "event", name: "Claim", anonymous: false, inputs: [{ indexed: true, type: "address", name: "caller" },
    { indexed: true, type: "address", name: "account" }, { indexed: true, type: "address", name: "recipient" },
    { indexed: false, type: "uint256", name: "amount0" }, { indexed: false, type: "uint256", name: "amount1" }] },
];

// Pool.sol swap bookkeeping that IAeroV2Pool leaves out: the strategy's own zap swaps and mints, and burn (the tests burn
// LP for pool tokens)
const poolSwapAbi = [
  { type: "function", name: "burn", stateMutability: "nonpayable", inputs: [{ type: "address", name: "to" }],
    outputs: [{ type: "uint256", name: "amount0" }, { type: "uint256", name: "amount1" }] },
  { type: "event", name: "Swap", anonymous: false, inputs: [{ indexed: true, type: "address", name: "sender" },
    { indexed: true, type: "address", name: "to" }, { indexed: false, type: "uint256", name: "amount0In" },
    { indexed: false, type: "uint256", name: "amount1In" }, { indexed: false, type: "uint256", name: "amount0Out" },
    { indexed: false, type: "uint256", name: "amount1Out" }] },
  { type: "event", name: "Mint", anonymous: false, inputs: [{ indexed: true, type: "address", name: "sender" },
    { indexed: true, type: "address", name: "to" }, { indexed: false, type: "uint256", name: "amount0" },
    { indexed: false, type: "uint256", name: "amount1" }] },
  { type: "event", name: "Fees", anonymous: false, inputs: [{ indexed: true, type: "address", name: "sender" },
    { indexed: false, type: "uint256", name: "amount0" }, { indexed: false, type: "uint256", name: "amount1" }] },
];

// PoolFactory.sol pool tape settings that IAeroV2PoolFactory leaves out: every pool swap records to the pool tape after
// Aero's gas check (recordPoolTape reverts InsufficientGasForCall while gasleft() <= poolTapeGasLimit)
const poolFactoryTapeAbi = [
  { type: "function", name: "poolTape", stateMutability: "view", inputs: [], outputs: [{ type: "address", name: "" }] },
  { type: "function", name: "poolTapeGasLimit", stateMutability: "view", inputs: [], outputs: [{ type: "uint32", name: "" }] },
  { type: "function", name: "poolTapeManager", stateMutability: "view", inputs: [], outputs: [{ type: "address", name: "" }] },
  { type: "function", name: "setPoolTape", stateMutability: "nonpayable", outputs: [],
    inputs: [{ type: "address", name: "_poolTape" }, { type: "uint32", name: "_gasLimit" }] },
];

// V2Gauge.depositFor, which IAeroV2Gauge leaves out: while Aero enforces no window anyone can stake for the strategy
const gaugeDepositForAbi = [
  { type: "function", name: "depositFor", stateMutability: "nonpayable", outputs: [],
    inputs: [{ type: "uint256", name: "_amount" }, { type: "address", name: "_owner" }] },
];

// LeafVoter.sol event that IAeroV2LeafVoter leaves out: AERO a gauge hands back (penalties, emissions nobody can earn)
const leafVoterEventsAbi = [
  { type: "event", name: "EmissionsForfeited", anonymous: false, inputs: [{ indexed: true, type: "address", name: "_gauge" },
    { indexed: false, type: "uint128", name: "_amount" }] },
];

// BaseUpgradeableStrategy and its storage contract both declare events with these names: query the ones the strategy
// emits by their signature
const profitLogInReward = web3.utils.keccak256("ProfitLogInReward(address,uint256,uint256,uint256)");
const profitsNotCollected = web3.utils.keccak256("ProfitsNotCollected(bool,bool)");

// code for a broken Aero contract: every call reverts with 0xdeadbeef
// (PUSH4 0xdeadbeef, PUSH1 0xe0, SHL, PUSH1 0, MSTORE, PUSH1 4, PUSH1 0, REVERT)
const revertingCode = "0x63deadbeef60e01b60005260046000fd";
// the same with Aero's own gas check error, InsufficientGasForCall() (0xe28a638c), as the revert data
const insufficientGasCode = "0x63e28a638c60e01b60005260046000fd";
// every call reverts without revert data (PUSH1 0, PUSH1 0, REVERT), and does not burn its gas
const emptyRevertCode = "0x60006000fd";
// every call hits INVALID: it burns all the gas it was given, and returns no revert data
const invalidCode = "0xfe";
const insufficientGasError = web3.eth.abi.encodeFunctionSignature("InsufficientGasForCall()"); // 0xe28a638c

// code for a LeafVoter that lets the first settleGauge of a transaction through and fails every later one with
// 0xdeadbeef. Every gauge claim, deposit and withdraw settles the gauge with the LeafVoter first (V2Gauge._advanceRewards),
// so in a hard work the claim goes through and the gauge deposit or withdraw after it fails. Any other call, and the first
// settleGauge, runs the LeafVoter's own code, copied to `copy`, through DELEGATECALL; a transient-storage flag remembers
// the first settleGauge until the end of the transaction
function laterSettleRevertsCode(copy) {
  let settleGauge = web3.eth.abi.encodeFunctionSignature("settleGauge(address)").slice(2);
  let flag = web3.utils.keccak256("harvest.test.settleGaugeCalls").slice(2);
  return "0x"
    + "600035" + "60e01c" + "63" + settleGauge + "14" + "610048" + "57" // selector == settleGauge: jump to 0x48
    + "5b" + "36" + "6000" + "6000" + "37" // 0x10: calldatacopy(0, 0, calldatasize)
    + "6000" + "6000" + "36" + "6000" + "73" + copy.slice(2).toLowerCase() + "5a" + "f4" // delegatecall(gas, copy, ...)
    + "3d60006000" + "3e" + "610043" + "57" + "3d6000fd" // returndatacopy; revert with it on failure ...
    + "5b" + "3d6000f3" // 0x43: ... else return it
    + "5b" + "7f" + flag + "5c" + "610097" + "57" // 0x48: settleGauge: a later one (flag set) jumps to 0x97
    + "6001" + "7f" + flag + "5d" + "610010" + "56" // the first one sets the flag and delegates (0x10)
    + "5b" + "63deadbeef60e01b60005260046000fd"; // 0x97: revert with 0xdeadbeef
}

// Developed and tested at blockNumber 53206000

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("Base Mainnet AerodromeV2 Volatile AERO-USDC", function() {
  let accounts;

  // external contracts
  let underlying;
  let pool;
  let aeroToken;
  let usdcToken;
  let alusdbToken;
  let wethToken;
  let gauge;
  let gaugeFactory;
  let gaugeFactoryGovernance;
  let gaugeDepositFor;
  let leafVoter;
  let leafVoterEvents;
  let poolFeeAccounting;
  let poolSwaps;
  let poolFactory;
  let poolFactoryTape;
  let universalLiquidatorRegistry;

  // external setup
  let underlyingWhale = "0xDDcD62f4804Fc8D549feB68C250b2ed7E37b873E"; // its LP is staked in the gauge
  let gaugeAddress = "0xd424BA8ca9d4E278753DE76651a0095451e65cD1";
  let leafVoterAddress = "0x382409fad8503FbCdbB27A4211551fa03e884078";
  let aero = "0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee";
  let usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  let alusdb = "0x877014E21c32feA108B6A1f45f367efc9a2d9B9F";
  let weth = "0x4200000000000000000000000000000000000006";
  let volatilePoolFactory = "0x8E6a9FCd1d638CC760Ffba397605Fe3355dE76D2";
  let stablePoolFactory = "0x78589E876edcEbdce72ee3436ab3c9AD3a7cEF2D";
  let stablePoolAddress = "0xA5e16dC9A5cae37563116D9407D8C73927675674"; // sAMMV2-USDC/alUSDb: pool-type check, extra reward token
  let stableGaugeAddress = "0xBd18BdD2C99cE1C8FaB955451b035CAa03184d75";
  let otherGaugeAddress = "0x1D12EF783D557393a2780CB39a9d288aDe8c13B6"; // gauge of another volatile pool: vAMMV2-WETH/USDC
  let otherGaugeFactoryAddress = "0x1e0f776E88649285f99e65Fa599aD6e0f9D97800"; // the stable gauges' factory
  let gaugeManagerAddress = "0xbF234b32c5e58868243A4a14831626f3EdE7b183"; // Aero GaugeManager: the only caller of createGauge
  let aeroV2Dex = "0x6141Cacd5C7752ab0813347Ef87179e46c1c35Fc"; // UniversalLiquidator dex for Aero basic pools (registry key "aero")
  let zeroAddress = "0x0000000000000000000000000000000000000000";
  let leafVoterCopy = "0x00000000000000000000000000000000c0de1eaf"; // no code at the fork: holds a copy of the LeafVoter's code
  let secondGaugeAddress; // the pool's second gauge, deployed by the test that moves the stake to it
  let penaltyAdmin = "0x42255e3C2d0b71a0b006243148fdF1a71d054cE0"; // Aero Safe: PENALTY_ADMIN_ROLE, CAP_ADMIN_ROLE, GAUGE_TAPE_MANAGER_ROLE, LeafVoter CHAIN_STATUS_ROLE
  let emergencyWithdrawAdmin = "0x15ad691083b3d31ee0ad8664e606febd62cd8892"; // Aero Safe: EMERGENCY_WITHDRAW_ROLE
  let vaultImplementation = "0xC85B44eC8804421F23C0e34f42D054959061B803"; // what MegaFactory deploys
  // Keepers must stay below Aero's MEV-tax threshold (1 gwei on volatile pools); hardhat's 2.5 gwei default would tax our swaps
  let keeperGasPrice = "100000000";

  // parties in the protocol
  let governance;
  let farmer1;
  let farmer2;
  let outsider; // holds LP, but no vault shares: stakes for the strategy behind its back

  // numbers used in tests
  let farmerBalance;
  let farmer2Balance;
  let lastClaimAmount;

  // Core protocol contracts
  let controller;
  let vault;
  let strategy;

  async function setupExternalContracts() {
    underlying = await IERC20.at("0xF634058dC94e6BF8e828E27621320C423bC8B18E");
    console.log("Fetching Underlying at: ", underlying.address);
    pool = await IAeroV2Pool.at(underlying.address);
    aeroToken = await IERC20.at(aero);
    usdcToken = await IERC20.at(usdc);
    alusdbToken = await IERC20.at(alusdb);
    wethToken = await IERC20.at(weth);
    gauge = await IAeroV2Gauge.at(gaugeAddress);
    gaugeFactory = await IAeroV2GaugeFactory.at(await gauge.gaugeFactory());
    gaugeFactoryGovernance = new web3.eth.Contract(gaugeFactoryGovernanceAbi, gaugeFactory.address);
    gaugeDepositFor = new web3.eth.Contract(gaugeDepositForAbi, gaugeAddress);
    leafVoter = await IAeroV2LeafVoter.at(leafVoterAddress);
    leafVoterEvents = new web3.eth.Contract(leafVoterEventsAbi, leafVoterAddress);
    poolFeeAccounting = new web3.eth.Contract(poolFeeAccountingAbi, underlying.address);
    poolSwaps = new web3.eth.Contract(poolSwapAbi, underlying.address);
    poolFactory = await IAeroV2PoolFactory.at(await pool.factory());
    assert.equal(poolFactory.address.toLowerCase(), volatilePoolFactory.toLowerCase());
    poolFactoryTape = new web3.eth.Contract(poolFactoryTapeAbi, poolFactory.address);
    universalLiquidatorRegistry = await IUniversalLiquidatorRegistry.at(addresses.UniversalLiquidatorRegistry);
  }

  async function setupBalance(){
    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: underlyingWhale, value: 10e18});

    // the whale's LP is staked in the gauge: unstake it first
    await gauge.withdraw(await gauge.balanceOf(underlyingWhale), { from: underlyingWhale });
    let whaleBalance = new BigNumber(await underlying.balanceOf(underlyingWhale));
    farmerBalance = whaleBalance.times(6).div(10).integerValue(BigNumber.ROUND_DOWN);
    farmer2Balance = whaleBalance.minus(farmerBalance);
    await underlying.transfer(farmer1, farmerBalance.toFixed(), { from: underlyingWhale });
    await underlying.transfer(farmer2, farmer2Balance.toFixed(), { from: underlyingWhale });
  }

  async function doHardWork() {
    let tx = await controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice });
    return tx.receipt.blockNumber;
  }

  // events the gauge emitted for the strategy in `block`
  async function gaugeEvents(name, block) {
    return await gauge.getPastEvents(name, { filter: { _account: strategy.address }, fromBlock: block, toBlock: block });
  }

  async function strategyEvents(name, block) {
    return await strategy.getPastEvents(name, { fromBlock: block, toBlock: block });
  }

  async function advanceToBlock(block) {
    let current = await web3.eth.getBlockNumber();
    if (block > current) {
      await Utils.advanceNBlock(block - current);
    }
  }

  // mines `n` blocks at once, 2 s apart as at the fork block: Utils.advanceNBlock mines block by block, far too slowly for
  // the 432,000 blocks of minStakeInterval
  async function mineBlocks(n) {
    await hre.network.provider.send("hardhat_mine", ["0x" + n.toString(16), "0x2"]);
  }

  // like advanceToBlock, for long walks
  async function mineToBlock(block) {
    let current = await web3.eth.getBlockNumber();
    if (block > current) {
      await mineBlocks(block - current);
    }
  }

  // setMinStakeBlocks(gauge, 0) does not remove the window: it falls back to the factory default
  async function assertNoWindow() {
    let config = await gaugeFactory.effectivePenaltyConfig(gaugeAddress);
    assert.equal(config.minStakeBlocks.toString(), "0", "no window expected: a gauge set to 0 uses the factory default, which must be 0");
  }

  // sends a transaction that must revert and returns hardhat's error message
  async function revertMessage(txPromise, failMessage) {
    try {
      await txPromise;
    } catch (e) {
      return e.message;
    }
    assert.fail(failMessage);
  }

  // the part of hardhat's revert message that carries these exact revert data (it cannot decode Aero's errors by name)
  function revertData(data) {
    return "(return data: " + data + ")";
  }

  // a part of farmer2's LP, for deposits
  async function farmer2LP(divisor) {
    return new BigNumber(await underlying.balanceOf(farmer2)).div(divisor).integerValue(BigNumber.ROUND_DOWN).toFixed();
  }

  // the first block where the strategy may stake again: minStakeInterval blocks after its own last stake and, while Aero
  // enforces a window, also stakeSpacing windows after the gauge's depositBlock; 0 with nothing of its own staked
  async function nextStakeBlock() {
    let lastStake = Number((await strategy.lastStakeBlock()).toString());
    if (lastStake == 0) {
      return 0;
    }
    let next = lastStake + Number((await strategy.minStakeInterval()).toString());
    let window = await strategy.penaltyWindow();
    if (window.minStakeBlocks.toString() != "0" && window.penaltyRate.toString() != "0") {
      next = Math.max(next, Number((await gauge.depositBlock(strategy.address)).toString())
        + Math.max(1, Number((await strategy.stakeSpacing()).toString())) * Number(window.minStakeBlocks.toString()));
    }
    return next;
  }

  // past the window and the stakeSpacing of the last stake, farmer2 deposits `newLP` and the hard work claims, then stakes
  async function claimThenStake(newLP) {
    await advanceToBlock(await nextStakeBlock());
    await depositVault(farmer2, underlying, vault, newLP);
    let block = await doHardWork();
    assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim outside the window");
    assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake right after the claim");
    return block;
  }

  // the strategy's reward checkpoint in the gauge, as of its last stake, claim or withdrawal
  async function gaugeCheckpoint() {
    return {
      balance: new BigNumber(await gauge.balanceOf(strategy.address)),
      paid: new BigNumber(await gauge.userRewardPerTokenPaid(strategy.address)),
      rewards: new BigNumber(await gauge.rewards(strategy.address)),
    };
  }

  // AERO the strategy's stake earned from `checkpoint` to its latest one: the stake times the growth of its reward
  // per token (V2Gauge._earned, without the rewards that `checkpoint` had already snapshotted)
  async function accruedSince(checkpoint) {
    let paid = new BigNumber(await gauge.userRewardPerTokenPaid(strategy.address));
    return checkpoint.balance.times(paid.minus(checkpoint.paid)).idiv(1e18);
  }

  // the LP the next hard work stakes, before new deposits: what waits in the vault and in the strategy
  async function unstakedLP() {
    return new BigNumber(await vault.underlyingBalanceInVault()).plus(await underlying.balanceOf(strategy.address));
  }

  // LP waiting in the strategy for its next stake still counts in the strategy's value, and so in the vault's
  async function assertIdleLPCounted() {
    let staked = new BigNumber(await gauge.balanceOf(strategy.address));
    let idle = new BigNumber(await underlying.balanceOf(strategy.address));
    Utils.assertBNGt(idle, 0);
    Utils.assertBNEq(await strategy.investedUnderlyingBalance(), staked.plus(idle));
    Utils.assertBNEq(await vault.underlyingBalanceWithInvestment(), staked.plus(idle).plus(await vault.underlyingBalanceInVault()));
  }

  // the pool's fee payouts to the strategy in `block`
  async function feeClaims(block) {
    return await poolFeeAccounting.getPastEvents("Claim", { filter: { account: strategy.address }, fromBlock: block, toBlock: block });
  }

  // the pool fees the strategy is owed: it earns them on the LP it holds unstaked
  async function pendingFees() {
    let pending = await poolFeeAccounting.methods.pendingFees(strategy.address).call();
    return { amount0: pending.amount0, amount1: pending.amount1 };
  }

  // farmer2 wraps `amount` of ETH and sends the WETH to the strategy (a token it does not farm)
  async function sendWETH(amount) {
    await (await IWETH.at(weth)).deposit({ from: farmer2, value: amount });
    await wethToken.transfer(strategy.address, amount, { from: farmer2 });
  }

  // the pool's `name` events (Swap, Mint, Fees) in `block` sent by `sender`: by the strategy itself for its zap
  async function poolEvents(name, block, sender) {
    return await poolSwaps.getPastEvents(name, { filter: { sender: sender }, fromBlock: block, toBlock: block });
  }

  // LP the pool minted to the strategy in `block`
  async function mintedLP(block) {
    let mints = await underlying.getPastEvents("Transfer", { filter: { from: zeroAddress, to: strategy.address }, fromBlock: block, toBlock: block });
    return mints.reduce((total, mint) => total.plus(mint.args.value.toString()), new BigNumber(0));
  }

  // value in dollars (USDC, 6 decimals) of amounts of the pool tokens: the AERO (18 decimals) at the pool's price
  async function dollars(amount0, amount1) {
    let reserves = await pool.getReserves();
    return new BigNumber(amount0).times(reserves[1].toString()).idiv(reserves[0].toString()).plus(amount1);
  }

  // dollars of the pool tokens the strategy holds, outside the LP
  async function poolTokensHeld() {
    return await dollars(await aeroToken.balanceOf(strategy.address), await usdcToken.balanceOf(strategy.address));
  }

  // dollars behind `lp` LP at the pool's reserves
  async function lpDollars(lp) {
    let reserves = await pool.getReserves();
    return new BigNumber(lp).times(await dollars(reserves[0].toString(), reserves[1].toString())).idiv(await pool.totalSupply());
  }

  // farmer2 burns a part of its LP (1/`divisor`) for the pool tokens behind it; returns what it got [AERO, USDC]
  async function burnLP(divisor) {
    let before = [new BigNumber(await aeroToken.balanceOf(farmer2)), new BigNumber(await usdcToken.balanceOf(farmer2))];
    await underlying.transfer(underlying.address, await farmer2LP(divisor), { from: farmer2 });
    await poolSwaps.methods.burn(farmer2).send({ from: farmer2, gas: 1000000 });
    return [new BigNumber(await aeroToken.balanceOf(farmer2)).minus(before[0]),
      new BigNumber(await usdcToken.balanceOf(farmer2)).minus(before[1])];
  }

  // `from` swaps `amountIn` of `tokenIn` through the pool itself, below the MEV-tax threshold
  async function poolSwap(from, tokenIn, amountIn) {
    let amountOut = (await pool.getAmountOutWithTotalFee(amountIn, tokenIn, { from: from })).toString();
    await (await IERC20.at(tokenIn)).transfer(underlying.address, amountIn, { from: from });
    if (tokenIn.toLowerCase() == (await pool.token0()).toLowerCase()) {
      await pool.swap(0, amountOut, from, "0x", { from: from, gasPrice: keeperGasPrice });
    } else {
      await pool.swap(amountOut, 0, from, "0x", { from: from, gasPrice: keeperGasPrice });
    }
    return amountOut;
  }

  // the outsider stakes `amount` of LP (from farmer1) for the strategy, which V2Gauge.depositFor allows while Aero
  // enforces no window
  async function outsiderDepositFor(amount) {
    await underlying.transfer(outsider, amount, { from: farmer1 });
    await underlying.approve(gaugeAddress, amount, { from: outsider });
    return await gaugeDepositFor.methods.depositFor(amount, strategy.address).send({ from: outsider, gas: 1000000 });
  }

  // the gas a best-effort gauge exit (emergencyExit, leaving a switched-off gauge) must have left when it starts:
  // gaugeTapeGasLimit + 1,000,000 for the gauge withdraw, + 200,000 kept back for the emergencyWithdraw fallback
  async function exitGasFloor() {
    return Number((await gaugeFactory.gaugeTapeGasLimit()).toString()) + 1200000;
  }

  // the least gas limit, to within 1,000, with which the transaction `call` goes through, simulated with eth_call (nothing
  // changes) on the current state. eth_estimateGas cannot be used for this: its search starts above the per-transaction
  // gas cap
  async function leastGas(call, low, high) {
    while (high - low > 1000) {
      let mid = Math.floor((low + high) / 2);
      try {
        await web3.eth.call(Object.assign({}, call, { gas: mid }));
        high = mid;
      } catch (e) {
        low = mid;
      }
    }
    return high;
  }

  // Aero switches the gauge off (cap 0) or back on, here as its cap admin (the LeafVoter's emergency council can switch it
  // off too). Only its cap admin can switch it back on; the cap operator can neither set a 0 cap nor raise one
  // (CapOutOfOperatorRange, NotAuthorized). Setting the cap also settles the gauge and flushes its fees to the voters
  async function setEmissionCap(cap) {
    await gaugeFactoryGovernance.methods.setEmissionCap(gaugeAddress, cap).send({ from: penaltyAdmin });
  }

  // runs `fn` while the LeafVoter runs `code` instead of its own, which comes back afterwards
  async function withLeafVoterCode(code, fn) {
    let leafVoterCode = await web3.eth.getCode(leafVoterAddress);
    await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, code]);
    try {
      return await fn();
    } finally {
      await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, leafVoterCode]);
    }
  }

  // runs `fn` while, in each transaction, the first gauge claim, deposit or withdraw works and every later one fails with
  // 0xdeadbeef (laterSettleRevertsCode)
  async function withGaugeFailingAfterClaim(fn) {
    await hre.network.provider.send("hardhat_setCode", [leafVoterCopy, await web3.eth.getCode(leafVoterAddress)]);
    try {
      return await withLeafVoterCode(laterSettleRevertsCode(leafVoterCopy), fn);
    } finally {
      await hre.network.provider.send("hardhat_setCode", [leafVoterCopy, "0x"]);
    }
  }

  // runs `fn` while every swap through the pools of `factoryAddress` fails Aero's gas check (InsufficientGasForCall), as
  // if the transaction had run short of gas there: the factory's pool tape manager raises poolTapeGasLimit above any
  // transaction's gas
  async function withPoolTapeFailing(factoryAddress, fn) {
    let factory = new web3.eth.Contract(poolFactoryTapeAbi, factoryAddress);
    let poolTape = await factory.methods.poolTape().call();
    let poolTapeGasLimit = await factory.methods.poolTapeGasLimit().call();
    let manager = await factory.methods.poolTapeManager().call();
    assert.notEqual(poolTape, zeroAddress, "the gas check only runs with a pool tape");
    let managerEth = await web3.eth.getBalance(manager);
    await impersonates([manager]);
    await hre.network.provider.send("hardhat_setBalance", [manager, "0x8AC7230489E80000"]); // gas for its calls
    try {
      await factory.methods.setPoolTape(poolTape, "4000000000").send({ from: manager });
      try {
        return await fn();
      } finally {
        await factory.methods.setPoolTape(poolTape, poolTapeGasLimit).send({ from: manager });
      }
    } finally {
      await hre.network.provider.send("hardhat_setBalance", [manager, web3.utils.toHex(managerEth)]);
      if (manager.toLowerCase() != penaltyAdmin.toLowerCase()) {
        await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [manager] });
      }
    }
  }

  // runs `fn` while Aero's pauser has paused swaps in all pools of the pool's factory (Pool.swap reverts IsPaused; mint
  // and burn still work)
  async function withSwapsPaused(fn) {
    let pauser = await poolFactory.pauser();
    assert.equal(pauser.toLowerCase(), penaltyAdmin.toLowerCase(), "the pool factory's pauser is the Aero Safe impersonated above");
    await poolFactory.setPauseState(true, { from: pauser });
    try {
      assert.equal(await poolFactory.isPaused(), true);
      return await fn();
    } finally {
      await poolFactory.setPauseState(false, { from: pauser });
    }
  }

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();

    farmer1 = accounts[1];
    farmer2 = accounts[2];
    outsider = accounts[3];

    // impersonate accounts
    await impersonates([governance, underlyingWhale, addresses.ULOwner, penaltyAdmin, emergencyWithdrawAdmin]);

    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18});
    await web3.eth.sendTransaction({ from: etherGiver, to: addresses.ULOwner, value: 10e18});
    await web3.eth.sendTransaction({ from: etherGiver, to: penaltyAdmin, value: 10e18});
    await web3.eth.sendTransaction({ from: etherGiver, to: emergencyWithdrawAdmin, value: 10e18});

    await setupExternalContracts();
    await assertNoWindow(); // the happy path and "User deposits" stake without a window
    [controller, vault, strategy] = await setupCoreProtocol({
      "existingVaultAddress": null,
      "vaultImplementationOverride": vaultImplementation,
      "strategyArtifact": Strategy,
      "strategyArtifactIsUpgradable": true,
      "underlying": underlying,
      "governance": governance,
      "aeroV2Setup": [
        [aero, usdc, volatilePoolFactory],
      ],
      "liquidation": [
        {"aero": [aero, usdc]},
      ],
      "ULOwner": addresses.ULOwner,
    });

    // truffle-contract polls for 24 confirmations after every transaction (handlers.js offers this switch for tests):
    // over the long block-by-block simulations below hundreds of these pollers pile up and stall the in-process node
    for (let truffleContract of [IERC20, IAeroV2Dex, IAeroV2Gauge, IAeroV2GaugeFactory, IAeroV2LeafVoter, IAeroV2Pool,
      IAeroV2PoolFactory, IUniversalLiquidatorRegistry, IWETH, StrategyProxy, VolatileStrategy, controller.constructor,
      vault.constructor, strategy.constructor]) {
      truffleContract.disableConfirmationListener = true;
    }

    // user deposits must wait in the vault until the keeper's hard work (new vaults start with investOnDeposit = true)
    await vault.setInvestOnDeposit(false, { from: governance });

    // a new strategy has never staked, and stakes at most once per minStakeInterval (about a day of 0.2 s blocks)
    assert.equal((await strategy.minStakeInterval()).toString(), "432000", "the default minStakeInterval");
    assert.equal((await strategy.lastStakeBlock()).toString(), "0", "a new strategy has never staked");
    // most describes test the window logic on its own; the "Minimum stake interval" describe restores the default and
    // tests the interval
    await strategy.setMinStakeInterval(0, { from: governance });

    // whale send underlying to farmers
    await setupBalance();
  });

  describe("Happy path", function() {
    it("Farmer should earn money", async function() {
      let farmerOldBalance = new BigNumber(await underlying.balanceOf(farmer1));
      await depositVault(farmer1, underlying, vault, farmerBalance);

      let hours = 10;
      let blocksPerHour = 3600;
      let oldSharePrice;
      let newSharePrice;

      for (let i = 0; i < hours; i++) {
        console.log("loop ", i);

        // every hard work stakes all it compounded: minStakeInterval is 0 here (root before())
        let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
        oldSharePrice = new BigNumber(await vault.getPricePerFullShare());
        let block = await doHardWork();
        newSharePrice = new BigNumber(await vault.getPricePerFullShare());

        console.log("old shareprice: ", oldSharePrice.toFixed());
        console.log("new shareprice: ", newSharePrice.toFixed());
        console.log("growth: ", newSharePrice.toFixed() / oldSharePrice.toFixed());

        apr = (newSharePrice.toFixed()/oldSharePrice.toFixed()-1)*(24/(blocksPerHour/1800))*365;
        apy = ((newSharePrice.toFixed()/oldSharePrice.toFixed()-1)*(24/(blocksPerHour/1800))+1)**365;

        console.log("instant APR:", apr*100, "%");
        console.log("instant APY:", (apy-1)*100, "%");

        if (i > 0) {
          // the rewards go into the pool in its own ratio: almost nothing is left over. AERO is token0 (18 decimals) and USDC
          // token1 (6): the AERO left over counts at the pool's price, from the reserves, and both halves of the LP are
          // worth the same
          let reserves = await pool.getReserves();
          let reserve0 = new BigNumber(reserves[0].toString());
          let reserve1 = new BigNumber(reserves[1].toString());
          let minted = new BigNumber(await gauge.balanceOf(strategy.address)).minus(stakedBefore);
          let mintedValue = minted.times(reserve1.times(2)).idiv(await pool.totalSupply());
          let leftover = new BigNumber(await aeroToken.balanceOf(strategy.address)).times(reserve1).idiv(reserve0)
            .plus(await usdcToken.balanceOf(strategy.address));
          console.log("compounded ($, USDC 6 decimals): ", mintedValue.toFixed(), " left over: ", leftover.toFixed());
          Utils.assertBNGt(minted, 0);
          Utils.assertBNGt(mintedValue, leftover.times(50)); // leftover below 2%

          // the reward split already lands on the pool's ratio, so the zap's own swap through the pool only evens out what
          // the split misses (the price impact of the sale, which goes through this pool; the split's two probes cancel
          // their own): under a millionth of the compounded value here, ~2.5e-5 with a single probe. The zap would quietly
          // repair a split that under-allocates a side, at a swap fee, which the leftover check above cannot see: keeping
          // 10% less AERO in the split sends ~5% of the value through the zap. A tenth of a percent is far from both
          let zapSwaps = await poolEvents("Swap", block, strategy.address);
          assert.isAtMost(zapSwaps.length, 1);
          let zapped = zapSwaps.length == 0 ? new BigNumber(0)
            : await dollars(zapSwaps[0].returnValues.amount0In, zapSwaps[0].returnValues.amount1In);
          console.log("zapped ($, USDC 6 decimals): ", zapped.toFixed(), " share of the compounded value: ", zapped.toNumber() / mintedValue.toNumber());
          Utils.assertBNGt(mintedValue, zapped.times(1000)); // the zap swapped less than 0.1% of what was compounded
        }

        await Utils.advanceNBlock(blocksPerHour);
      }
      await vault.withdraw(new BigNumber(await vault.balanceOf(farmer1)).toFixed(), { from: farmer1 });
      let farmerNewBalance = new BigNumber(await underlying.balanceOf(farmer1));
      Utils.assertBNGt(farmerNewBalance, farmerOldBalance);

      apr = (farmerNewBalance.toFixed()/farmerOldBalance.toFixed()-1)*(24/(blocksPerHour*hours/1800))*365;
      apy = ((farmerNewBalance.toFixed()/farmerOldBalance.toFixed()-1)*(24/(blocksPerHour*hours/1800))+1)**365;

      console.log("earned!");
      console.log("APR:", apr*100, "%");
      console.log("APY:", (apy-1)*100, "%");

      await strategy.withdrawAllToVault({from:governance}); // making sure can withdraw all for a next switch

    });
  });

  describe("User deposits and withdrawals", function() {
    it("Never reach the gauge: the vault's doHardWork is ignored while investOnDeposit is on", async function() {
      // the vault default: user deposits run the strategy's doHardWork
      await vault.setInvestOnDeposit(true, { from: governance });
      try {
        let amount = new BigNumber(await underlying.balanceOf(farmer1)).div(2).integerValue(BigNumber.ROUND_DOWN);
        await underlying.approve(vault.address, amount.toFixed(), { from: farmer1 });
        let tx = await vault.deposit(amount.toFixed(), farmer1, { from: farmer1 });
        assert.equal((await strategyEvents("HardWorkSkipped", tx.receipt.blockNumber)).length, 1, "user deposit should not run the hard work");
        assert.equal((await gaugeEvents("Deposit", tx.receipt.blockNumber)).length, 0, "user deposit should not reach the gauge");

        // the keeper also comes through the vault, so it is silenced too: the flag must be turned off at deployment
        let block = await doHardWork();
        assert.equal((await strategyEvents("HardWorkSkipped", block)).length, 1, "keeper hard work should be skipped");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      } finally {
        await vault.setInvestOnDeposit(false, { from: governance });
      }

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "keeper hard work should stake");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Never reach the gauge: the vault's doHardWork is ignored while compoundOnWithdraw is on", async function() {
      // with compoundOnWithdraw on, every user withdrawal runs the strategy's doHardWork
      await vault.setCompoundOnWithdraw(true, { from: governance });
      try {
        assert.equal(await vault.compoundOnWithdraw(), true);
        assert.equal(await vault.investOnDeposit(), false, "only compoundOnWithdraw should call for the skip");

        // a deposit waits in the vault, and a smaller withdrawal is paid from it: only the hard work could reach the gauge
        let amount = new BigNumber(await underlying.balanceOf(farmer1)).div(10).integerValue(BigNumber.ROUND_DOWN);
        await depositVault(farmer1, underlying, vault, amount.toFixed());
        let shares = amount.div(2).times(await vault.totalSupply()).idiv(await vault.underlyingBalanceWithInvestment());
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
        assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 0, "the withdrawal should be paid from the vault");
        assert.equal((await strategyEvents("HardWorkSkipped", tx.receipt.blockNumber)).length, 1, "user withdrawal should not run the hard work");
        assert.equal((await gaugeEvents("EmissionsClaimed", tx.receipt.blockNumber)).length, 0, "user withdrawal should not claim");
        assert.equal((await gaugeEvents("Deposit", tx.receipt.blockNumber)).length, 0, "user withdrawal should not reach the gauge");
      } finally {
        await vault.setCompoundOnWithdraw(false, { from: governance });
      }
    });
  });

  describe("Minimum stake interval (no window)", function() {
    let interval;

    before(async function() {
      await assertNoWindow();
      // the default that initializeBaseStrategy sets (checked in the root before(), which then set 0)
      await strategy.setMinStakeInterval(432000, { from: governance });
      interval = Number((await strategy.minStakeInterval()).toString());
    });

    after(async function() {
      await strategy.setMinStakeInterval(0, { from: governance });
    });

    // farmer1 withdraws all the LP waiting in the vault and the strategy, and `fromGauge` more, which the strategy takes out
    // of the gauge; returns the block
    async function withdrawFromGauge(fromGauge) {
      let lp = (await unstakedLP()).plus(fromGauge);
      let value = new BigNumber(await vault.underlyingBalanceWithInvestment());
      let shares = lp.times(await vault.totalSupply()).plus(value).minus(1).idiv(value); // rounded up
      let tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
      let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
      assert.equal(withdrawn.length, 1, "the withdrawal should reach the gauge");
      Utils.assertBNGte(withdrawn[0].args._amount.toString(), fromGauge);
      Utils.assertBNGt(new BigNumber(fromGauge).plus(10), withdrawn[0].args._amount.toString()); // the vault's rounding
      return tx.receipt.blockNumber;
    }

    // what the gauge's LeafVoter took back from the gauge in `block`: forfeited penalties, emissions nobody could earn
    async function forfeited(block) {
      return await leafVoterEvents.getPastEvents("EmissionsForfeited", { filter: { _gauge: gaugeAddress }, fromBlock: block, toBlock: block });
    }

    // farmer1 deposits a tenth of its LP, which waits in the vault for the next hard work (the window describes below
    // deposit all of farmer2's LP, which is left untouched here)
    async function depositNewLP() {
      let lp = new BigNumber(await underlying.balanceOf(farmer1)).div(10).integerValue(BigNumber.ROUND_DOWN).toFixed();
      await depositVault(farmer1, underlying, vault, lp);
    }

    it("With nothing staked, stakes at once, and records the block of that stake as lastStakeBlock", async function() {
      // a full exit leaves nothing staked, and no last stake to count the interval from
      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      assert.equal((await strategy.lastStakeBlock()).toString(), "0", "a full exit should reset lastStakeBlock");
      let lpBefore = await unstakedLP();

      let block = await doHardWork();
      let deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "should stake at once");
      Utils.assertBNGte(deposits[0].args._amount.toString(), lpBefore);
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      assert.equal((await strategy.lastStakeBlock()).toString(), String(block), "should record the block of the stake");
      assert.equal(await nextStakeBlock(), block + interval);
    });

    it("Claims and compounds before lastStakeBlock + minStakeInterval, but keeps new LP idle until that block", async function() {
      let lastStake = Number((await strategy.lastStakeBlock()).toString());
      assert.equal(await nextStakeBlock(), lastStake + interval);

      // an hour later, with new LP: the hard work claims, sells and compounds the AERO, and keeps all the LP unstaked
      await depositNewLP();
      await mineBlocks(1800);
      let sharePrice = new BigNumber(await vault.getPricePerFullShare());
      let block = await doHardWork();
      assert.isBelow(block, lastStake + interval);
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "should sell the AERO");
      Utils.assertBNGt(await mintedLP(block), 0); // and compound it
      assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake within minStakeInterval of the last stake");
      let skipped = await strategyEvents("StakeSkipped", block);
      assert.equal(skipped.length, 1);
      Utils.assertBNEq(skipped[0].args.idleAmount.toString(), await underlying.balanceOf(strategy.address));
      // the waiting LP, new and compounded, keeps its full value for the vault's users
      await assertIdleLPCounted();
      Utils.assertBNGt(await vault.getPricePerFullShare(), sharePrice);

      // one block before the interval ends it still claims, compounds and waits ...
      await mineToBlock(lastStake + interval - 2);
      block = await doHardWork();
      assert.equal(block, lastStake + interval - 1);
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
      Utils.assertBNGt(await mintedLP(block), 0);
      assert.equal((await gaugeEvents("Deposit", block)).length, 0, "one block early: should not stake yet");
      assert.equal((await strategyEvents("StakeSkipped", block)).length, 1);
      assert.equal((await strategy.lastStakeBlock()).toString(), String(lastStake));
      await assertIdleLPCounted();

      // ... and the hard work at lastStakeBlock + minStakeInterval stakes all the idle LP
      let idle = new BigNumber(await underlying.balanceOf(strategy.address));
      block = await doHardWork();
      assert.equal(block, lastStake + interval);
      let deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "should stake once the interval is over");
      Utils.assertBNGte(deposits[0].args._amount.toString(), idle);
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      assert.equal((await strategy.lastStakeBlock()).toString(), String(block));
    });

    it("Keeps the stake out of a window that Aero switches on later, where staking on every hard work would leave all of it", async function() {
      // Aero's windows also cover stakes made before they were switched on: a window of 1800 blocks switched on now
      // catches any stake of the last 1800 blocks
      let windowBlocks = 1800;
      assert.equal(await gauge.isPenaltyActive(strategy.address), false);

      // with minStakeInterval 0 every hard work stakes, so the stake is always recent: a hard work with new LP, an hour
      // after the last one, stakes it
      await strategy.setMinStakeInterval(0, { from: governance });
      try {
        await depositNewLP();
        await mineBlocks(1800);
        let block = await doHardWork();
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake on every hard work");

        // shortly after, Aero switches on the window: the whole stake is inside it, and a user withdrawal of 1,000,000 wei
        // of LP from the gauge forfeits all the AERO it earned since the hard work's claim
        await mineBlocks(100);
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, windowBlocks, { from: penaltyAdmin });
        try {
          assert.equal(await gauge.isPenaltyActive(strategy.address), true, "the stake should be inside the new window");
          let before = await gaugeCheckpoint();
          let withdrawal = await withdrawFromGauge(1000000);
          let lost = (await accruedSince(before)).plus(before.rewards);
          let penalties = await gaugeEvents("EarlyWithdrawPenalty", withdrawal);
          assert.equal(penalties.length, 1, "should forfeit inside the window");
          Utils.assertBNEq(penalties[0].args._penalty.toString(), lost);
          let forfeits = await forfeited(withdrawal);
          assert.equal(forfeits.length, 1);
          Utils.assertBNEq(forfeits[0].returnValues._amount, lost);
          assert.equal((await gaugeEvents("EmissionsClaimed", withdrawal)).length, 0, "a 100% penalty should leave nothing to claim");
          console.log("AERO forfeited by a 1,000,000 wei withdrawal 100 blocks after a stake: ", lost.toFixed());
          Utils.assertBNGt(lost, 0);
        } finally {
          await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
        }
      } finally {
        await strategy.setMinStakeInterval(interval, { from: governance });
      }
      await assertNoWindow();

      // with the default interval the same hard work does not stake (the last stake was a little while ago) ...
      await depositNewLP();
      await mineBlocks(1800);
      let block = await doHardWork();
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
      assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake within minStakeInterval of the last stake");

      // ... so the same window, switched on as shortly after, finds the stake outside it: the same withdrawal from the
      // gauge forfeits nothing, and pays the strategy what it earned
      await mineBlocks(100);
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, windowBlocks, { from: penaltyAdmin });
      try {
        assert.equal(await gauge.isPenaltyActive(strategy.address), false, "the stake should be older than the new window");
        let before = await gaugeCheckpoint();
        let withdrawal = await withdrawFromGauge(1000000);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", withdrawal)).length, 0, "nothing should be forfeited");
        assert.equal((await forfeited(withdrawal)).length, 0, "nothing should be forfeited");
        let claimed = await gaugeEvents("EmissionsClaimed", withdrawal);
        assert.equal(claimed.length, 1);
        Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();
    });

    it("Stakes at its own lastStakeBlock + minStakeInterval although an outsider restarts the gauge's depositBlock with depositFor", async function() {
      let lastStake = Number((await strategy.lastStakeBlock()).toString());
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);

      // with no window, an outsider stakes 1 wei of LP for the strategy: the gauge counts it in the strategy's stake and
      // restarts the strategy's depositBlock, which the strategy cannot prevent
      await mineBlocks(1800);
      let grief = await outsiderDepositFor(1);
      assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(grief.blockNumber));
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked.plus(1));
      Utils.assertBNEq(await strategy.investedUnderlyingBalance(), staked.plus(1).plus(await underlying.balanceOf(strategy.address)));
      assert.equal((await strategy.lastStakeBlock()).toString(), String(lastStake), "lastStakeBlock counts the strategy's own stakes only");
      assert.equal(await nextStakeBlock(), lastStake + interval);

      // so the next stake does not move: one block before lastStakeBlock + minStakeInterval the strategy still waits, and at
      // that block it stakes, long before depositBlock + minStakeInterval
      await depositNewLP();
      await mineToBlock(lastStake + interval - 2);
      let block = await doHardWork();
      assert.equal(block, lastStake + interval - 1);
      assert.equal((await gaugeEvents("Deposit", block)).length, 0, "one block early: should not stake yet");
      block = await doHardWork();
      assert.equal(block, lastStake + interval);
      assert.isBelow(block, grief.blockNumber + interval);
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "an outsider's depositFor should not postpone the stake");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      assert.equal((await strategy.lastStakeBlock()).toString(), String(block));

      // under a window, a depositFor from anyone but a MetaRouter Aero approved reverts (PenaltyActive): only the
      // strategy's own stakes move its depositBlock then, so the window term of the next stake can count from it
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      try {
        let message = await revertMessage(outsiderDepositFor(1), "depositFor should revert under a window");
        assert.include(message, revertData(web3.eth.abi.encodeFunctionSignature("PenaltyActive()")));
        assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(block));
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();
    });

    it("Stakes at once after a full exit, even when an outsider staked 1 wei for it in between", async function() {
      // withdrawAll empties the gauge: no last stake to wait for any more ...
      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      assert.equal((await strategy.lastStakeBlock()).toString(), "0");
      // ... and an outsider's stake for the strategy is not one of its own; then a user deposits, and the hard work stakes
      await outsiderDepositFor(1);
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 1);
      await depositNewLP();
      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake at once");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      assert.equal((await strategy.lastStakeBlock()).toString(), String(block));

      // the same after an emergency exit, and with Aero switching on a window over the outsider's new 1 wei: the strategy
      // waits for that window to claim, but then stakes at once, without stakeSpacing (10 windows after depositBlock) or
      // minStakeInterval to wait for
      await strategy.emergencyExit({ from: governance });
      try {
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        assert.equal((await strategy.lastStakeBlock()).toString(), "0", "an emergency exit should reset lastStakeBlock");
      } finally {
        await strategy.continueInvesting({ from: governance });
      }
      let grief = await outsiderDepositFor(1);
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      try {
        block = await doHardWork();
        assert.isBelow(block, grief.blockNumber + 7, "should run inside the window of the outsider's stake");
        assert.equal((await strategyEvents("ClaimSkipped", block)).length, 1, "the claim should wait for the window");
        assert.equal((await strategyEvents("StakeSkipped", block)).length, 1, "the stake should wait for the claim");
        await advanceToBlock(grief.blockNumber + 6);
        block = await doHardWork();
        assert.equal(block, grief.blockNumber + 7);
        assert.equal((await strategyEvents("ClaimSkipped", block)).length, 0);
        assert.equal((await strategyEvents("ClaimFailed", block)).length, 0);
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake right after the window");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        assert.equal((await strategy.lastStakeBlock()).toString(), String(block));
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();
    });

    it("Under a window, waits for both minStakeInterval after its last stake and stakeSpacing windows after depositBlock", async function() {
      // a 7-block window and stakeSpacing 10: 70 blocks after depositBlock; and an interval of 600, then of 30 blocks
      assert.equal((await strategy.stakeSpacing()).toString(), "10");
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      try {
        for (let [stakeInterval, wait] of [[600, 600], [30, 70]]) {
          await strategy.setMinStakeInterval(stakeInterval, { from: governance });
          // a claim-then-stake at the first block allowed (with farmer1's LP: claimThenStake deposits farmer2's)
          await advanceToBlock(await nextStakeBlock());
          await depositNewLP();
          let block = await doHardWork();
          assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim outside the window");
          assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake right after the claim");
          assert.equal((await strategy.lastStakeBlock()).toString(), String(block));
          assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(block));
          assert.equal(await nextStakeBlock(), block + wait);

          // new LP: after the window the hard work claims, but stakes only at the later of the two
          await depositNewLP();
          await mineToBlock(block + wait - 2);
          let next = await doHardWork();
          assert.equal(next, block + wait - 1);
          assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim after the window");
          assert.equal((await gaugeEvents("Deposit", next)).length, 0, "one block early: should not stake yet");
          assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
          next = await doHardWork();
          assert.equal(next, block + wait);
          assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake");
          Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        }
      } finally {
        await strategy.setMinStakeInterval(interval, { from: governance });
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();
    });

    it("Under a window, counts stakeSpacing from the gauge's depositBlock, which an outsider's depositFor before the window moved", async function() {
      // an interval of 30 blocks, and a stake of the strategy's own
      await strategy.setMinStakeInterval(30, { from: governance });
      try {
        await mineToBlock(Number((await strategy.lastStakeBlock()).toString()) + 30);
        await depositNewLP();
        let block = await doHardWork();
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake");
        let lastStake = block;
        // with no window, an outsider stakes 1 wei for the strategy some 50 blocks later; then Aero switches on a 7-block
        // window (stakeSpacing 10: 70 blocks), which covers that 1 wei and so, by the gauge's books, the whole stake
        await mineBlocks(49);
        let grief = await outsiderDepositFor(1);
        assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(grief.blockNumber));
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
        try {
          assert.equal(await nextStakeBlock(), grief.blockNumber + 70);
          // past that window, 70 blocks after the strategy's own stake (and 30): it claims, but stakes only 70 blocks after
          // the depositBlock the gauge holds, as a stake of its own there would have required
          await depositNewLP();
          await advanceToBlock(lastStake + 79);
          let next = await doHardWork();
          assert.isAtLeast(next, grief.blockNumber + 7, "should run after the outsider's window");
          assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim");
          assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should wait for stakeSpacing from the gauge's depositBlock");
          assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
          await advanceToBlock(grief.blockNumber + 68);
          next = await doHardWork();
          assert.equal(next, grief.blockNumber + 69);
          assert.equal((await gaugeEvents("Deposit", next)).length, 0, "one block early: should not stake yet");
          next = await doHardWork();
          assert.equal(next, grief.blockNumber + 70);
          assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake");
        } finally {
          await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
        }
      } finally {
        await strategy.setMinStakeInterval(interval, { from: governance });
      }
      await assertNoWindow();
    });

    it("Keeps lastStakeBlock through a partial withdrawal, and resets it when a withdrawal empties the gauge", async function() {
      let lastStake = (await strategy.lastStakeBlock()).toString();
      assert.notEqual(lastStake, "0");

      // a user withdrawal taking part of the stake keeps the last stake, and so the interval
      let block = await withdrawFromGauge(1000000);
      Utils.assertBNGt(await gauge.balanceOf(strategy.address), 0);
      assert.equal((await strategy.lastStakeBlock()).toString(), lastStake, "a partial withdrawal should keep lastStakeBlock");

      // each exit that empties the gauge resets it, and the hard work after it stakes everything at once: withdrawToVault
      // (what user withdrawals call) for all of the strategy's LP, withdrawAllToVault, emergencyExit
      let exits = [
        ["withdrawToVault", async () => strategy.withdrawToVault(await strategy.investedUnderlyingBalance(), { from: governance })],
        ["withdrawAllToVault", async () => strategy.withdrawAllToVault({ from: governance, gasPrice: keeperGasPrice })],
        ["emergencyExit", async () => strategy.emergencyExit({ from: governance })],
      ];
      for (let [name, exit] of exits) {
        Utils.assertBNGt(await gauge.balanceOf(strategy.address), 0);
        try {
          await exit();
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
          assert.equal((await strategy.lastStakeBlock()).toString(), "0", name + " should reset lastStakeBlock");
        } finally {
          if (await strategy.pausedInvesting()) {
            await strategy.continueInvesting({ from: governance });
          }
        }
        block = await doHardWork();
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake at once after " + name);
        assert.equal((await strategy.lastStakeBlock()).toString(), String(block));
      }
    });

    it("Accepts a minStakeInterval from 0 to 12,960,000 blocks (about 30 days), from governance only", async function() {
      let message = await revertMessage(strategy.setMinStakeInterval(0, { from: farmer2 }), "only governance should set minStakeInterval");
      assert.include(message, "Not governance");
      message = await revertMessage(strategy.setMinStakeInterval(12960001, { from: governance }), "more than 30 days should be rejected");
      assert.include(message, "Invalid stake interval");
      assert.equal((await strategy.minStakeInterval()).toString(), String(interval), "rejected values should change nothing");

      try {
        for (let valid of [12960000, 0, 1]) {
          let tx = await strategy.setMinStakeInterval(valid, { from: governance });
          let changed = await strategyEvents("MinStakeIntervalChanged", tx.receipt.blockNumber);
          assert.equal(changed.length, 1);
          assert.equal(changed[0].args.minStakeInterval.toString(), String(valid));
          assert.equal((await strategy.minStakeInterval()).toString(), String(valid));
        }
      } finally {
        await strategy.setMinStakeInterval(interval, { from: governance });
      }
    });
  });

  describe("Minimum staking period (7 blocks)", function() {
    before(async function() {
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      await Utils.advanceNBlock(1800); // past the window and the spacing of the last stake, with an hour of rewards
    });

    it("Claims and then stakes in the same transaction, outside the window", async function() {
      await depositVault(farmer2, underlying, vault, farmer2Balance);
      let block = await doHardWork();

      let claimed = await gaugeEvents("EmissionsClaimed", block);
      assert.equal(claimed.length, 1, "should claim outside the window");
      lastClaimAmount = new BigNumber(claimed[0].args._rewardAmount.toString());
      Utils.assertBNGt(lastClaimAmount, 0);
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake right after the claim");
      assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);

      // the window opened with the stake; the next stake waits stakeSpacing (10) windows
      let window = await strategy.penaltyWindow();
      console.log("claimed AERO: ", lastClaimAmount.toFixed(), " window ends at block: ", window.windowEndBlock.toString());
      assert.equal(window.minStakeBlocks.toString(), "7");
      assert.equal(window.windowEndBlock.toString(), String(block + 7));
      assert.equal(window.inWindow, true, "should be inside the window");
      assert.equal((await strategy.stakeSpacing()).toString(), "10");
    });

    it("Skips the claim and the stake inside the window, without reverting", async function() {
      await depositVault(farmer1, underlying, vault, new BigNumber(await underlying.balanceOf(farmer1)));
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      let block = await doHardWork();

      assert.equal((await strategyEvents("ClaimSkipped", block)).length, 1, "claim should be skipped");
      assert.equal((await strategyEvents("StakeSkipped", block)).length, 1, "stake should be skipped");
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 0);
      assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
      // the new LP waits, unstaked, in the strategy
      Utils.assertBNGt(await underlying.balanceOf(strategy.address), 0);
    });

    it("Pays a withdrawal from idle LP first, without touching the gauge", async function() {
      Utils.assertBNEq(await vault.underlyingBalanceInVault(), 0);
      let idleBefore = new BigNumber(await underlying.balanceOf(strategy.address));
      let depositBlockBefore = (await gauge.depositBlock(strategy.address)).toString();

      // shares worth half of the idle LP
      let shares = idleBefore.div(2).times(await vault.totalSupply()).idiv(await vault.underlyingBalanceWithInvestment());
      let farmerBefore = new BigNumber(await underlying.balanceOf(farmer1));
      let tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
      let paid = new BigNumber(await underlying.balanceOf(farmer1)).minus(farmerBefore);

      assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 0, "the gauge should not be touched");
      assert.equal((await gaugeEvents("EarlyWithdrawPenalty", tx.receipt.blockNumber)).length, 0);
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), idleBefore.minus(paid));
      assert.equal((await gauge.depositBlock(strategy.address)).toString(), depositBlockBefore);
    });

    it("Lets a user withdraw inside the window, losing only the rewards since the last claim", async function() {
      assert.equal((await strategy.penaltyWindow()).inWindow, true, "should be inside the window");
      let shares = new BigNumber(await vault.balanceOf(farmer2));
      let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
      let idleBefore = new BigNumber(await underlying.balanceOf(strategy.address));
      // everything the gauge holds for the strategy as unclaimed: what accrued since the claim-then-stake
      let pending = new BigNumber(await gauge.balanceOf(strategy.address))
        .times(new BigNumber(await gauge.projectedRewardPerToken()).minus(await gauge.userRewardPerTokenPaid(strategy.address)))
        .idiv(1e18)
        .plus(await gauge.rewards(strategy.address));

      let farmerBefore = new BigNumber(await underlying.balanceOf(farmer2));
      let tx = await vault.withdraw(shares.toFixed(), { from: farmer2 });
      let received = new BigNumber(await underlying.balanceOf(farmer2)).minus(farmerBefore);

      // full pro-rata LP, never blocked; the idle LP was used first
      Utils.assertBNEq(received, expected);
      let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
      assert.equal(withdrawn.length, 1);
      Utils.assertBNEq(withdrawn[0].args._amount.toString(), expected.minus(idleBefore));

      // the gauge forfeits the pending rewards, but those are only a few blocks old
      let penalties = await gaugeEvents("EarlyWithdrawPenalty", tx.receipt.blockNumber);
      assert.equal(penalties.length, 1);
      let lost = new BigNumber(penalties[0].args._penalty.toString());
      console.log("AERO lost: ", lost.toFixed(), " vs AERO claimed before the stake: ", lastClaimAmount.toFixed());
      Utils.assertBNGte(lost, pending); // what was pending (plus the block of the withdrawal) ...
      Utils.assertBNGt(lastClaimAmount, lost.times(100)); // ... is tiny next to what the claim-then-stake protected
      Utils.assertBNGte(received, farmer2Balance.minus(10));
    });

    it("Claims after the window, but waits stakeSpacing windows before staking again", async function() {
      let depositBlock = Number((await gauge.depositBlock(strategy.address)).toString());
      await advanceToBlock(depositBlock + 7);
      assert.equal((await strategy.penaltyWindow()).inWindow, false, "should be outside the window");

      let block = await doHardWork();
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
      assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake yet");
      assert.equal((await strategyEvents("StakeSkipped", block)).length, 1);

      // the first block where staking is allowed again:
      // last deposit (windowEndBlock - minStakeBlocks) + stakeSpacing * minStakeBlocks
      let window = await strategy.penaltyWindow();
      let minStakeBlocks = Number(window.minStakeBlocks.toString());
      let nextStakeBlock = Number(window.windowEndBlock.toString()) - minStakeBlocks
        + Number((await strategy.stakeSpacing()).toString()) * minStakeBlocks;
      assert.equal(nextStakeBlock, depositBlock + 70);

      // one block earlier it still waits
      await advanceToBlock(nextStakeBlock - 2);
      block = await doHardWork();
      assert.equal(block, nextStakeBlock - 1);
      assert.equal((await gaugeEvents("Deposit", block)).length, 0, "one block early: should not stake yet");
      assert.equal((await strategyEvents("StakeSkipped", block)).length, 1);

      // the next hard work lands exactly on that block, and stakes
      block = await doHardWork();
      assert.equal(block, nextStakeBlock);
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1);
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake");
      assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Can withdraw everything to the vault inside the window", async function() {
      assert.equal((await strategy.penaltyWindow()).inWindow, true, "should be inside the window");
      let total = new BigNumber(await vault.underlyingBalanceWithInvestment());

      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });

      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
      // a full exit clears the gauge timer, and the strategy's own record of its last stake
      assert.equal((await gauge.depositBlock(strategy.address)).toString(), "0");
      assert.equal((await strategy.lastStakeBlock()).toString(), "0");
    });

    it("Can exit in an emergency inside the window", async function() {
      // the vault invests again; nothing is staked, so the strategy claims (nothing) and stakes
      await doHardWork();
      assert.equal((await strategy.penaltyWindow()).inWindow, true, "should be inside the window");
      Utils.assertBNGt(await gauge.balanceOf(strategy.address), 0);

      await strategy.emergencyExit({ from: governance });
      try {
        assert.equal(await strategy.pausedInvesting(), true, "investing should be paused");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        // and every hard work reverts until governance resumes investing
        let message = await revertMessage(controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice }),
          "hard work should revert while investing is paused");
        assert.include(message, "Action blocked as the strategy is in emergency state");
      } finally {
        await strategy.continueInvesting({ from: governance });
      }
    });

    it("Handles Aero lengthening the window after the stake", async function() {
      await Utils.advanceNBlock(7);
      await doHardWork(); // stakes with a 7-block window

      // retroactive: our existing stake is now inside a 1000-block window
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 1000, { from: penaltyAdmin });
      await Utils.advanceNBlock(20);
      let block = await doHardWork();
      assert.equal((await strategyEvents("ClaimSkipped", block)).length, 1, "claim should be skipped");
      assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);

      await Utils.advanceNBlock(1000);
      block = await doHardWork();
      let claimed = await gaugeEvents("EmissionsClaimed", block);
      assert.equal(claimed.length, 1, "should claim once the longer window is over");
      Utils.assertBNGt(claimed[0].args._rewardAmount.toString(), 0);
      assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
    });
  });

  describe("Minimum staking period: Aero and governance settings (7 blocks)", function() {
    before(async function() {
      // back to a 7-block window: the last stake is long past it and its stakeSpacing
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
    });

    it("Claims and stakes on every hard work while Aero charges no penalty, even with a window", async function() {
      let block = await claimThenStake(await farmer2LP(10));
      let config = await gaugeFactoryGovernance.methods.penaltyConfig().call();
      assert.equal(config.penaltyRate.toString(), "1000000", "Aero's default should forfeit everything inside the window");

      // Aero stops charging the penalty, factory-wide (setPenaltyConfig also sets the default window: kept as it is);
      // the gauge keeps its own 7-block window
      await gaugeFactoryGovernance.methods.setPenaltyConfig(config.minStakeBlocks, 0).send({ from: penaltyAdmin });
      try {
        let window = await strategy.penaltyWindow();
        assert.equal(window.minStakeBlocks.toString(), "7");
        assert.equal(window.penaltyRate.toString(), "0");
        assert.equal(window.windowEndBlock.toString(), String(block + 7));
        assert.equal(window.inWindow, false, "nothing can be forfeited, so there is nothing to wait for");

        // so every hard work claims and stakes: inside the 7 blocks after the last stake, long before stakeSpacing (and with
        // minStakeInterval 0, set in the root before(), nothing else spaces the stakes)
        for (let i = 0; i < 2; i++) {
          let lastStake = Number((await gauge.depositBlock(strategy.address)).toString());
          await depositVault(farmer2, underlying, vault, await farmer2LP(10));
          block = await doHardWork();
          assert.isBelow(block, lastStake + 7, "should run inside the window of the last stake");
          assert.equal((await strategyEvents("ClaimSkipped", block)).length, 0, "should not skip the claim");
          assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
          assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
          assert.equal((await strategyEvents("StakeSkipped", block)).length, 0, "should not wait for stakeSpacing");
          assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake");
          Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        }

        // a user withdrawal reaching the gauge right after a stake keeps all the strategy earned since then
        let shares = new BigNumber(await vault.balanceOf(farmer2)).div(2).integerValue(BigNumber.ROUND_DOWN);
        let before = await gaugeCheckpoint();
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer2 });
        assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 1, "the withdrawal should reach the gauge");
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", tx.receipt.blockNumber)).length, 0, "nothing should be forfeited");
        let claimed = await gaugeEvents("EmissionsClaimed", tx.receipt.blockNumber);
        assert.equal(claimed.length, 1);
        Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
      } finally {
        await gaugeFactoryGovernance.methods.setPenaltyConfig(config.minStakeBlocks, config.penaltyRate).send({ from: penaltyAdmin });
      }

      // with the penalty back, the last stake is inside its window again
      let window = await strategy.penaltyWindow();
      assert.equal(window.penaltyRate.toString(), "1000000");
      assert.equal(window.inWindow, true, "should be inside the window again");
    });

    it("Still skips the claim at a 50% penalty, and a withdrawal inside the window forfeits half of the rewards since the last claim", async function() {
      let config = await gaugeFactoryGovernance.methods.penaltyConfig().call();
      await gaugeFactoryGovernance.methods.setPenaltyConfig(config.minStakeBlocks, 500000).send({ from: penaltyAdmin });
      try {
        // half of farmer2's LP is staked, so that its withdrawal below reaches the gauge
        let block = await claimThenStake(await farmer2LP(2));
        let window = await strategy.penaltyWindow();
        assert.equal(window.penaltyRate.toString(), "500000");
        assert.equal(window.windowEndBlock.toString(), String(block + 7));
        assert.equal(window.inWindow, true, "a partial penalty should still make a window");

        // inside the window a claim would lose half of the rewards: the hard work skips the claim and the stake
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        let skippedBlock = await doHardWork();
        let skipped = await strategyEvents("ClaimSkipped", skippedBlock);
        assert.equal(skipped.length, 1, "claim should be skipped");
        assert.equal(skipped[0].args.windowEndBlock.toString(), String(block + 7));
        assert.equal((await strategyEvents("StakeSkipped", skippedBlock)).length, 1, "stake should be skipped");
        assert.equal((await gaugeEvents("EmissionsClaimed", skippedBlock)).length, 0);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", skippedBlock)).length, 0);

        // farmer2 withdraws everything inside the window: the gauge claims all the strategy earned since the
        // claim-then-stake, forfeits half of it and pays the other half to the strategy
        let shares = new BigNumber(await vault.balanceOf(farmer2));
        let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
        let idleBefore = new BigNumber(await underlying.balanceOf(strategy.address));
        let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let before = await gaugeCheckpoint();
        let farmerBefore = new BigNumber(await underlying.balanceOf(farmer2));
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer2 });
        Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer2)).minus(farmerBefore), expected);
        let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
        assert.equal(withdrawn.length, 1);
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), expected.minus(idleBefore));

        let reward = (await accruedSince(before)).plus(before.rewards);
        let penalties = await gaugeEvents("EarlyWithdrawPenalty", tx.receipt.blockNumber);
        assert.equal(penalties.length, 1);
        let lost = new BigNumber(penalties[0].args._penalty.toString());
        let claimed = await gaugeEvents("EmissionsClaimed", tx.receipt.blockNumber);
        assert.equal(claimed.length, 1, "the other half should be paid");
        let kept = new BigNumber(claimed[0].args._rewardAmount.toString());
        console.log("AERO earned since the last claim: ", reward.toFixed(), " lost: ", lost.toFixed(), " kept: ", kept.toFixed());
        Utils.assertBNGt(reward, 0);
        Utils.assertBNEq(lost, reward.times(500000).idiv(1000000)); // the penalty share, rounded down by the gauge
        Utils.assertBNEq(kept, reward.minus(lost));
        Utils.assertBNEq(new BigNumber(await aeroToken.balanceOf(strategy.address)).minus(aeroBefore), kept);

        // a withdrawal does not restart the window: the claim is free again at the stake's windowEndBlock
        assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(block));
        await advanceToBlock(block + 6);
        let next = await doHardWork();
        assert.equal(next, block + 7);
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim after the window");
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should still wait for stakeSpacing");
      } finally {
        await gaugeFactoryGovernance.methods.setPenaltyConfig(config.minStakeBlocks, config.penaltyRate).send({ from: penaltyAdmin });
      }
      assert.equal((await strategy.penaltyWindow()).penaltyRate.toString(), "1000000");
    });

    it("Claims and stakes at once when Aero removes the window while the strategy is inside one, and no longer needs the claim to stake", async function() {
      let block = await claimThenStake(await farmer2LP(10));
      assert.equal((await strategy.penaltyWindow()).inWindow, true, "should be inside the window");
      await depositVault(farmer2, underlying, vault, await farmer2LP(10));

      // Aero sets the gauge back to the factory default: no window
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      try {
        await assertNoWindow();
        let window = await strategy.penaltyWindow();
        assert.equal(window.minStakeBlocks.toString(), "0");
        assert.equal(window.windowEndBlock.toString(), String(block), "a 0-block window should end where it starts");
        assert.equal(window.inWindow, false, "should be outside any window");

        // still inside the old 7 blocks and far from the old stakeSpacing, the next hard work claims and stakes (with no
        // window only minStakeInterval spaces the stakes, and it is 0 here: root before())
        let next = await doHardWork();
        assert.isBelow(next, block + 7, "should run inside the old window");
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 0, "should not skip the claim");
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim");
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 0, "should not wait for stakeSpacing");
        assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);

        // with no window a stake cannot cost rewards, so it no longer waits for a claim: not even while minting is paused
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
        try {
          next = await doHardWork();
          assert.equal((await strategyEvents("ClaimFailed", next)).length, 1, "claim should fail without reverting");
          assert.equal((await strategyEvents("StakeSkipped", next)).length, 0, "should not wait for a claim");
          assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake without the claim");
          Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        } finally {
          await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
        }
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      }

      // the window is back, from that new stake
      assert.equal((await strategy.penaltyWindow()).inWindow, true, "should be inside the window again");
    });

    it("With stakeSpacing 1, claims and stakes again in the first hard work after the window", async function() {
      let tx = await strategy.setStakeSpacing(1, { from: governance });
      try {
        let changed = await strategyEvents("StakeSpacingChanged", tx.receipt.blockNumber);
        assert.equal(changed.length, 1);
        assert.equal(changed[0].args.stakeSpacing.toString(), "1");
        let block = await claimThenStake(await farmer2LP(10));
        // the next stake is allowed where the window ends
        assert.equal((await strategy.penaltyWindow()).windowEndBlock.toString(), String(block + 7));
        assert.equal(await nextStakeBlock(), block + 7);

        // new LP waits until the last block of the window
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        await advanceToBlock(block + 5);
        let next = await doHardWork();
        assert.equal(next, block + 6);
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 1, "claim should be skipped");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1, "stake should be skipped");
        assert.equal((await gaugeEvents("Deposit", next)).length, 0);

        // and the first block after the window both claims and stakes
        next = await doHardWork();
        assert.equal(next, block + 7);
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim");
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);
        assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake right after the claim");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      } finally {
        await strategy.setStakeSpacing(10, { from: governance });
      }
      assert.equal((await strategy.stakeSpacing()).toString(), "10");
    });

    it("With the maximum stakeSpacing (1000), keeps new LP idle for 1000 windows, while withdrawals still work", async function() {
      // only governance can set it, from 1 to 1000
      let message = await revertMessage(strategy.setStakeSpacing(0, { from: governance }), "a stakeSpacing of 0 should be rejected");
      assert.include(message, "Invalid stake spacing");
      message = await revertMessage(strategy.setStakeSpacing(1001, { from: governance }), "a stakeSpacing above 1000 should be rejected");
      assert.include(message, "Invalid stake spacing");
      message = await revertMessage(strategy.setStakeSpacing(1000, { from: farmer2 }), "only governance should set stakeSpacing");
      assert.include(message, "Not governance");

      // half of farmer2's LP is staked, so that its withdrawal below reaches the gauge
      let block = await claimThenStake(await farmer2LP(2));
      await strategy.setStakeSpacing(1000, { from: governance });
      try {
        let stakeBlock = await nextStakeBlock();
        assert.equal(stakeBlock, block + 7000);

        // after the window it claims and compounds, but the new LP stays idle
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        await advanceToBlock(block + 6);
        let next = await doHardWork();
        assert.equal(next, block + 7);
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim after the window");
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake yet");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
        // the idle LP still counts in the strategy's value, and so in the vault's share price
        await assertIdleLPCounted();
        // long after the default stakeSpacing (70 blocks), still
        await advanceToBlock(block + 699);
        next = await doHardWork();
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim");
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake yet");
        let idleBefore = new BigNumber(await underlying.balanceOf(strategy.address));
        Utils.assertBNGt(idleBefore, 0);
        await assertIdleLPCounted();

        // meanwhile a withdrawal is paid from the idle LP first ...
        let shares = idleBefore.div(2).times(await vault.totalSupply()).idiv(await vault.underlyingBalanceWithInvestment());
        let farmerBefore = new BigNumber(await underlying.balanceOf(farmer2));
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer2 });
        let paid = new BigNumber(await underlying.balanceOf(farmer2)).minus(farmerBefore);
        assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 0, "the gauge should not be touched");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), idleBefore.minus(paid));
        // ... and from the gauge for the rest, outside the window: nothing is forfeited
        shares = new BigNumber(await vault.balanceOf(farmer2));
        let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
        idleBefore = new BigNumber(await underlying.balanceOf(strategy.address));
        farmerBefore = new BigNumber(await underlying.balanceOf(farmer2));
        tx = await vault.withdraw(shares.toFixed(), { from: farmer2 });
        Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer2)).minus(farmerBefore), expected);
        let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
        assert.equal(withdrawn.length, 1);
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), expected.minus(idleBefore));
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", tx.receipt.blockNumber)).length, 0);
        // the stake keeps its deposit block, so the next stake is as far away as before
        assert.equal(await nextStakeBlock(), stakeBlock);

        // one block before the 1000th window ends it still waits, then it stakes
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        await advanceToBlock(stakeBlock - 2);
        next = await doHardWork();
        assert.equal(next, stakeBlock - 1);
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "one block early: should not stake yet");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
        next = await doHardWork();
        assert.equal(next, stakeBlock);
        assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      } finally {
        await strategy.setStakeSpacing(10, { from: governance });
      }
    });

    it("With nothing staked, stakes at once even under Aero's longest window and the maximum stakeSpacing", async function() {
      // nothing staked: no window, and no last stake to space the next one from
      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      assert.equal((await gauge.depositBlock(strategy.address)).toString(), "0");
      let lpBefore = await unstakedLP();

      // the longest window Aero allows, and the maximum stakeSpacing: 1000 windows of 90000 blocks counted from block 0
      // would end at block 90,000,000, long after this one
      let maxWindow = Number(await gaugeFactoryGovernance.methods.MAX_MIN_STAKE_BLOCKS().call());
      assert.equal(maxWindow, 90000);
      await strategy.setStakeSpacing(1000, { from: governance });
      try {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, maxWindow, { from: penaltyAdmin });
        let window = await strategy.penaltyWindow();
        assert.equal(window.minStakeBlocks.toString(), String(maxWindow));
        assert.equal(window.windowEndBlock.toString(), "0", "nothing staked: no window");
        assert.equal(window.inWindow, false);

        // the next hard work claims (nothing is owed) and stakes everything at once
        let block = await doHardWork();
        assert.isBelow(block, 1000 * maxWindow);
        assert.equal((await strategyEvents("ClaimSkipped", block)).length, 0, "should not skip the claim");
        assert.equal((await strategyEvents("ClaimFailed", block)).length, 0);
        assert.equal((await strategyEvents("StakeSkipped", block)).length, 0, "the first stake should not wait for stakeSpacing");
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake at once");
        Utils.assertBNGte(deposits[0].args._amount.toString(), lpBefore);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        // and that stake opens the whole window
        window = await strategy.penaltyWindow();
        assert.equal(window.windowEndBlock.toString(), String(block + maxWindow));
        assert.equal(window.inWindow, true, "should be inside the window");
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
        await strategy.setStakeSpacing(10, { from: governance });
      }
      assert.equal((await strategy.stakeSpacing()).toString(), "10");
      assert.equal((await strategy.penaltyWindow()).minStakeBlocks.toString(), "7");
    });

    it("Takes the stake out of a gauge Aero switched off with its first claim after the window, without waiting for stakeSpacing, and keeps new LP unstaked where stakeSpacing allows a stake", async function() {
      let cap = (await gaugeFactory.emissionCap(gaugeAddress)).toString();
      Utils.assertBNGt(cap, 0);
      let block = await claimThenStake(await farmer2LP(10));
      let stakeBlock = await nextStakeBlock();
      assert.equal(stakeBlock, block + 70);
      await depositVault(farmer2, underlying, vault, await farmer2LP(10)); // new LP

      // Aero switches the gauge off while the stake is inside its window
      await setEmissionCap(0);
      try {
        assert.equal((await gaugeFactory.emissionCap(gaugeAddress)).toString(), "0");
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));

        // a switched-off gauge pays no AERO and its stakers get no pool fees: the strategy leaves it, but not inside the
        // window, where it can claim nothing and leaving would forfeit all the stake earned since the claim-then-stake
        let next = await doHardWork();
        assert.isBelow(next, block + 7, "should run inside the window");
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 1, "claim should be skipped");
        assert.equal((await gaugeEvents("Withdraw", next)).length, 0, "should not leave the gauge without a claim");
        assert.equal((await strategyEvents("UnstakedFromInactiveGauge", next)).length, 0);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake in a switched-off gauge");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);

        // the first hard work after the window claims (the AERO earned before the switch-off), then takes the whole stake
        // out in the same transaction, with nothing left to forfeit. It leaves at once, 63 blocks before stakeSpacing would
        // allow a stake: stakeSpacing and minStakeInterval only space stakes. Nothing is staked, and the LP waits
        await advanceToBlock(block + 6);
        let before = await gaugeCheckpoint();
        next = await doHardWork();
        assert.equal(next, block + 7, "should run at the first block after the window");
        assert.isBelow(next, stakeBlock, "should leave long before stakeSpacing would allow a stake");
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 0);
        assert.equal((await strategyEvents("ClaimFailed", next)).length, 0);
        let claimed = await gaugeEvents("EmissionsClaimed", next);
        assert.equal(claimed.length, 1, "should claim");
        Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
        let withdrawn = await gaugeEvents("Withdraw", next);
        assert.equal(withdrawn.length, 1, "should take the stake out right after the claim");
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
        let unstaked = await strategyEvents("UnstakedFromInactiveGauge", next);
        assert.equal(unstaked.length, 1);
        Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);
        assert.equal((await gaugeEvents("EmergencyWithdraw", next)).length, 0);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        assert.equal((await gauge.depositBlock(strategy.address)).toString(), "0", "no window left to wait for");
        assert.equal((await strategy.lastStakeBlock()).toString(), "0");
        assert.equal(await nextStakeBlock(), 0);
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake in a switched-off gauge");
        let idle = new BigNumber(await underlying.balanceOf(strategy.address));
        Utils.assertBNGt(idle, staked);
        let skipped = await strategyEvents("StakeSkipped", next);
        assert.equal(skipped.length, 1);
        Utils.assertBNEq(skipped[0].args.idleAmount.toString(), idle);
        await assertIdleLPCounted();

        // where the stakeSpacing of the old stake would have allowed a stake, the gauge still switched off: nothing to claim
        // or to take out, and all the LP stays unstaked
        await advanceToBlock(stakeBlock - 1);
        next = await doHardWork();
        assert.isAtLeast(next, stakeBlock, "should be past the old stake's stakeSpacing");
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 0, "nothing staked: nothing to claim");
        assert.equal((await gaugeEvents("Withdraw", next)).length, 0);
        assert.equal((await strategyEvents("UnstakedFromInactiveGauge", next)).length, 0);
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake in a switched-off gauge");
        skipped = await strategyEvents("StakeSkipped", next);
        assert.equal(skipped.length, 1);
        Utils.assertBNEq(skipped[0].args.idleAmount.toString(), await underlying.balanceOf(strategy.address));

        // the same without a window: nothing is left to unstake, and nothing is staked
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
        try {
          await assertNoWindow();
          await depositVault(farmer2, underlying, vault, await farmer2LP(10));
          next = await doHardWork();
          assert.equal((await strategyEvents("ClaimFailed", next)).length, 0);
          assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 0, "nothing staked: nothing to claim");
          assert.equal((await gaugeEvents("Withdraw", next)).length, 0);
          assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake in a switched-off gauge");
          assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
        } finally {
          await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
        }
      } finally {
        await setEmissionCap(cap);
      }

      // switched back on: nothing is staked, so the next hard work claims (nothing) and stakes all the LP at once
      assert.equal((await gaugeFactory.emissionCap(gaugeAddress)).toString(), cap);
      let next = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake again");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Runs a hard work that governance calls directly while investOnDeposit is on, under the same window rules", async function() {
      await advanceToBlock(await nextStakeBlock());
      await vault.setInvestOnDeposit(true, { from: governance });
      try {
        // a user deposit moves the LP on to the strategy, but its hard work is skipped, and so is the keeper's
        let amount = await farmer2LP(10);
        await underlying.approve(vault.address, amount, { from: farmer2 });
        let tx = await vault.deposit(amount, farmer2, { from: farmer2 });
        assert.equal((await strategyEvents("HardWorkSkipped", tx.receipt.blockNumber)).length, 1, "user deposit should not run the hard work");
        assert.equal((await gaugeEvents("Deposit", tx.receipt.blockNumber)).length, 0, "user deposit should not reach the gauge");
        Utils.assertBNGte(await underlying.balanceOf(strategy.address), amount);
        let block = await doHardWork();
        assert.equal((await strategyEvents("HardWorkSkipped", block)).length, 1, "keeper hard work should be skipped");

        // governance calling the strategy itself is not skipped: outside the window and past stakeSpacing, it claims and stakes
        tx = await strategy.doHardWork({ from: governance, gasPrice: keeperGasPrice });
        block = tx.receipt.blockNumber;
        assert.equal((await strategyEvents("HardWorkSkipped", block)).length, 0, "a direct hard work should not be skipped");
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake right after the claim");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        let window = await strategy.penaltyWindow();
        assert.equal(window.windowEndBlock.toString(), String(block + 7));
        assert.equal(window.inWindow, true, "should be inside the window");

        // inside the window it skips the claim and the stake, like a keeper hard work
        amount = await farmer2LP(10);
        await underlying.approve(vault.address, amount, { from: farmer2 });
        await vault.deposit(amount, farmer2, { from: farmer2 });
        tx = await strategy.doHardWork({ from: governance, gasPrice: keeperGasPrice });
        let next = tx.receipt.blockNumber;
        assert.isBelow(next, block + 7, "should run inside the window");
        assert.equal((await strategyEvents("HardWorkSkipped", next)).length, 0);
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 1, "claim should be skipped");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1, "stake should be skipped");
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 0);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);

        // after the window it claims, and waits for stakeSpacing to stake
        await advanceToBlock(block + 6);
        tx = await strategy.doHardWork({ from: governance, gasPrice: keeperGasPrice });
        next = tx.receipt.blockNumber;
        assert.equal(next, block + 7);
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim after the window");
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should still wait for stakeSpacing");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
      } finally {
        await vault.setInvestOnDeposit(false, { from: governance });
      }
    });
  });

  describe("Gauge switched off by Aero (no window)", function() {
    let cap;
    let previousWindow;

    before(async function() {
      previousWindow = (await gaugeFactory.effectivePenaltyConfig(gaugeAddress)).minStakeBlocks.toString();
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      await assertNoWindow();
      cap = (await gaugeFactory.emissionCap(gaugeAddress)).toString();
      Utils.assertBNGt(cap, 0);
      await doHardWork(); // everything staked
    });

    after(async function() {
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, previousWindow, { from: penaltyAdmin });
    });

    it("Takes the whole stake out right after its claim, through the gauge's normal withdraw, with nothing forfeited", async function() {
      await mineBlocks(1800); // an hour of rewards
      await setEmissionCap(0);
      try {
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));
        Utils.assertBNGt(staked, 0);
        let unstakedBefore = await unstakedLP();
        let value = new BigNumber(await vault.underlyingBalanceWithInvestment());
        let before = await gaugeCheckpoint();
        let block = await doHardWork();

        // the claim pays all the stake earned, so the exit right after it, in the same transaction, finds nothing to forfeit
        let claimed = await gaugeEvents("EmissionsClaimed", block);
        assert.equal(claimed.length, 1, "should claim");
        Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
        let withdrawn = await gaugeEvents("Withdraw", block);
        assert.equal(withdrawn.length, 1, "should take the stake out through the normal withdraw");
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
        let unstaked = await strategyEvents("UnstakedFromInactiveGauge", block);
        assert.equal(unstaked.length, 1);
        Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
        assert.equal((await gaugeEvents("EmergencyWithdraw", block)).length, 0);
        let forfeited = await leafVoterEvents.getPastEvents("EmissionsForfeited", { filter: { _gauge: gaugeAddress }, fromBlock: block, toBlock: block });
        assert.equal(forfeited.length, 0, "nothing should be forfeited");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        assert.equal((await strategy.lastStakeBlock()).toString(), "0");

        // all the LP waits in the strategy and keeps counting: the vault's value only grew, by the LP compounded from the claim
        let idle = new BigNumber(await underlying.balanceOf(strategy.address));
        let compounded = await mintedLP(block);
        Utils.assertBNGt(compounded, 0);
        Utils.assertBNEq(idle, unstakedBefore.plus(staked).plus(compounded));
        let skipped = await strategyEvents("StakeSkipped", block);
        assert.equal(skipped.length, 1);
        Utils.assertBNEq(skipped[0].args.idleAmount.toString(), idle);
        Utils.assertBNEq(await vault.underlyingBalanceWithInvestment(), value.plus(compounded));
        await assertIdleLPCounted();

        // from then on there is nothing to claim or to take out, and the LP stays idle
        block = await doHardWork();
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 0);
        assert.equal((await gaugeEvents("Withdraw", block)).length, 0);
        assert.equal((await strategyEvents("UnstakedFromInactiveGauge", block)).length, 0);
        assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake in a switched-off gauge");
        assert.equal((await strategyEvents("StakeSkipped", block)).length, 1);
      } finally {
        await setEmissionCap(cap);
      }
    });

    it("Earns pool fees on the LP it took out, and compounds them into LP with no AERO to sell", async function() {
      // still out of the gauge (switched off again before any hard work could stake): the idle LP earns its share of the
      // fees of every swap through the pool
      await setEmissionCap(0);
      try {
        let idle = new BigNumber(await underlying.balanceOf(strategy.address));
        Utils.assertBNGt(idle, 0);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        let feesBefore = await pendingFees();
        // swaps of USDC for AERO only, whose fees are paid in USDC: AERO fees, AERO above MIN_REWARD, would be sold with the
        // claim like rewards, fee included. The strategy holds no AERO worth selling
        Utils.assertBNGt(new BigNumber("10000000000000"), await aeroToken.balanceOf(strategy.address));
        let usdcIn = (await burnLP(20))[1];
        for (let i = 0; i < 3; i++) {
          await poolSwap(farmer2, usdc, usdcIn.idiv(3).toFixed());
        }
        let pending = await pendingFees();
        Utils.assertBNEq(pending.amount0, feesBefore.amount0);
        Utils.assertBNGt(await dollars(pending.amount0, pending.amount1), await dollars(feesBefore.amount0, feesBefore.amount1));

        let sharePrice = new BigNumber(await vault.getPricePerFullShare());
        let block = await doHardWork();
        let claims = await feeClaims(block);
        assert.equal(claims.length, 1, "should claim the pool fees");
        Utils.assertBNEq(claims[0].returnValues.amount0, pending.amount0);
        Utils.assertBNEq(claims[0].returnValues.amount1, pending.amount1);
        // nothing staked, so no AERO claimed or sold, and still the fees go into the pool
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 0);
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "no AERO to sell");
        assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should mint LP from the fees");
        let compounded = await mintedLP(block);
        Utils.assertBNGt(compounded, 0);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), idle.plus(compounded));
        Utils.assertBNGt(await vault.getPricePerFullShare(), sharePrice);
        assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake in a switched-off gauge");
        // almost nothing is left over: the zap put the fees into the pool in its own ratio
        let fees = await dollars(pending.amount0, pending.amount1);
        let leftover = await poolTokensHeld();
        console.log("pool fees ($, USDC 6 decimals): ", fees.toFixed(), " compounded into LP worth: ", (await lpDollars(compounded)).toFixed(),
          " left over: ", leftover.toFixed());
        Utils.assertBNGt(fees, leftover.times(100)); // leftover below 1% of the fees
      } finally {
        await setEmissionCap(cap);
      }
    });

    it("Stakes all the idle LP at once when Aero switches the gauge back on, even with the default minStakeInterval", async function() {
      // the full exit from the switched-off gauge reset lastStakeBlock: no interval to wait for
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      assert.equal((await strategy.lastStakeBlock()).toString(), "0");
      let idle = new BigNumber(await underlying.balanceOf(strategy.address));
      Utils.assertBNGt(idle, 0);
      await strategy.setMinStakeInterval(432000, { from: governance });
      try {
        let block = await doHardWork();
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake at once");
        Utils.assertBNGte(deposits[0].args._amount.toString(), idle);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        assert.equal((await strategy.lastStakeBlock()).toString(), String(block));
      } finally {
        await strategy.setMinStakeInterval(0, { from: governance });
      }
    });

    it("Takes the stake out of a switched-off gauge with its first claim, without waiting for minStakeInterval after its last stake", async function() {
      // with the default interval, a stake made a moment ago (the test above) keeps the next stake about a day of blocks
      // away; that only spaces stakes: a gauge Aero switches off is left with the first claim that goes through
      await strategy.setMinStakeInterval(432000, { from: governance });
      try {
        let lastStake = Number((await strategy.lastStakeBlock()).toString());
        assert.notEqual(lastStake, 0);
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));
        Utils.assertBNGt(staked, 0);
        await mineBlocks(600); // AERO to claim
        await setEmissionCap(0);
        try {
          let before = await gaugeCheckpoint();
          let block = await doHardWork();
          assert.isBelow(block, lastStake + 432000, "should run long before minStakeInterval would allow a stake");
          let claimed = await gaugeEvents("EmissionsClaimed", block);
          assert.equal(claimed.length, 1, "should claim");
          Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
          let withdrawn = await gaugeEvents("Withdraw", block);
          assert.equal(withdrawn.length, 1, "should take the stake out right after the claim");
          Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
          let unstaked = await strategyEvents("UnstakedFromInactiveGauge", block);
          assert.equal(unstaked.length, 1);
          Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
          assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
          assert.equal((await gaugeEvents("EmergencyWithdraw", block)).length, 0);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
          assert.equal((await strategy.lastStakeBlock()).toString(), "0");
          assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake in a switched-off gauge");
          let skipped = await strategyEvents("StakeSkipped", block);
          assert.equal(skipped.length, 1);
          Utils.assertBNEq(skipped[0].args.idleAmount.toString(), await underlying.balanceOf(strategy.address));
          await assertIdleLPCounted();
        } finally {
          await setEmissionCap(cap);
        }

        // switched back on: nothing staked and no last stake, so the next hard work stakes at once, interval or not
        let block = await doHardWork();
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      } finally {
        await strategy.setMinStakeInterval(0, { from: governance });
      }
    });

    it("Keeps the stake in a switched-off gauge while its claim fails (minting paused), and takes it out with the next claim that goes through", async function() {
      await mineBlocks(600);
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      await setEmissionCap(0);
      try {
        await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
        try {
          let block = await doHardWork();
          assert.equal((await strategyEvents("ClaimFailed", block)).length, 1, "claim should fail without reverting");
          assert.equal((await gaugeEvents("Withdraw", block)).length, 0, "should not leave the gauge without a claim");
          assert.equal((await strategyEvents("UnstakedFromInactiveGauge", block)).length, 0);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
          assert.notEqual((await strategy.lastStakeBlock()).toString(), "0");
        } finally {
          await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
        }

        let block = await doHardWork();
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        let unstaked = await strategyEvents("UnstakedFromInactiveGauge", block);
        assert.equal(unstaked.length, 1, "should leave the gauge right after the claim");
        Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
        assert.equal((await gaugeEvents("Withdraw", block)).length, 1);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      } finally {
        await setEmissionCap(cap);
      }

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
    });

    it("Reverts the whole hard work, claim included, when too little gas is left to leave a switched-off gauge", async function() {
      await mineBlocks(600);
      await setEmissionCap(0);
      try {
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));
        Utils.assertBNGt(staked, 0);
        let before = await gaugeCheckpoint();
        let aero = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let idle = new BigNumber(await underlying.balanceOf(strategy.address));

        // the exit is best effort (_tryExitGauge): it starts only with gaugeTapeGasLimit + 1,200,000 gas left, so that a
        // keeper that sent too little gas retries with more. The least keeper gas that gets through is set by that floor:
        // 300,000 gas less leaves too little at the exit, after the claim and the liquidation, and the hard work reverts as
        // a whole
        let least = await leastGas({ from: governance, to: controller.address, gasPrice: keeperGasPrice,
          data: controller.contract.methods.doHardWork(vault.address).encodeABI() }, 1000000, 8000000);
        console.log("least keeper gas for the hard work that leaves the switched-off gauge: ", least, " exit floor: ", await exitGasFloor());
        let message = await revertMessage(controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice, gas: least - 300000 }),
          "the hard work should revert with too little gas for the exit");
        assert.include(message, "Not enough gas for the gauge");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
        Utils.assertBNEq(await gauge.userRewardPerTokenPaid(strategy.address), before.paid); // nothing claimed
        Utils.assertBNEq(await gauge.rewards(strategy.address), before.rewards);
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aero);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), idle);

        // with enough gas, the same hard work claims and leaves (a margin over the simulated least gas: a block later the hard
        // work claims a little more and its liquidation may take another swap)
        let tx = await controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice, gas: least + 200000 });
        let block = tx.receipt.blockNumber;
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        assert.equal((await strategyEvents("UnstakedFromInactiveGauge", block)).length, 1, "should leave the gauge");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      } finally {
        await setEmissionCap(cap);
      }

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
    });

    it("Leaves a switched-off gauge through emergencyWithdraw when its withdraw fails after the claim, and keeps the stake when Aero has not enabled it", async function() {
      await mineBlocks(600);
      await setEmissionCap(0);
      try {
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));
        Utils.assertBNGt(staked, 0);
        let lastStake = (await strategy.lastStakeBlock()).toString();

        // the gauge's withdraw fails right after the claim. With emergencyWithdraw disabled the exit fails too: the hard work
        // reports it, keeps the stake and goes on
        await withGaugeFailingAfterClaim(async () => {
          let block = await doHardWork();
          assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "the claim should go through");
          let failures = await strategyEvents("GaugeExitFailed", block);
          assert.equal(failures.length, 1, "the exit should fail without reverting");
          assert.equal(failures[0].args.reason, "0xdeadbeef", "the gauge's own revert data");
          assert.equal((await gaugeEvents("Withdraw", block)).length, 0);
          assert.equal((await gaugeEvents("EmergencyWithdraw", block)).length, 0);
          assert.equal((await strategyEvents("UnstakedFromInactiveGauge", block)).length, 0);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
          assert.equal((await strategy.lastStakeBlock()).toString(), lastStake);
        });

        // enabled: the exit falls back to emergencyWithdraw. The gauge first runs switched on for a while, so that the
        // stake has AERO to claim again
        await setEmissionCap(cap);
        await mineBlocks(600);
        await setEmissionCap(0);
        await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
        try {
          await withGaugeFailingAfterClaim(async () => {
            let before = await gaugeCheckpoint();
            let block = await doHardWork();
            // emergencyWithdraw does no emission accounting (V2Gauge.emergencyWithdraw): it never reports a penalty or a
            // forfeit, it just leaves unpaid whatever the stake earned since its last checkpoint. That checkpoint is the
            // claim right before it, in the same transaction: the claim paying everything the stake earned is what shows
            // that nothing is lost, and the strategy is owed nothing after the exit
            let claimed = await gaugeEvents("EmissionsClaimed", block);
            assert.equal(claimed.length, 1, "the claim should go through");
            Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
            let exits = await gaugeEvents("EmergencyWithdraw", block);
            assert.equal(exits.length, 1, "should leave through emergencyWithdraw");
            Utils.assertBNEq(exits[0].args._amount.toString(), staked);
            let unstaked = await strategyEvents("UnstakedFromInactiveGauge", block);
            assert.equal(unstaked.length, 1);
            Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
            assert.equal((await strategyEvents("GaugeExitFailed", block)).length, 0);
            Utils.assertBNEq(await gauge.rewards(strategy.address), 0);
            Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
            assert.equal((await strategy.lastStakeBlock()).toString(), "0");
          });
        } finally {
          await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        }
      } finally {
        await setEmissionCap(cap);
      }

      // with the gauge working and on again, the next hard work stakes everything at once
      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });
  });

  describe("Minimum staking period over two stake cycles (1800 blocks)", function() {
    it("Skips claims only inside windows, stakes only after stakeSpacing, and loses only rewards earned inside windows", async function() {
      let windowBlocks = 1800; // an hour of Base blocks
      let keeperBlocks = 600; // a keeper run every 20 minutes
      let spacing = Number((await strategy.stakeSpacing()).toString());
      assert.equal(spacing, 10);
      let cycleRuns = spacing * windowBlocks / keeperBlocks; // 30 runs from one stake to the next
      let runs = 2 * cycleRuns + windowBlocks / keeperBlocks; // two full cycles, then the third window
      let previousWindow = (await gaugeFactory.effectivePenaltyConfig(gaugeAddress)).minStakeBlocks.toString();

      let stats = { inWindowRuns: 0, stakes: 0, fromIdle: 0, penalized: 0, outsideWindow: 0 };
      let claimed = new BigNumber(0); // by keeper runs, and by withdrawals outside windows
      let lost = new BigNumber(0);
      let earnedInWindows = new BigNumber(0);
      let lastStake;

      // a user withdrawal is always paid in full, from the vault and the idle LP first; one reaching the gauge inside a
      // window forfeits what the strategy earned since its last checkpoint, which is never older than the window
      async function withdraw(shares) {
        let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
        let available = new BigNumber(await vault.underlyingBalanceInVault()).plus(await underlying.balanceOf(strategy.address));
        let before = await gaugeCheckpoint();
        let farmerBefore = new BigNumber(await underlying.balanceOf(farmer2));
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer2 });
        let block = tx.receipt.blockNumber;
        Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer2)).minus(farmerBefore), expected);
        let reachesGauge = expected.gt(available);
        assert.equal((await gaugeEvents("Withdraw", block)).length, reachesGauge ? 1 : 0,
          "only what the vault and the idle LP cannot pay should come from the gauge");
        let penalties = await gaugeEvents("EarlyWithdrawPenalty", block);
        let claims = await gaugeEvents("EmissionsClaimed", block);
        if (!reachesGauge) {
          stats.fromIdle++;
          assert.equal(penalties.length + claims.length, 0);
        } else if (block < lastStake + windowBlocks) {
          stats.penalized++;
          let earned = await accruedSince(before);
          assert.equal(penalties.length, 1, "should forfeit inside the window");
          Utils.assertBNEq(penalties[0].args._penalty.toString(), earned.plus(before.rewards));
          assert.equal(claims.length, 0, "a 100% penalty should leave nothing to claim");
          lost = lost.plus(penalties[0].args._penalty.toString());
          earnedInWindows = earnedInWindows.plus(earned);
        } else {
          stats.outsideWindow++;
          assert.equal(penalties.length, 0, "should not forfeit outside the window");
          assert.equal(claims.length, 1);
          claimed = claimed.plus(claims[0].args._rewardAmount.toString());
        }
      }

      // a clean start: everything back in the vault, plus most of farmer2's LP
      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      let newLP = new BigNumber(await underlying.balanceOf(farmer2)).times(3).div(4).integerValue(BigNumber.ROUND_DOWN);
      await depositVault(farmer2, underlying, vault, newLP.toFixed());
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, windowBlocks, { from: penaltyAdmin });
      try {
        // nothing is staked, so there is no window and no stakeSpacing to wait for
        let start = await doHardWork();
        assert.equal((await gaugeEvents("Deposit", start)).length, 1, "the first run should stake");
        lastStake = start;
        let window = await strategy.penaltyWindow();
        assert.equal(window.minStakeBlocks.toString(), String(windowBlocks));
        assert.equal(window.windowEndBlock.toString(), String(start + windowBlocks));

        for (let k = 1; k <= runs; k++) {
          let target = start + k * keeperBlocks;
          let step = (k - 1) % cycleRuns; // 0: right after a stake; 0 to 2: inside its window

          // a user, halfway between two keeper runs
          await advanceToBlock(target - keeperBlocks / 2 - 1);
          let deposited = new BigNumber(0);
          if (step == 0) {
            // nothing is idle right after a stake: this reaches the gauge, inside the window
            await withdraw(new BigNumber(await vault.balanceOf(farmer2)).div(4).integerValue(BigNumber.ROUND_DOWN));
          } else if (step == 1 || step == 20) {
            deposited = new BigNumber(await farmer2LP(4));
            await depositVault(farmer2, underlying, vault, deposited.toFixed());
          } else if (step == 2) {
            // half of the idle LP: paid without touching the gauge
            let idle = new BigNumber(await underlying.balanceOf(strategy.address));
            await withdraw(idle.div(2).times(await vault.totalSupply()).idiv(await vault.underlyingBalanceWithInvestment()));
          } else if (step == 14) {
            await withdraw(new BigNumber(await vault.balanceOf(farmer2)).div(2).integerValue(BigNumber.ROUND_DOWN));
          }

          // the keeper
          await advanceToBlock(target - 1);
          let inWindow = target < lastStake + windowBlocks;
          let windowEnd = target == lastStake + windowBlocks;
          // only stakeSpacing spaces the stakes: minStakeInterval (0 here, root before()) never comes later
          let stakeTime = target >= lastStake + spacing * windowBlocks;
          let before = await gaugeCheckpoint();
          let block = await doHardWork();
          assert.equal(block, target);
          let skippedClaims = await strategyEvents("ClaimSkipped", block);
          let claims = await gaugeEvents("EmissionsClaimed", block);
          assert.equal(skippedClaims.length, inWindow ? 1 : 0, "should skip the claim inside the window only");
          assert.equal(claims.length, inWindow ? 0 : 1, "should claim outside the window");
          assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0, "a keeper run should never forfeit rewards");
          assert.equal((await gaugeEvents("Deposit", block)).length, stakeTime ? 1 : 0, "should stake only after stakeSpacing");
          // the LP deposited meanwhile has moved on to the strategy, where it waits for the next stake
          Utils.assertBNEq(await vault.underlyingBalanceInVault(), 0);
          let idle = new BigNumber(await underlying.balanceOf(strategy.address));
          let skippedStakes = await strategyEvents("StakeSkipped", block);
          if (stakeTime) {
            Utils.assertBNEq(idle, 0);
            // the new window starts with nothing earned before it: the stake came right after the claim
            Utils.assertBNEq(await gauge.rewards(strategy.address), 0);
            lastStake = block;
            stats.stakes++;
          } else {
            Utils.assertBNGte(idle, deposited);
            assert.equal(skippedStakes.length, idle.gt(0) ? 1 : 0);
            if (idle.gt(0)) {
              Utils.assertBNEq(skippedStakes[0].args.idleAmount.toString(), idle);
              await assertIdleLPCounted(); // the waiting LP keeps its full value for the vault's users
            }
          }
          if (inWindow) {
            stats.inWindowRuns++;
            assert.equal(skippedClaims[0].args.windowEndBlock.toString(), String(lastStake + windowBlocks));
          } else {
            let amount = new BigNumber(claims[0].args._rewardAmount.toString());
            claimed = claimed.plus(amount);
            if (windowEnd) {
              // the first run after a window claims the rest of what the strategy earned inside it
              let earned = await accruedSince(before);
              Utils.assertBNEq(amount, earned.plus(before.rewards));
              earnedInWindows = earnedInWindows.plus(earned);
            }
          }
        }

        console.log("keeper runs: ", runs, " inside a window: ", stats.inWindowRuns, " (", (100 * stats.inWindowRuns / runs).toFixed(1), "%), stakes: ", stats.stakes);
        console.log("user withdrawals paid without the gauge: ", stats.fromIdle, " from the gauge inside a window: ", stats.penalized,
          " outside: ", stats.outsideWindow);
        console.log("AERO claimed: ", claimed.toFixed(), " lost: ", lost.toFixed(), " earned inside windows: ", earnedInWindows.toFixed());
        assert.equal(stats.stakes, 2, "should stake once per stakeSpacing");
        assert.equal(stats.inWindowRuns, 3 * (windowBlocks / keeperBlocks - 1));
        assert.equal(stats.penalized, 3, "the withdrawal right after each stake should reach the gauge inside the window");
        assert.isAbove(stats.fromIdle, 0);
        assert.isAbove(stats.outsideWindow, 0);
        Utils.assertBNGt(lost, 0);
        Utils.assertBNGte(earnedInWindows, lost); // never more than what was earned inside the windows
        // why a tenth: a withdrawal inside a window forfeits what the whole stake earned since that window opened (the
        // claim-then-stake that opened it paid out everything earned before), so the loss is at most what was earned inside
        // windows (above). Over the long run windows are one window length in every stakeSpacing (10); this run ends with
        // its third window, so 3 of its 21 window lengths are inside one, and about a seventh of the AERO was earned there.
        // And each withdrawal that reaches the gauge inside a window comes 300 blocks after the stake that opened it: it
        // forfeits what the stake earned in those first 300 of the window's 1800 blocks, and the rest is claimed when the
        // window ends. So about a sixth of a seventh of the AERO is lost here, well below a tenth
        Utils.assertBNGte(claimed.idiv(10), lost);
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, previousWindow, { from: penaltyAdmin });
      }
    });
  });

  describe("Governance (7 blocks)", function() {
    before(async function() {
      // the stakes below open Aero's 7-block window, as in the settings tests
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
    });

    it("Lets only the strategy itself run liquidateRewards", async function() {
      // doHardWork and withdrawAllToVault call it on the strategy, so that its failures can be caught
      let message = await revertMessage(strategy.liquidateRewards({ from: governance }), "governance should not run liquidateRewards");
      assert.include(message, "Only self");
    });

    it("Rejects an outsider on the hard work, every exit and every setting, so nobody can force a withdrawal inside the window", async function() {
      // right after a stake, inside its window: an exit now would forfeit what the stake earned since then
      let block = await claimThenStake(await farmer2LP(10));
      let staked = (await gauge.balanceOf(strategy.address)).toString();
      let window = await strategy.penaltyWindow();
      assert.equal(window.inWindow, true, "should be inside the window");

      // BaseUpgradeableStrategy restricted (vault, controller, governance) and GovernableInit onlyGovernance
      let restricted = "The sender has to be the controller, governance, or vault";
      let notGovernance = "Not governance";
      // first what would reach the gauge, each sent in its own block, all inside the window ...
      let exits = [
        ["withdrawToVault", () => strategy.withdrawToVault(staked, { from: farmer2 }), restricted],
        ["withdrawAllToVault", () => strategy.withdrawAllToVault({ from: farmer2 }), restricted],
        ["emergencyExit", () => strategy.emergencyExit({ from: farmer2 }), notGovernance],
        ["setGauge", () => strategy.setGauge(gaugeAddress, { from: farmer2 }), notGovernance],
        ["doHardWork", () => strategy.doHardWork({ from: farmer2 }), restricted],
      ];
      for (let [name, call, expected] of exits) {
        let message = await revertMessage(call(), "an outsider's " + name + " should revert");
        assert.include(message, expected, name + " should reject an outsider");
      }
      assert.equal((await strategy.penaltyWindow()).inWindow, true, "the exits above should have been tried inside the window");
      // ... then the settings, the strategy's own and those it inherits (BaseUpgradeableStrategy, GovernableInit), all
      // onlyGovernance: setStorage would hand governance to another storage contract
      let governanceBefore = await strategy.governance(); // read through the storage contract
      let incentivesBefore = await strategy.incentives();
      let settings = [
        ["continueInvesting", () => strategy.continueInvesting({ from: farmer2 })],
        ["setSell", () => strategy.setSell(false, { from: farmer2 })],
        ["setMinStakeInterval", () => strategy.setMinStakeInterval(12960000, { from: farmer2 })],
        ["addRewardToken", () => strategy.addRewardToken(weth, { from: farmer2 })],
        ["removeRewardToken", () => strategy.removeRewardToken(weth, { from: farmer2 })],
        ["finalizeUpgrade", () => strategy.finalizeUpgrade({ from: farmer2 })],
        ["setStorage", () => strategy.setStorage(farmer2, { from: farmer2 })],
        ["setIncentives", () => strategy.setIncentives(farmer2, { from: farmer2 })],
        ["toggleMerklOperator", () => strategy.toggleMerklOperator(farmer2, farmer2, { from: farmer2 })],
      ];
      try {
        for (let [name, call] of settings) {
          let message = await revertMessage(call(), "an outsider's " + name + " should revert");
          assert.include(message, notGovernance, name + " should reject an outsider");
        }
      } finally {
        // should one of them let the outsider through, its setting goes back before the tests below run with it: a
        // minStakeInterval of 12,960,000 blocks would put every later stake ~13M blocks away
        if ((await strategy.minStakeInterval()).toString() != "0") {
          await strategy.setMinStakeInterval(0, { from: governance });
        }
        if (!(await strategy.sell())) {
          await strategy.setSell(true, { from: governance });
        }
        if (await strategy.isRewardToken(weth)) {
          await strategy.removeRewardToken(weth, { from: governance });
        }
      }
      // nor can the live proxy be initialized again, with another vault or gauge (OpenZeppelin's initializer)
      let reinitializations = [
        ["initializeStrategy", () => strategy.initializeStrategy(addresses.Storage, farmer2, { from: farmer2 })],
        ["initializeBaseStrategy", () => strategy.initializeBaseStrategy(addresses.Storage, underlying.address, farmer2, gaugeAddress,
          aero, { from: farmer2 })],
      ];
      for (let [name, call] of reinitializations) {
        let message = await revertMessage(call(), "an outsider's " + name + " should revert");
        assert.include(message, "Initializable: contract is already initialized", name + " should be rejected");
      }

      // nothing changed: the stake, its deposit block and so its window, the strategy's settings; nothing reached the gauge
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
      assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(block));
      assert.equal((await strategy.lastStakeBlock()).toString(), String(block));
      let after = await strategy.penaltyWindow();
      assert.equal(after.minStakeBlocks.toString(), window.minStakeBlocks.toString());
      assert.equal(after.penaltyRate.toString(), window.penaltyRate.toString());
      assert.equal(after.windowEndBlock.toString(), String(block + 7));
      assert.equal(await strategy.pausedInvesting(), false);
      assert.equal(await strategy.sell(), true);
      assert.equal((await strategy.minStakeInterval()).toString(), "0");
      assert.equal(await strategy.governance(), governanceBefore);
      assert.equal(await strategy.incentives(), incentivesBefore);
      assert.equal((await strategy.vault()).toLowerCase(), vault.address.toLowerCase());
      assert.deepEqual((await strategy.rewardTokens()).map(token => token.toLowerCase()), [aero.toLowerCase()]);
      assert.equal((await strategy.rewardPool()).toLowerCase(), gaugeAddress.toLowerCase());
      for (let name of ["Deposit", "Withdraw", "EmissionsClaimed", "EarlyWithdrawPenalty", "EmergencyWithdraw"]) {
        let events = await gauge.getPastEvents(name, { filter: { _account: strategy.address }, fromBlock: block + 1, toBlock: "latest" });
        assert.equal(events.length, 0, "an outsider should not reach the gauge: " + name);
      }
    });

    it("Keeps the claimed AERO while selling is off, and still stakes", async function() {
      let message = await revertMessage(strategy.setSell(false, { from: farmer2 }), "only governance should switch selling off");
      assert.include(message, "Not governance");

      await strategy.setSell(false, { from: governance });
      try {
        assert.equal(await strategy.sell(), false);
        // pool tokens in the strategy besides the AERO it is about to claim: the USDC behind a little of farmer2's LP
        let [, usdcSent] = await burnLP(100);
        await usdcToken.transfer(strategy.address, usdcSent.toFixed(), { from: farmer2 });
        let held = await dollars(0, await usdcToken.balanceOf(strategy.address));
        let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let lpBefore = await unstakedLP();
        let newLP = await farmer2LP(10);
        let block = await claimThenStake(newLP);
        let notCollected = await strategyEvents(profitsNotCollected, block);
        assert.equal(notCollected.length, 1, "should report the profits as not collected");
        assert.equal(notCollected[0].args.sell, false);
        // no fee and no sale: the AERO the strategy had and claimed (with any AERO pool fees it collected) stays. The USDC is
        // compounded all the same: the zap buys AERO for it through the pool, and only that AERO goes into the pool with the
        // mint
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "should take no fee");
        let claimed = (await gaugeEvents("EmissionsClaimed", block))[0].args._rewardAmount.toString();
        Utils.assertBNGt(claimed, 0);
        let zap = await poolEvents("Swap", block, strategy.address);
        assert.equal(zap.length, 1, "the zap should buy AERO for the USDC");
        let bought = new BigNumber(zap[0].returnValues.amount0Out);
        let mints = await poolEvents("Mint", block, strategy.address);
        assert.equal(mints.length, 1, "should mint LP from the USDC");
        let mintedAero = new BigNumber(mints[0].returnValues.amount0);
        Utils.assertBNGte(bought, mintedAero);
        let aeroOut = await aeroToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
        assert.equal(aeroOut.length, 1, "no AERO should leave the strategy but the AERO the zap bought, into the mint");
        assert.equal(aeroOut[0].args.to.toLowerCase(), underlying.address.toLowerCase());
        Utils.assertBNEq(aeroOut[0].args.value.toString(), mintedAero);
        let feeAero = (await feeClaims(block)).reduce((total, claim) => total.plus(claim.returnValues.amount0), new BigNumber(0));
        Utils.assertBNEq(new BigNumber(await aeroToken.balanceOf(strategy.address)).minus(aeroBefore), bought.minus(mintedAero).plus(claimed).plus(feeAero));
        // LP is minted from the USDC and staked with the LP that was waiting
        let minted = await mintedLP(block);
        Utils.assertBNGt(minted, 0);
        Utils.assertBNEq((await gaugeEvents("Deposit", block))[0].args._amount.toString(), lpBefore.plus(newLP).plus(minted));
        let leftover = await dollars(bought.minus(mintedAero), await usdcToken.balanceOf(strategy.address));
        console.log("USDC held ($, USDC 6 decimals): ", held.toFixed(), " compounded into LP worth: ", (await lpDollars(minted)).toFixed(),
          " left over: ", leftover.toFixed());
        Utils.assertBNGt(held, leftover.times(100)); // leftover below 1%
      } finally {
        await strategy.setSell(true, { from: governance });
      }

      // selling is back on: the next hard work sells the kept AERO along with its claim, and compounds it
      assert.equal(await strategy.sell(), true);
      let kept = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let lpBefore = await unstakedLP();
      let newLP = await farmer2LP(10);
      let block = await claimThenStake(newLP);
      let profits = await strategyEvents(profitLogInReward, block);
      assert.equal(profits.length, 1, "should take the fee again");
      let claimed = (await gaugeEvents("EmissionsClaimed", block))[0].args._rewardAmount.toString();
      Utils.assertBNGte(profits[0].args.profitAmount.toString(), kept.plus(claimed));
      Utils.assertBNGt((await gaugeEvents("Deposit", block))[0].args._amount.toString(), lpBefore.plus(newLP));
    });

    it("Sells an added reward token into AERO, and keeps compounding AERO while that token cannot be sold", async function() {
      // only governance manages the list, which never takes the underlying or a token twice
      let message = await revertMessage(strategy.addRewardToken(weth, { from: farmer2 }), "only governance should add a reward token");
      assert.include(message, "Not governance");
      message = await revertMessage(strategy.addRewardToken(underlying.address, { from: governance }), "the underlying should be rejected");
      assert.include(message, "Invalid reward token");
      message = await revertMessage(strategy.addRewardToken(aero, { from: governance }), "AERO is already a reward token");
      assert.include(message, "Invalid reward token");

      // the reward tokens, lowercased
      async function rewardTokens() {
        return (await strategy.rewardTokens()).map(token => token.toLowerCase());
      }

      let tx = await strategy.addRewardToken(weth, { from: governance });
      try {
        let added = await strategyEvents("RewardTokenAdded", tx.receipt.blockNumber);
        assert.equal(added.length, 1);
        assert.equal(added[0].args.token.toLowerCase(), weth);
        assert.deepEqual(await rewardTokens(), [aero.toLowerCase(), weth]);
        message = await revertMessage(strategy.addRewardToken(weth, { from: governance }), "a token should not be added twice");
        assert.include(message, "Invalid reward token");

        // WETH reaches the strategy, but the liquidator has no route from WETH to AERO yet: only that swap fails ...
        let amount = "10000000000000000"; // 0.01 WETH
        await sendWETH(amount);
        let lpBefore = await unstakedLP();
        let newLP = await farmer2LP(10);
        let block = await claimThenStake(newLP);
        let failures = await strategyEvents("LiquidationFailed", block);
        assert.equal(failures.length, 1, "only the WETH swap should fail");
        assert.equal(failures[0].args.reason, web3.eth.abi.encodeFunctionSignature("PathsNotExist()"), "the liquidator's own error");
        Utils.assertBNEq(await wethToken.balanceOf(strategy.address), amount);
        Utils.assertBNEq(await wethToken.allowance(strategy.address, await controller.universalLiquidator()), 0);
        // ... and the AERO is still sold and compounded
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "the AERO should still be sold");
        Utils.assertBNGt((await gaugeEvents("Deposit", block))[0].args._amount.toString(), lpBefore.plus(newLP));

        // with a route on the Aero V2 dex (WETH -> USDC, then USDC -> AERO through this vault's own pool), the next hard
        // work sells it into AERO before selling the AERO. The registry cannot remove a path: this one stays set for the
        // rest of the hardhat process, so also for any test file run after this one in the same process
        await universalLiquidatorRegistry.setPath(web3.utils.keccak256("aero"), [weth, usdc, aero], { from: addresses.ULOwner });
        block = await claimThenStake(await farmer2LP(10));
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
        let wethOut = await wethToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
        assert.equal(wethOut.length, 1, "should sell the WETH");
        Utils.assertBNEq(wethOut[0].args.value.toString(), amount);
        Utils.assertBNEq(await wethToken.balanceOf(strategy.address), 0);
        // the AERO it bought, paid by the AERO/USDC pool (this vault's own pool) to the liquidator's dex, is compounded along
        // with the claim; the dex's other swap through this pool sells AERO, and the zap is the strategy's own
        let bought = (await poolEvents("Swap", block, aeroV2Dex)).filter(swap => swap.returnValues.amount0Out != "0");
        assert.equal(bought.length, 1, "the WETH should buy AERO");
        assert.equal(bought[0].returnValues.to.toLowerCase(), strategy.address.toLowerCase());
        console.log("AERO bought with 0.01 WETH: ", bought[0].returnValues.amount0Out);
        let claimed = (await gaugeEvents("EmissionsClaimed", block))[0].args._rewardAmount.toString();
        let profits = await strategyEvents(profitLogInReward, block);
        assert.equal(profits.length, 1);
        Utils.assertBNGte(profits[0].args.profitAmount.toString(), new BigNumber(bought[0].returnValues.amount0Out).plus(claimed));

        // with no WETH left, the next hard work (after the window, so that it claims) does not try to sell any
        await advanceToBlock(block + 7);
        block = await doHardWork();
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0, "should skip a reward token it holds none of");
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "should sell the AERO");

        // removing: never AERO, only a token in the list, only by governance
        message = await revertMessage(strategy.removeRewardToken(aero, { from: governance }), "AERO should not be removed");
        assert.include(message, "Invalid reward token");
        message = await revertMessage(strategy.removeRewardToken(usdc, { from: governance }), "a token not in the list should be rejected");
        assert.include(message, "Invalid reward token");
        message = await revertMessage(strategy.removeRewardToken(weth, { from: farmer2 }), "only governance should remove a reward token");
        assert.include(message, "Not governance");
        tx = await strategy.removeRewardToken(weth, { from: governance });
        let removed = await strategyEvents("RewardTokenRemoved", tx.receipt.blockNumber);
        assert.equal(removed.length, 1);
        assert.equal(removed[0].args.token.toLowerCase(), weth);
        assert.deepEqual(await rewardTokens(), [aero.toLowerCase()]);
      } finally {
        if (await strategy.isRewardToken(weth)) {
          await strategy.removeRewardToken(weth, { from: governance });
        }
      }
    });

    it("Removes any extra reward token, keeping the others in their order", async function() {
      // three extra reward tokens (Base ERC20s; no hard work runs while they are listed): WETH, cbBTC, DAI
      let cbbtc = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
      let dai = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
      let extra = [weth.toLowerCase(), cbbtc, dai];
      async function rewardTokens() {
        return (await strategy.rewardTokens()).map(token => token.toLowerCase());
      }
      async function remove(token, expected) {
        let tx = await strategy.removeRewardToken(token, { from: governance });
        let removed = await strategyEvents("RewardTokenRemoved", tx.receipt.blockNumber);
        assert.equal(removed.length, 1);
        assert.equal(removed[0].args.token.toLowerCase(), token);
        assert.deepEqual(await rewardTokens(), expected);
        assert.equal(await strategy.isRewardToken(token), false);
      }

      assert.deepEqual(await rewardTokens(), [aero.toLowerCase()]);
      try {
        for (let token of extra) {
          await strategy.addRewardToken(token, { from: governance });
        }
        assert.deepEqual(await rewardTokens(), [aero.toLowerCase()].concat(extra));
        // from the middle: the tokens after it move up, in their order
        await remove(cbbtc, [aero.toLowerCase(), weth.toLowerCase(), dai]);
        await strategy.addRewardToken(cbbtc, { from: governance });
        assert.deepEqual(await rewardTokens(), [aero.toLowerCase(), weth.toLowerCase(), dai, cbbtc]);
        // the first extra token, then the last
        await remove(weth.toLowerCase(), [aero.toLowerCase(), dai, cbbtc]);
        await remove(cbbtc, [aero.toLowerCase(), dai]);
        await remove(dai, [aero.toLowerCase()]);
      } finally {
        for (let token of extra) {
          if (await strategy.isRewardToken(token)) {
            await strategy.removeRewardToken(token, { from: governance });
          }
        }
      }
      assert.deepEqual(await rewardTokens(), [aero.toLowerCase()]);
    });

    it("Salvages a token sent to it by mistake, but never the underlying or AERO, and only for governance", async function() {
      assert.equal(await strategy.unsalvagableTokens(underlying.address), true);
      assert.equal(await strategy.unsalvagableTokens(aero), true);
      assert.equal(await strategy.unsalvagableTokens(weth), false);
      for (let token of [underlying.address, aero]) {
        let message = await revertMessage(strategy.salvage(governance, token, 1, { from: governance }), "the underlying and AERO should never be salvaged");
        assert.include(message, "Token is non-salvageable");
      }

      let amount = "1000000000000000"; // 0.001 WETH
      await sendWETH(amount);
      let message = await revertMessage(strategy.salvage(farmer2, weth, amount, { from: farmer2 }), "only governance or the controller should salvage");
      assert.include(message, "The caller must be controller or governance");
      let strategyBefore = new BigNumber(await wethToken.balanceOf(strategy.address));
      let governanceBefore = new BigNumber(await wethToken.balanceOf(governance));
      await strategy.salvage(governance, weth, amount, { from: governance });
      Utils.assertBNEq(new BigNumber(await wethToken.balanceOf(governance)).minus(governanceBefore), amount);
      Utils.assertBNEq(await wethToken.balanceOf(strategy.address), strategyBefore.minus(amount));
    });

    it("Accepts a stakeSpacing from 1 to 1000 windows, from governance only", async function() {
      for (let invalid of [0, 1001]) {
        let message = await revertMessage(strategy.setStakeSpacing(invalid, { from: governance }), "a stakeSpacing out of range should be rejected");
        assert.include(message, "Invalid stake spacing");
      }
      let message = await revertMessage(strategy.setStakeSpacing(5, { from: farmer2 }), "only governance should set stakeSpacing");
      assert.include(message, "Not governance");
      assert.equal((await strategy.stakeSpacing()).toString(), "10", "rejected values should change nothing");

      try {
        for (let valid of [1, 1000]) {
          let tx = await strategy.setStakeSpacing(valid, { from: governance });
          let changed = await strategyEvents("StakeSpacingChanged", tx.receipt.blockNumber);
          assert.equal(changed.length, 1);
          assert.equal(changed[0].args.stakeSpacing.toString(), String(valid));
          assert.equal((await strategy.stakeSpacing()).toString(), String(valid));
        }
      } finally {
        await strategy.setStakeSpacing(10, { from: governance });
      }
    });

    it("Moves the stake only to a gauge of the same pool, even inside a window, and collects AERO deferred in the old gauge", async function() {
      let message = await revertMessage(strategy.setGauge(otherGaugeAddress, { from: governance }), "a gauge of another pool should be rejected");
      assert.include(message, "Underlying mismatch");
      message = await revertMessage(strategy.setGauge(gaugeAddress, { from: farmer2 }), "only governance should set the gauge");
      assert.include(message, "Not governance");

      // Aero has one gauge per pool, so the pool's own gauge stands in for the new one. The move unstakes everything
      // from the old gauge without waiting for the window (no exit does): it forfeits what the stake earned inside it
      let block = await claimThenStake(await farmer2LP(10));
      assert.equal((await strategy.penaltyWindow()).inWindow, true, "should be inside the window");
      let idle = new BigNumber(await underlying.balanceOf(strategy.address));
      let before = await gaugeCheckpoint();
      let tx = await strategy.setGauge(gaugeAddress, { from: governance });
      let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
      assert.equal(withdrawn.length, 1, "should unstake from the old gauge");
      Utils.assertBNEq(withdrawn[0].args._amount.toString(), before.balance);
      let penalties = await gaugeEvents("EarlyWithdrawPenalty", tx.receipt.blockNumber);
      assert.equal(penalties.length, 1, "should forfeit inside the window");
      Utils.assertBNEq(penalties[0].args._penalty.toString(), (await accruedSince(before)).plus(before.rewards));
      let changed = await strategyEvents("GaugeChanged", tx.receipt.blockNumber);
      assert.equal(changed.length, 1);
      assert.equal(changed[0].args.oldGauge.toLowerCase(), gaugeAddress.toLowerCase());
      assert.equal(changed[0].args.newGauge.toLowerCase(), gaugeAddress.toLowerCase());
      assert.equal((await strategy.rewardPool()).toLowerCase(), gaugeAddress.toLowerCase());
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), idle.plus(before.balance));
      let window = await strategy.penaltyWindow();
      assert.equal(window.windowEndBlock.toString(), "0", "nothing staked: no window");
      assert.equal(window.inWindow, false);

      // the next hard work stakes into the new gauge: with nothing staked there is no window or stakeSpacing to wait for
      let next = await doHardWork();
      assert.isBelow(next, block + 7, "should run inside the old window");
      let deposits = await gaugeEvents("Deposit", next);
      assert.equal(deposits.length, 1, "should stake into the new gauge");
      Utils.assertBNGte(deposits[0].args._amount.toString(), idle.plus(before.balance));
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      assert.equal((await strategy.penaltyWindow()).windowEndBlock.toString(), String(next + 7));

      // AERO the old gauge deferred (minting paused at the last withdrawal), with nothing staked in it any more: the move
      // collects it, since no later claim from that gauge would
      await advanceToBlock(next + 7);
      await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
      try {
        await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice }); // outside the window: its AERO is deferred
      } finally {
        await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
      }
      let deferred = new BigNumber(await gauge.deferredEmissions(strategy.address));
      Utils.assertBNGt(deferred, 0);
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      tx = await strategy.setGauge(gaugeAddress, { from: governance });
      let collected = await gaugeEvents("DeferredEmissionsClaimed", tx.receipt.blockNumber);
      assert.equal(collected.length, 1, "should collect the deferred AERO from the old gauge");
      Utils.assertBNEq(collected[0].args._amount.toString(), deferred);
      Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), 0);
      assert.equal((await strategyEvents("GaugeChanged", tx.receipt.blockNumber)).length, 1);

      next = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake everything again");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Moves to a second gauge of the pool, collecting the AERO deferred in the old one, then stakes there, and back", async function() {
      // Aero links one gauge to a pool (GaugeManager), but a gauge factory only checks that the GaugeManager calls it
      // (GaugeFactory.createGauge) and keys its gauges by pool alone: as the GaugeManager, the stable gauges' factory deploys
      // a second gauge for this pool. The LeafVoter does not know it (settleGauge returns 0), so it pays no AERO.
      // The second gauge stays deployed for the rest of the hardhat process (the tests below reuse it): a second
      // createGauge for this pool would revert, since the factory deploys it with CREATE2 at the same address
      let otherFactory = new web3.eth.Contract(gaugeFactoryGovernanceAbi, otherGaugeFactoryAddress);
      assert.equal((await otherFactory.methods.GAUGE_MANAGER().call()).toLowerCase(), gaugeManagerAddress.toLowerCase());
      secondGaugeAddress = await otherFactory.methods.computeGaugeAddress(underlying.address).call();
      assert.equal(await web3.eth.getCode(secondGaugeAddress), "0x", "the pool should have no second gauge yet");
      let gaugeManagerEth = await web3.eth.getBalance(gaugeManagerAddress);
      await impersonates([gaugeManagerAddress]);
      await hre.network.provider.send("hardhat_setBalance", [gaugeManagerAddress, "0x8AC7230489E80000"]); // gas for its call
      try {
        await otherFactory.methods.createGauge(underlying.address, "0x").send({ from: gaugeManagerAddress });
      } finally {
        await hre.network.provider.send("hardhat_setBalance", [gaugeManagerAddress, web3.utils.toHex(gaugeManagerEth)]);
        await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [gaugeManagerAddress] });
      }
      let secondGauge = await IAeroV2Gauge.at(secondGaugeAddress);
      assert.notEqual(secondGaugeAddress.toLowerCase(), gaugeAddress.toLowerCase());
      assert.equal((await secondGauge.stakingToken()).toLowerCase(), underlying.address.toLowerCase());
      assert.equal((await secondGauge.gaugeFactory()).toLowerCase(), otherGaugeFactoryAddress.toLowerCase());
      Utils.assertBNGt(await (await IAeroV2GaugeFactory.at(otherGaugeFactoryAddress)).emissionCap(secondGaugeAddress), 0);

      // events the second gauge emitted for the strategy in `block`
      async function secondGaugeEvents(name, block) {
        return await secondGauge.getPastEvents(name, { filter: { _account: strategy.address }, fromBlock: block, toBlock: block });
      }

      // AERO deferred in the old gauge, with nothing staked in it any more: minting paused at the last withdrawal, which
      // came after the window, so that the AERO was deferred and not forfeited
      await advanceToBlock(Number((await gauge.depositBlock(strategy.address)).toString()) + 7);
      await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
      try {
        await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      } finally {
        await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
      }
      let deferred = new BigNumber(await gauge.deferredEmissions(strategy.address));
      Utils.assertBNGt(deferred, 0);
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);

      try {
        // the move collects that AERO from the old gauge, since no later claim from it would
        let tx = await strategy.setGauge(secondGaugeAddress, { from: governance });
        let changed = await strategyEvents("GaugeChanged", tx.receipt.blockNumber);
        assert.equal(changed.length, 1);
        assert.equal(changed[0].args.oldGauge.toLowerCase(), gaugeAddress.toLowerCase());
        assert.equal(changed[0].args.newGauge.toLowerCase(), secondGaugeAddress.toLowerCase());
        assert.equal((await strategy.rewardPool()).toLowerCase(), secondGaugeAddress.toLowerCase());
        let collected = await gaugeEvents("DeferredEmissionsClaimed", tx.receipt.blockNumber);
        assert.equal(collected.length, 1, "should collect the deferred AERO from the old gauge");
        Utils.assertBNEq(collected[0].args._amount.toString(), deferred);
        Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), 0);

        // the next hard work stakes everything into the second gauge, nothing into the old one
        let lpBefore = await unstakedLP();
        let block = await doHardWork();
        assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake into the old gauge");
        let deposits = await secondGaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake into the second gauge");
        Utils.assertBNGte(deposits[0].args._amount.toString(), lpBefore);
        let staked = new BigNumber(await secondGauge.balanceOf(strategy.address));
        Utils.assertBNEq(staked, deposits[0].args._amount.toString());
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        Utils.assertBNEq(await strategy.investedUnderlyingBalance(), staked);

        // and back to the pool's own gauge: the move unstakes everything from the second one
        tx = await strategy.setGauge(gaugeAddress, { from: governance });
        let withdrawn = await secondGaugeEvents("Withdraw", tx.receipt.blockNumber);
        assert.equal(withdrawn.length, 1, "should unstake from the second gauge");
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
        changed = await strategyEvents("GaugeChanged", tx.receipt.blockNumber);
        assert.equal(changed.length, 1);
        assert.equal(changed[0].args.oldGauge.toLowerCase(), secondGaugeAddress.toLowerCase());
        assert.equal(changed[0].args.newGauge.toLowerCase(), gaugeAddress.toLowerCase());
        assert.equal((await strategy.rewardPool()).toLowerCase(), gaugeAddress.toLowerCase());
        Utils.assertBNEq(await secondGauge.balanceOf(strategy.address), 0);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), staked);
      } finally {
        if ((await strategy.rewardPool()).toLowerCase() != gaugeAddress.toLowerCase()) {
          await strategy.setGauge(gaugeAddress, { from: governance });
        }
      }

      // the next hard work stakes everything into the pool's own gauge again
      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake into the pool's own gauge again");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Never leaves its stake behind in an old gauge whose withdraw fails: the move reverts, and goes through after an emergency exit", async function() {
      // the pool's second gauge, deployed by the test above (a second createGauge for the pool would revert)
      assert.notEqual(await web3.eth.getCode(secondGaugeAddress), "0x");
      let secondGauge = await IAeroV2Gauge.at(secondGaugeAddress);
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);

      try {
        await withLeafVoterCode(revertingCode, async () => {
          // every withdraw from the old gauge reverts while its LeafVoter is broken. With emergencyWithdraw disabled or
          // enabled, the move reverts with the old gauge's own error: it neither abandons the stake in a gauge the
          // strategy would no longer track, nor forfeits its AERO through emergencyWithdraw
          try {
            for (let enabled of [false, true]) {
              await gaugeFactory.setEmergencyWithdrawEnabled(enabled, { from: emergencyWithdrawAdmin });
              let message = await revertMessage(strategy.setGauge(secondGaugeAddress, { from: governance }),
                "the move should revert while the old gauge's withdraw fails (emergencyWithdraw enabled: " + enabled + ")");
              assert.include(message, revertData("0xdeadbeef"), "the move should revert with the old gauge's own error");
              assert.equal((await strategy.rewardPool()).toLowerCase(), gaugeAddress.toLowerCase(), "the gauge should not change");
              Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
              Utils.assertBNEq(await secondGauge.balanceOf(strategy.address), 0);
            }

            // the way out: an emergency exit, which leaves through emergencyWithdraw (enabled); the move then goes through
            // with nothing staked in the old gauge, whose failing claim does not block it
            let tx = await strategy.emergencyExit({ from: governance });
            let exits = await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber);
            assert.equal(exits.length, 1, "the emergency exit should leave through emergencyWithdraw");
            Utils.assertBNEq(exits[0].args._amount.toString(), staked);
            assert.equal(await strategy.pausedInvesting(), true);
            tx = await strategy.setGauge(secondGaugeAddress, { from: governance });
            let changed = await strategyEvents("GaugeChanged", tx.receipt.blockNumber);
            assert.equal(changed.length, 1);
            assert.equal(changed[0].args.oldGauge.toLowerCase(), gaugeAddress.toLowerCase());
            assert.equal(changed[0].args.newGauge.toLowerCase(), secondGaugeAddress.toLowerCase());
            assert.equal((await strategy.rewardPool()).toLowerCase(), secondGaugeAddress.toLowerCase());
          } finally {
            await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
          }
        });

        // with the LeafVoter back and investing resumed, the next hard work stakes everything into the new gauge at once
        await strategy.continueInvesting({ from: governance });
        let lp = await unstakedLP();
        let block = await doHardWork();
        let deposits = await secondGauge.getPastEvents("Deposit", { filter: { _account: strategy.address }, fromBlock: block, toBlock: block });
        assert.equal(deposits.length, 1, "should stake into the new gauge at once");
        Utils.assertBNGte(deposits[0].args._amount.toString(), lp);
        assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake into the old gauge");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      } finally {
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
        if ((await strategy.rewardPool()).toLowerCase() != gaugeAddress.toLowerCase()) {
          await strategy.setGauge(gaugeAddress, { from: governance });
        }
        // back in the pool's own gauge, a hard work stakes the LP there again: also after a failure above, which can leave
        // it idle since the emergency exit, so that the tests below find it staked
        if (new BigNumber(await underlying.balanceOf(strategy.address)).gt(0)) {
          await doHardWork();
        }
      }

      // everything staked in the pool's own gauge again
      Utils.assertBNGt(await gauge.balanceOf(strategy.address), 0);
      Utils.assertBNEq(await secondGauge.balanceOf(strategy.address), 0);
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Moves the stake although the old gauge's claim fails (minting paused), and leaves the AERO deferred there to be claimed later", async function() {
      // the pool's second gauge, deployed by the test that moves the stake to it
      assert.notEqual(await web3.eth.getCode(secondGaugeAddress), "0x", "the pool's second gauge should be deployed");
      let secondGauge = await IAeroV2Gauge.at(secondGaugeAddress);
      // outside the window, so that the move's withdraw from the old gauge defers the stake's AERO instead of forfeiting it
      await advanceToBlock(Number((await gauge.depositBlock(strategy.address)).toString()) + 7);
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), 0);

      try {
        // minting paused through the whole move: its withdraw defers the AERO (V2Gauge._withdraw), then its claim of that
        // AERO from the old gauge reverts, which must not block the move
        let tx;
        await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
        try {
          tx = await strategy.setGauge(secondGaugeAddress, { from: governance });
        } finally {
          await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
        }
        let changed = await strategyEvents("GaugeChanged", tx.receipt.blockNumber);
        assert.equal(changed.length, 1, "the move should go through");
        assert.equal(changed[0].args.newGauge.toLowerCase(), secondGaugeAddress.toLowerCase());
        assert.equal((await strategy.rewardPool()).toLowerCase(), secondGaugeAddress.toLowerCase());
        let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
        assert.equal(withdrawn.length, 1);
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        let deferredEvents = await gaugeEvents("EmissionsDeferred", tx.receipt.blockNumber);
        assert.equal(deferredEvents.length, 1, "the withdraw should defer the AERO");
        assert.equal((await gaugeEvents("DeferredEmissionsClaimed", tx.receipt.blockNumber)).length, 0, "the claim should have failed");
        // the failed claim left the deferred AERO as the withdraw recorded it
        let deferred = new BigNumber(await gauge.deferredEmissions(strategy.address));
        Utils.assertBNGt(deferred, 0);
        Utils.assertBNEq(deferred, deferredEvents[0].args._rewardAmount.toString());

        // the strategy stakes into the new gauge, and the AERO waits in the old one
        let block = await doHardWork();
        assert.equal((await secondGauge.getPastEvents("Deposit", { filter: { _account: strategy.address }, fromBlock: block, toBlock: block })).length, 1,
          "should stake into the new gauge");
        Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), deferred);
      } finally {
        if ((await strategy.rewardPool()).toLowerCase() != gaugeAddress.toLowerCase()) {
          await strategy.setGauge(gaugeAddress, { from: governance });
        }
      }

      // back in the old gauge, its next claim collects that AERO
      let deferred = new BigNumber(await gauge.deferredEmissions(strategy.address));
      let block = await doHardWork();
      let collected = await gaugeEvents("DeferredEmissionsClaimed", block);
      assert.equal(collected.length, 1, "the deferred AERO should be claimed later");
      Utils.assertBNEq(collected[0].args._amount.toString(), deferred);
      Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), 0);
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake into the pool's own gauge again");
    });

    it("Keeps its state and its window through an upgrade, which only governance can complete after the delay", async function() {
      let proxy = await StrategyProxy.at(strategy.address);
      let newImplementation = await Strategy.new();
      let message = await revertMessage(strategy.scheduleUpgrade(newImplementation.address, { from: farmer2 }), "only governance should schedule an upgrade");
      assert.include(message, "Not governance");
      await strategy.scheduleUpgrade(newImplementation.address, { from: governance });
      assert.equal(await strategy.nextImplementation(), newImplementation.address);
      message = await revertMessage(proxy.upgrade({ from: governance }), "the upgrade should wait for the delay");
      assert.include(message, "Upgrade not scheduled");
      await Utils.waitHours(13); // the controller's nextImplementationDelay is 12 hours

      // carried over: a stake inside its window, and a stakeSpacing and a minStakeInterval other than the defaults (an
      // interval of 30 blocks, shorter than the 84 blocks of stakeSpacing, changes no stake below)
      await strategy.setStakeSpacing(12, { from: governance });
      await strategy.setMinStakeInterval(30, { from: governance });
      try {
        let block = await claimThenStake(await farmer2LP(10));
        // finalizeUpgrade runs with the caller's address: an upgrade by anyone but governance reverts as a whole
        message = await revertMessage(proxy.upgrade({ from: farmer2 }), "only governance should complete the upgrade");
        assert.include(message, "Issue when finalizing the upgrade");

        // the strategy's storage, its stake and its window
        async function snapshot() {
          let window = await strategy.penaltyWindow();
          return {
            underlying: await strategy.underlying(),
            vault: await strategy.vault(),
            rewardPool: await strategy.rewardPool(),
            rewardTokens: (await strategy.rewardTokens()).join(),
            strategist: await strategy.strategist(),
            sell: await strategy.sell(),
            pausedInvesting: await strategy.pausedInvesting(),
            stakeSpacing: (await strategy.stakeSpacing()).toString(),
            minStakeInterval: (await strategy.minStakeInterval()).toString(),
            lastStakeBlock: (await strategy.lastStakeBlock()).toString(),
            staked: (await gauge.balanceOf(strategy.address)).toString(),
            invested: (await strategy.investedUnderlyingBalance()).toString(),
            window: [window.minStakeBlocks.toString(), window.penaltyRate.toString(), window.windowEndBlock.toString(), window.inWindow].join(),
          };
        }
        let before = await snapshot();
        assert.equal(before.window, ["7", "1000000", String(block + 7), true].join());
        assert.equal(before.minStakeInterval, "30");
        assert.equal(before.lastStakeBlock, String(block));
        await proxy.upgrade({ from: governance });
        assert.equal(await proxy.implementation(), newImplementation.address);
        assert.equal(await strategy.nextImplementation(), zeroAddress, "finalizeUpgrade should clear the schedule");
        assert.equal((await strategy.nextImplementationTimestamp()).toString(), "0");
        assert.deepEqual(await snapshot(), before);

        // the upgraded strategy follows the same rules: it skips inside the window, and stakes 12 windows after the last stake
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        let next = await doHardWork();
        assert.isBelow(next, block + 7, "should run inside the window");
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 1, "claim should be skipped");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1, "stake should be skipped");
        assert.equal(await nextStakeBlock(), block + 84);
        // where the default stakeSpacing (10 windows) would stake, it claims and still waits: it uses the stored 12
        await advanceToBlock(block + 69);
        next = await doHardWork();
        assert.equal(next, block + 70);
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim after the window");
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake at the default stakeSpacing");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
        next = await claimThenStake(await farmer2LP(10));
        assert.isAtLeast(next, block + 84);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      } finally {
        await strategy.setStakeSpacing(10, { from: governance });
        await strategy.setMinStakeInterval(0, { from: governance });
      }
    });
  });

  describe("Aero failures", function() {
    before(async function() {
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      await assertNoWindow();
      await Utils.advanceNBlock(10);
      await doHardWork(); // everything staked
    });

    it("Keeps working while Aero's minting is paused, and claims the deferred AERO later", async function() {
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      let paused = false;
      try {
        // past the window and the stakeSpacing of the before hook's stake, so only the failed claim can block a stake
        let nextStakeBlock = Number((await gauge.depositBlock(strategy.address)).toString())
          + Number((await strategy.stakeSpacing()).toString()) * 7;
        await advanceToBlock(nextStakeBlock);
        // and new LP to stake: little, so that farmer1's withdrawal below still reaches the gauge
        let newLP = new BigNumber(await underlying.balanceOf(farmer1)).div(100).integerValue(BigNumber.ROUND_DOWN);
        await depositVault(farmer1, underlying, vault, newLP.toFixed());
        await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
        paused = true;
        assert.equal((await strategy.penaltyWindow()).inWindow, false, "should be outside the window");

        let block = await doHardWork();
        assert.isAtLeast(block, nextStakeBlock, "should be past stakeSpacing, so only the failed claim can block the stake");
        assert.equal((await strategyEvents("ClaimFailed", block)).length, 1, "claim should fail without reverting");
        assert.equal((await strategyEvents("StakeSkipped", block)).length, 1, "no stake without a claim");
        assert.equal((await gaugeEvents("Deposit", block)).length, 0, "no stake without a claim");
        // the new LP waits, unstaked, in the strategy
        Utils.assertBNGt(await underlying.balanceOf(strategy.address), 0);

        // a withdrawal reaching the gauge still pays in full; its rewards are deferred, not lost
        let shares = new BigNumber(await vault.balanceOf(farmer1)).div(4).integerValue(BigNumber.ROUND_DOWN);
        let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
        let farmerBefore = new BigNumber(await underlying.balanceOf(farmer1));
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
        Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer1)).minus(farmerBefore), expected);
        assert.equal((await gaugeEvents("EmissionsDeferred", tx.receipt.blockNumber)).length, 1);
        Utils.assertBNGt(await gauge.deferredEmissions(strategy.address), 0);

        // so does withdrawAll (also used by rebalance and migration): claiming the deferred AERO fails, without reverting
        let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
        await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
        Utils.assertBNGt(await gauge.deferredEmissions(strategy.address), 0);

        await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
        paused = false;
        block = await doHardWork();
        assert.equal((await gaugeEvents("DeferredEmissionsClaimed", block)).length, 1, "deferred AERO should be claimed");
        Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), 0);
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "the LP should be staked again");
      } finally {
        if (paused) {
          await leafVoter.setChainStatus(1, { from: penaltyAdmin });
        }
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();
    });

    it("Never lets a broken liquidation route block claiming, staking or exits", async function() {
      await Utils.advanceNBlock(1800);
      let universalLiquidator = await controller.universalLiquidator();
      await controller.setUniversalLiquidator(farmer2, { from: governance }); // no code: every swap reverts
      try {
        // new LP for the hard work to stake
        let newLP = new BigNumber(await underlying.balanceOf(farmer1)).div(10).integerValue(BigNumber.ROUND_DOWN);
        await depositVault(farmer1, underlying, vault, newLP.toFixed());
        let block = await doHardWork();
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 1);
        let claimed = await gaugeEvents("EmissionsClaimed", block);
        assert.equal(claimed.length, 1, "should still claim");
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "a broken route should not block staking");
        // the liquidateRewards self-call reverts as a whole (its try/catch in doHardWork): no fee is taken and the AERO
        // stays in the strategy, not lost
        Utils.assertBNGte(await aeroToken.balanceOf(strategy.address), claimed[0].args._rewardAmount.toString());

        let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
        let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
        assert.equal((await strategyEvents("LiquidationFailed", tx.receipt.blockNumber)).length, 1);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
      } finally {
        await controller.setUniversalLiquidator(universalLiquidator, { from: governance });
      }

      // once the route is back, the AERO is sold and the LP staked again
      let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let block = await doHardWork();
      Utils.assertBNGt(aeroBefore, new BigNumber(await aeroToken.balanceOf(strategy.address)).times(100));
      assert.equal((await gaugeEvents("Deposit", block)).length, 1);
    });

    it("Reverts the hard work, claim included, when its liquidation fails Aero's gas check, while withdrawAll completes without it", async function() {
      // Aero's pool tape gas check (in every swap: PoolFactory.recordPoolTape) fails the swaps through this pool as if the
      // keeper had sent too little gas. Unlike a broken route (above), the hard work reverts with InsufficientGasForCall,
      // so that the keeper retries with more gas instead of claiming and leaving the AERO unsold
      await Utils.advanceNBlock(1800);
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      let before = await gaugeCheckpoint();
      let aero = new BigNumber(await aeroToken.balanceOf(strategy.address));
      await withPoolTapeFailing(poolFactory.address, async () => {
        let message = await revertMessage(controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice }),
          "the hard work should revert when its liquidation fails Aero's gas check");
        assert.include(message, revertData(insufficientGasError), "the hard work should revert with Aero's gas check error");
        Utils.assertBNEq(await gauge.userRewardPerTokenPaid(strategy.address), before.paid); // nothing claimed
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aero);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);

        // withdrawAll (also used by rebalance and migration) is never retried by a keeper: it goes on without the
        // liquidation, hands all the LP to the vault and keeps the claimed AERO for a later hard work
        let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
        let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
        let failures = await strategyEvents("LiquidationFailed", tx.receipt.blockNumber);
        assert.equal(failures.length, 1, "the liquidation should fail without reverting withdrawAll");
        assert.equal(failures[0].args.reason, insufficientGasError, "Aero's gas check error");
        let claimed = await gaugeEvents("EmissionsClaimed", tx.receipt.blockNumber);
        assert.equal(claimed.length, 1);
        Utils.assertBNGte(await aeroToken.balanceOf(strategy.address), aero.plus(claimed[0].args._rewardAmount.toString()));
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
      });

      // with Aero's gas limit back, the next hard work sells the AERO kept (the pool's AERO share goes into the LP) and
      // stakes everything
      let aeroKept = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "should sell the AERO kept");
      Utils.assertBNGt(aeroKept, new BigNumber(await aeroToken.balanceOf(strategy.address)).times(100));
      assert.equal((await gaugeEvents("Deposit", block)).length, 1);
    });

    it("Reverts the hard work when an added reward token's sale fails Aero's gas check", async function() {
      // alUSDb is sold into AERO through the stable USDC/alUSDb pool, then this vault's own pool: it fails Aero's gas check
      // while the stable pools' tape is raised, and the AERO sale and the zap, which only use this volatile pool, do not.
      // The test setup has no route for alUSDb: the dex gets the stable pair (unset on chain, restored below), and the
      // registry the path, which it cannot remove: it stays set for the rest of the hardhat process
      let stablePool = await IAeroV2Pool.at(stablePoolAddress);
      let dex = await IAeroV2Dex.at(aeroV2Dex);
      let stablePair = await dex.factory(usdc, alusdb);
      await dex.pairSetup(usdc, alusdb, stablePoolFactory, { from: addresses.ULOwner });
      try {
        await universalLiquidatorRegistry.setPath(web3.utils.keccak256("aero"), [alusdb, usdc, aero], { from: addresses.ULOwner });
        // farmer2 buys a little alUSDb with USDC through the stable pool (USDC is its token0), for the strategy
        let usdcIn = (await burnLP(1000))[1];
        let alusdbOut = (await stablePool.getAmountOutWithTotalFee(usdcIn.toFixed(), usdc, { from: farmer2 })).toString();
        await usdcToken.transfer(stablePoolAddress, usdcIn.toFixed(), { from: farmer2 });
        await stablePool.swap(0, alusdbOut, strategy.address, "0x", { from: farmer2, gasPrice: keeperGasPrice });
        let amount = new BigNumber(await alusdbToken.balanceOf(strategy.address));
        Utils.assertBNGt(amount, 0);
        await strategy.addRewardToken(alusdb, { from: governance });
        try {
          await Utils.advanceNBlock(600); // AERO to claim and sell too
          await withPoolTapeFailing(stablePoolFactory, async () => {
            let message = await revertMessage(controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice }),
              "the hard work should revert when the reward token's sale fails Aero's gas check");
            assert.include(message, revertData(insufficientGasError), "the hard work should revert with Aero's gas check error");
            Utils.assertBNEq(await alusdbToken.balanceOf(strategy.address), amount);
          });

          // with Aero's gas limit back, the hard work sells the alUSDb into AERO, the AERO into the pool, and stakes
          let block = await doHardWork();
          assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
          let sold = await alusdbToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
          assert.equal(sold.length, 1, "should sell the alUSDb");
          Utils.assertBNEq(sold[0].args.value.toString(), amount);
          assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "should sell the AERO");
          assert.equal((await gaugeEvents("Deposit", block)).length, 1);
        } finally {
          if (await strategy.isRewardToken(alusdb)) {
            await strategy.removeRewardToken(alusdb, { from: governance });
          }
        }
      } finally {
        await dex.pairSetup(usdc, alusdb, stablePair, { from: addresses.ULOwner });
      }
    });

    it("Takes the fee on AERO just above the dust threshold, but never swaps or mints with what the fee leaves", async function() {
      // AERO in [MIN_REWARD, MIN_REWARD / (1 - f)), f the share the RewardForwarder pulls as fees (profit sharing and
      // platform; notifyFee ignores the strategist fee): enough for the fee (the MIN_REWARD check before
      // _notifyProfitInRewardToken), dust after it (the MIN_REWARD check before _swapRewardIntoPoolTokens)
      let minReward = new BigNumber("10000000000000"); // AerodromeV2Strategy MIN_REWARD (1e13)
      let denominator = new BigNumber(await controller.feeDenominator());
      let profitSharing = new BigNumber(await controller.profitSharingNumerator());
      let platform = new BigNumber(await controller.platformFeeNumerator());
      let feeOf = (amount) => amount.times(profitSharing).idiv(denominator).plus(amount.times(platform).idiv(denominator));
      let amount = minReward.plus(minReward.times(denominator).idiv(denominator.minus(profitSharing).minus(platform))).idiv(2);
      console.log("fee numerators (profit sharing, platform, strategist) and denominator: ", profitSharing.toFixed(), platform.toFixed(),
        (await controller.strategistFeeNumerator()).toString(), denominator.toFixed(), " AERO sent: ", amount.toFixed());
      Utils.assertBNGt(feeOf(amount), 0);
      Utils.assertBNGt(minReward, amount.minus(feeOf(amount))); // what the fee leaves is dust

      // nothing staked, so the hard work below claims nothing
      await Utils.advanceNBlock(600);
      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });

      // volatile pool only: AERO is a pool token, so the strategy may keep some AERO or USDC left over from the pool ratio,
      // and is owed pool fees from its sale in that withdrawAll. As the strategy, the test claims those fees and moves all
      // its AERO and USDC aside (they go back at the end), so that it holds exactly the AERO sent below (from farmer2, which
      // got AERO from the LP it burned) and no other pool token
      let asideHolder = accounts[8];
      let strategyEth = await web3.eth.getBalance(strategy.address);
      let aeroAside = new BigNumber(0);
      let usdcAside = new BigNumber(0);
      await impersonates([strategy.address]);
      await hre.network.provider.send("hardhat_setBalance", [strategy.address, "0x8AC7230489E80000"]); // gas for its calls
      try {
        await poolFeeAccounting.methods.claimFees(strategy.address).send({ from: strategy.address });
        aeroAside = new BigNumber(await aeroToken.balanceOf(strategy.address));
        await aeroToken.transfer(asideHolder, aeroAside.toFixed(), { from: strategy.address });
        usdcAside = new BigNumber(await usdcToken.balanceOf(strategy.address));
        if (usdcAside.gt(0)) {
          await usdcToken.transfer(asideHolder, usdcAside.toFixed(), { from: strategy.address });
        }
      } finally {
        await hre.network.provider.send("hardhat_setBalance", [strategy.address, web3.utils.toHex(strategyEth)]);
        await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [strategy.address] });
      }
      try {
        let pending = await pendingFees();
        Utils.assertBNEq(new BigNumber(pending.amount0).plus(pending.amount1), 0);
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
        Utils.assertBNEq(await usdcToken.balanceOf(strategy.address), 0);
        Utils.assertBNGte(await aeroToken.balanceOf(farmer2), amount);
        await aeroToken.transfer(strategy.address, amount.toFixed(), { from: farmer2 });
        let lpBefore = await unstakedLP();
        let dust = amount.minus(feeOf(amount));
        // for the second hard work below: USDC from a little of farmer2's LP, and a 7-block window, which the stake of the
        // first one opens, so that the second one runs inside it, without a claim
        let usdcIn = (await burnLP(1000))[1];
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
        try {
          // the hard work takes the fee on that AERO, and keeps the rest: with no other pool token in the strategy there is
          // nothing to zap, and the dust is neither swapped nor minted
          let block = await doHardWork();
          assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 0, "nothing staked: nothing to claim");
          assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
          let profits = await strategyEvents(profitLogInReward, block);
          assert.equal(profits.length, 1, "should take the fee");
          Utils.assertBNEq(profits[0].args.profitAmount.toString(), amount);
          // the fee is the only AERO that leaves the strategy
          let aeroOut = await aeroToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
          assert.equal(aeroOut.length, 1, "only the fee should leave the strategy, no AERO should be swapped or minted");
          assert.equal(aeroOut[0].args.to.toLowerCase(), (await controller.rewardForwarder()).toLowerCase());
          Utils.assertBNEq(aeroOut[0].args.value.toString(), feeOf(amount));
          assert.equal((await poolEvents("Swap", block, strategy.address)).length, 0, "the dust should not be swapped");
          assert.equal((await poolEvents("Mint", block, strategy.address)).length, 0, "the dust should not be minted");
          Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), dust);
          // the stake is the LP that was already waiting in the vault and the strategy
          let deposits = await gaugeEvents("Deposit", block);
          assert.equal(deposits.length, 1, "should stake");
          Utils.assertBNEq(deposits[0].args._amount.toString(), lpBefore);

          // the next hard work, inside the window that stake opened, claims nothing: the strategy holds the dust alone, and
          // the USDC farmer2 sends. It takes no fee on the dust and keeps it out of the zap: the zap buys AERO for the USDC
          // through the pool, and only that AERO goes into the pool with the mint
          await usdcToken.transfer(strategy.address, usdcIn.toFixed(), { from: farmer2 });
          let idleBefore = new BigNumber(await underlying.balanceOf(strategy.address));
          let next = await doHardWork();
          assert.isBelow(next, block + 7, "should run inside the window");
          assert.equal((await strategyEvents("ClaimSkipped", next)).length, 1, "the claim should wait for the window");
          assert.equal((await strategyEvents(profitLogInReward, next)).length, 0, "should take no fee on dust");
          assert.equal((await strategyEvents("LiquidationFailed", next)).length, 0);
          let zap = await poolEvents("Swap", next, strategy.address);
          assert.equal(zap.length, 1, "the zap should buy AERO for the USDC through the pool");
          Utils.assertBNGt(zap[0].returnValues.amount1In, 0);
          Utils.assertBNEq(zap[0].returnValues.amount0In, 0);
          let bought = new BigNumber(zap[0].returnValues.amount0Out);
          let mints = await poolEvents("Mint", next, strategy.address);
          assert.equal(mints.length, 1, "should mint LP from the USDC");
          let mintedAero = new BigNumber(mints[0].returnValues.amount0);
          console.log("AERO dust kept: ", dust.toFixed(), " AERO the zap bought: ", bought.toFixed(), " minted: ", mintedAero.toFixed());
          Utils.assertBNGt(mintedAero, 0);
          Utils.assertBNGte(bought, mintedAero); // only AERO the zap bought goes into the pool
          aeroOut = await aeroToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: next, toBlock: next });
          assert.equal(aeroOut.length, 1, "no AERO should leave the strategy but the AERO the zap bought, into the mint");
          assert.equal(aeroOut[0].args.to.toLowerCase(), underlying.address.toLowerCase());
          Utils.assertBNEq(aeroOut[0].args.value.toString(), mintedAero);
          Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), dust.plus(bought).minus(mintedAero));
          // the new LP waits for the window to pass
          let minted = await mintedLP(next);
          Utils.assertBNGt(minted, 0);
          assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
          Utils.assertBNEq(await underlying.balanceOf(strategy.address), idleBefore.plus(minted));
        } finally {
          await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
        }
      } finally {
        // the AERO and USDC moved aside go back to the strategy
        await aeroToken.transfer(strategy.address, aeroAside.toFixed(), { from: asideHolder });
        if (usdcAside.gt(0)) {
          await usdcToken.transfer(strategy.address, usdcAside.toFixed(), { from: asideHolder });
        }
      }
      await assertNoWindow();
    });

    it("Falls back to emergencyWithdraw only in an emergency exit, when the gauge withdraw is broken and Aero enabled it", async function() {
      // every gauge withdraw reverts while Aero's LeafVoter is broken: every call to it reverts with 0xdeadbeef
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(stakedBefore, 0);
      let shares = new BigNumber(await vault.balanceOf(farmer1)).div(4).integerValue(BigNumber.ROUND_DOWN);
      try {
        await withLeafVoterCode(revertingCode, async () => {
          // emergencyWithdraw disabled: emergencyExit still pauses without reverting, and reports the gauge's error; a
          // user withdrawal reaching the gauge reverts with it
          let tx = await strategy.emergencyExit({ from: governance });
          let exitFailures = await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber);
          assert.equal(exitFailures.length, 1);
          assert.equal(exitFailures[0].args.reason, "0xdeadbeef", "the gauge's own revert data");
          assert.equal(await strategy.pausedInvesting(), true, "investing should be paused");
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
          await strategy.continueInvesting({ from: governance });
          let message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }), "withdrawal should revert while the gauge is broken");
          assert.include(message, revertData("0xdeadbeef"), "the withdrawal should revert with the gauge's own error");

          // Aero enables emergencyWithdraw on the gauge's factory: a user withdrawal still reverts with the gauge's own
          // error, since leaving through emergencyWithdraw forfeits the stake's unclaimed AERO: governance's call ...
          await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
          message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }), "withdrawal should revert, not fall back to emergencyWithdraw");
          assert.include(message, revertData("0xdeadbeef"), "the withdrawal should revert with the gauge's own error");
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);

          // ... through emergencyExit, which falls back to it
          tx = await strategy.emergencyExit({ from: governance });
          let exits = await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber);
          assert.equal(exits.length, 1, "emergencyExit should fall back to emergencyWithdraw");
          Utils.assertBNEq(exits[0].args._amount.toString(), stakedBefore);
          assert.equal((await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber)).length, 0);
          assert.equal(await strategy.pausedInvesting(), true, "investing should be paused");
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
          assert.equal((await strategy.lastStakeBlock()).toString(), "0");

          // users are paid in full again, from the LP now idle in the strategy
          let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
          let farmerBefore = new BigNumber(await underlying.balanceOf(farmer1));
          tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
          Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer1)).minus(farmerBefore), expected);
          assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 0);
        });
      } finally {
        // restore Aero (the LeafVoter's code is back) and investing
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }
    });

    it("Never mistakes a gas failure for an Aero failure", async function() {
      await doHardWork(); // stake again
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(stakedBefore, 0);

      // emergencyWithdraw is available, but every gauge call now fails Aero's gas check (InsufficientGasForCall),
      // exactly like a call sent with too little gas: that must be re-raised, never routed to emergencyWithdraw
      let gaugeTape = await gaugeFactory.gaugeTape();
      let gaugeTapeGasLimit = await gaugeFactory.gaugeTapeGasLimit();
      assert.notEqual(gaugeTape, zeroAddress, "the gas check only runs with a gauge tape");
      try {
        await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
        await gaugeFactory.setGaugeTape(gaugeTape, "4000000000", { from: penaltyAdmin });

        // user exits call the gauge with no gas floor of their own: they revert with the gauge's InsufficientGasForCall
        let insufficientGas = revertData(insufficientGasError);
        let shares = new BigNumber(await vault.balanceOf(farmer1)).div(4).integerValue(BigNumber.ROUND_DOWN);
        let message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }),
          "withdrawal should revert, not fall back to emergencyWithdraw");
        assert.include(message, insufficientGas, "the withdrawal should revert with Aero's gas check error");
        message = await revertMessage(vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice }),
          "withdrawAll should revert, not fall back to emergencyWithdraw");
        assert.include(message, insufficientGas, "withdrawAll should revert with Aero's gas check error");
        // the emergency exit's floor (gaugeTapeGasLimit + 1,200,000 gas left) is out of reach: it reverts before the gauge
        message = await revertMessage(strategy.emergencyExit({ from: governance }), "emergencyExit should revert, not silently keep the stake");
        assert.include(message, "Not enough gas for the gauge", "emergencyExit should revert before calling the gauge");
        assert.equal(await strategy.pausedInvesting(), false);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);

        // with the gas limit restored, the same withdrawal uses the normal withdraw although emergencyWithdraw is enabled
        await gaugeFactory.setGaugeTape(gaugeTape, gaugeTapeGasLimit, { from: penaltyAdmin });
        assert.equal(await gaugeFactory.emergencyWithdrawEnabled(), true);
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
        assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 1);
        assert.equal((await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber)).length, 0, "emergencyWithdraw is only a fallback");
      } finally {
        // restore Aero (and investing, had emergencyExit gone through)
        await gaugeFactory.setGaugeTape(gaugeTape, gaugeTapeGasLimit, { from: penaltyAdmin });
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }
    });

    it("Reverts the hard work when the claim fails Aero's gas check, and goes on when the claim fails otherwise", async function() {
      // the claim's InsufficientGasForCall comes here from a LeafVoter that returns nothing else (the gauge passes its
      // revert data through), as from a gauge tape needing more gas than the keeper left. With the default
      // minStakeInterval the hard work stakes nothing, so the claim is the only gauge call that could fail
      await doHardWork(); // everything staked
      await Utils.advanceNBlock(600);
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      let before = await gaugeCheckpoint();
      await strategy.setMinStakeInterval(432000, { from: governance });
      try {
        await withLeafVoterCode(insufficientGasCode, async () => {
          let message = await revertMessage(gauge.claimEmissions.call(strategy.address, strategy.address, { from: strategy.address }),
            "the gauge's claim should revert");
          assert.include(message, revertData(insufficientGasError), "the gauge should pass its LeafVoter's revert data through");
          message = await revertMessage(controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice }),
            "the hard work should revert when its claim fails Aero's gas check");
          assert.include(message, revertData(insufficientGasError), "the hard work should revert with Aero's gas check error");
        });
        Utils.assertBNEq(await gauge.userRewardPerTokenPaid(strategy.address), before.paid);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);

        // any other claim failure (here Aero's minting paused) is reported, and the hard work goes on
        await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
        try {
          let block = await doHardWork();
          let failures = await strategyEvents("ClaimFailed", block);
          assert.equal(failures.length, 1, "the claim should fail without reverting");
          assert.notEqual(failures[0].args.reason, insufficientGasError);
          assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
        } finally {
          await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
        }
      } finally {
        await strategy.setMinStakeInterval(0, { from: governance });
      }
    });

    it("Keeps new LP unstaked, with no allowance left to the gauge, when the gauge deposit fails", async function() {
      // gauge.deposit settles the gauge with the LeafVoter first (V2Gauge _deposit -> _updateRewards -> _advanceRewards),
      // so every deposit reverts while the LeafVoter is broken. With no window a stake does not need the claim
      await assertNoWindow();
      await depositVault(farmer2, underlying, vault, await farmer2LP(10));
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      let leafVoterCode = await web3.eth.getCode(leafVoterAddress);
      await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, revertingCode]);
      let idle;
      try {
        let block = await doHardWork();
        assert.equal((await strategyEvents("ClaimFailed", block)).length, 1, "the claim should fail without reverting");
        let failures = await strategyEvents("StakeFailed", block);
        assert.equal(failures.length, 1, "the stake should fail without reverting");
        assert.equal(failures[0].args.reason, "0xdeadbeef", "the gauge's own revert data");
        assert.equal((await gaugeEvents("Deposit", block)).length, 0);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
        // the LP waits in the strategy, and the gauge is left no allowance to pull it later
        idle = new BigNumber(await underlying.balanceOf(strategy.address));
        Utils.assertBNGt(idle, 0);
        Utils.assertBNEq(await underlying.allowance(strategy.address, gaugeAddress), 0);
      } finally {
        await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, leafVoterCode]);
      }

      // with the LeafVoter back, the next hard work stakes the waiting LP
      let block = await doHardWork();
      let deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "should stake once the gauge works again");
      Utils.assertBNGte(deposits[0].args._amount.toString(), idle);
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Keeps new LP unstaked, with no allowance left, when the deposit right after a claim fails under a window, and stakes it on the next run", async function() {
      // under a window a stake needs the claim to go through first (_stakeIdle's window gate): here the claim goes through
      // and the gauge deposit right after it fails, with an Aero error that is not its gas check (that one reverts the
      // whole hard work: next test). Both settle the gauge with the LeafVoter first (V2Gauge._advanceRewards), and the
      // LeafVoter fails every settlement after the first of a transaction (laterSettleRevertsCode)
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      let idle;
      try {
        // past the window and the stakeSpacing of the last stake, with new LP: only the deposit can keep it unstaked
        await advanceToBlock(await nextStakeBlock());
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        let depositBlock = Number((await gauge.depositBlock(strategy.address)).toString());
        let lastStake = (await strategy.lastStakeBlock()).toString();
        let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));

        await withGaugeFailingAfterClaim(async () => {
          let block = await doHardWork();
          // the claim goes through ...
          assert.equal((await strategyEvents("ClaimFailed", block)).length, 0, "the claim should go through");
          assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
          assert.equal((await strategyEvents("StakeSkipped", block)).length, 0, "the claim and stakeSpacing should allow the stake");
          // ... the deposit after the liquidation does not, and fails without reverting
          let failures = await strategyEvents("StakeFailed", block);
          assert.equal(failures.length, 1, "the stake should fail without reverting");
          assert.equal(failures[0].args.reason, "0xdeadbeef", "the gauge's own revert data");
          assert.equal((await gaugeEvents("Deposit", block)).length, 0);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
        });
        // the LP waits in the strategy, and the gauge is left no allowance to pull it later
        idle = new BigNumber(await underlying.balanceOf(strategy.address));
        Utils.assertBNGt(idle, 0);
        Utils.assertBNEq(await underlying.allowance(strategy.address, gaugeAddress), 0);
        // no new window and no new last stake: the next run need not wait for stakeSpacing again
        assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(depositBlock));
        assert.equal((await strategy.lastStakeBlock()).toString(), lastStake);
        let window = await strategy.penaltyWindow();
        assert.equal(window.windowEndBlock.toString(), String(depositBlock + 7));
        assert.equal(window.inWindow, false, "should be outside the window");

        // with the LeafVoter back, the next hard work claims and stakes the waiting LP at once
        let block = await doHardWork();
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake the waiting LP");
        Utils.assertBNGte(deposits[0].args._amount.toString(), idle);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        assert.equal((await strategy.penaltyWindow()).windowEndBlock.toString(), String(block + 7));
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();
    });

    it("Reverts the whole hard work, claim included, when the deposit after the claim fails Aero's gas check, and claims and stakes with more keeper gas", async function() {
      // Aero's gas check (recordGaugeTape reverts InsufficientGasForCall while gasleft() <= gaugeTapeGasLimit, in
      // GaugeFactory._validateGasLeft) runs in both the claim and the deposit (V2Gauge._advanceRewards), with the
      // liquidation in between: for a fixed keeper gas limit, a tape gas limit between the gas left at the claim and the gas
      // left at the deposit passes the claim and fails the deposit. At this point of the suite (fork block 53206000, this
      // test order), with 4,000,000 keeper gas, these were 3,275,613 and 2,477,007 (bisecting the tape gas limit with
      // calls; the liquidation swaps once and zaps here): 2,880,000 is ~400,000 from both. The deposit's gas failure reverts
      // the whole hard work (_revertOnGasFailure), so that the keeper retries with more gas
      let keeperGas = 4000000;
      let tapeGasLimit = 2880000;
      let gaugeTape = await gaugeFactory.gaugeTape();
      let gaugeTapeGasLimit = await gaugeFactory.gaugeTapeGasLimit();
      assert.notEqual(gaugeTape, zeroAddress, "the gas check only runs with a gauge tape");
      let hardWorkCall = { from: governance, to: controller.address, gas: keeperGas, gasPrice: keeperGasPrice,
        data: controller.contract.methods.doHardWork(vault.address).encodeABI() };
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      try {
        // past the window and the stakeSpacing of the last stake, with new LP: the hard work claims, and stakes
        await advanceToBlock(await nextStakeBlock());
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));
        let before = await gaugeCheckpoint();
        let aero = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let unstaked = await unstakedLP();
        Utils.assertBNGt(unstaked, 0);
        await gaugeFactory.setGaugeTape(gaugeTape, tapeGasLimit, { from: penaltyAdmin });

        // the claim passes the check at this limit: with the stake left out (the default minStakeInterval), the same hard
        // work goes through (a call: nothing changes)
        await strategy.setMinStakeInterval(432000, { from: governance });
        try {
          await web3.eth.call(hardWorkCall);
        } catch (e) {
          assert.fail("the claim should pass Aero's gas check at this limit: re-bisect tapeGasLimit, see the comment above (" + e.message + ")");
        } finally {
          await strategy.setMinStakeInterval(0, { from: governance });
        }

        // with the stake, the deposit after the liquidation fails the check: the whole hard work reverts
        let outcome = await controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice, gas: keeperGas })
          .then((tx) => tx, (e) => e);
        if (!(outcome instanceof Error)) {
          // it went through: the deposit's gas failure was reported instead of re-raised, or the tape gas limit no longer
          // sits between the gas left at the claim and the gas left at the deposit
          let failures = await strategyEvents("StakeFailed", outcome.receipt.blockNumber);
          assert.equal(failures.length, 0, "the deposit's gas failure should revert the hard work, not be reported: StakeFailed("
            + (failures.length > 0 ? failures[0].args.reason : "") + ")");
          assert.fail("the deposit should fail Aero's gas check at this limit: re-bisect tapeGasLimit, see the comment above");
        }
        assert.include(outcome.message, revertData(insufficientGasError),
          "the hard work should revert with Aero's gas check error: re-bisect tapeGasLimit, see the comment above");
        // and changes nothing: no claim (the AERO is still in the gauge), the LP still waits in the vault
        Utils.assertBNEq(await gauge.userRewardPerTokenPaid(strategy.address), before.paid);
        Utils.assertBNEq(await gauge.rewards(strategy.address), before.rewards);
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aero);
        Utils.assertBNEq(await unstakedLP(), unstaked);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);

        // the same hard work with more keeper gas claims and stakes
        let tx = await controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice, gas: 2 * keeperGas });
        let block = tx.receipt.blockNumber;
        console.log("keeper gas limit: ", 2 * keeperGas, " tape gas limit: ", tapeGasLimit, " (Aero's: ", gaugeTapeGasLimit.toString(),
          ") gas used: ", tx.receipt.gasUsed);
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake");
        Utils.assertBNGte(deposits[0].args._amount.toString(), unstaked);
        Utils.assertBNEq(await unstakedLP(), 0);
      } finally {
        // restore Aero
        await gaugeFactory.setGaugeTape(gaugeTape, gaugeTapeGasLimit, { from: penaltyAdmin });
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();
    });

    it("Keeps going when the pool's fee claim fails, in the hard work and in withdrawAll", async function() {
      // the pool pays its fees out of its fee holder (Pool.sol _claimFees -> PoolFees.claimFeesFor), while swaps only
      // send tokens to it: a broken fee holder breaks claimFees for an LP owed fees, and nothing else
      let poolFees = await poolFeeAccounting.methods.poolFees().call();

      // the strategy earns pool fees on the LP it holds unstaked: withdrawAll's liquidation swaps through this pool (the
      // AERO sale, and the zap) while all the LP is out of the gauge, and claims fees before that, so it leaves the
      // strategy owed fees
      await Utils.advanceNBlock(3600);
      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      let pending = await pendingFees();
      console.log("pool fees owed to the strategy (token0, token1): ", pending.amount0, pending.amount1);
      Utils.assertBNGt(new BigNumber(pending.amount0).plus(pending.amount1), 0);

      let poolFeesCode = await web3.eth.getCode(poolFees);
      await hre.network.provider.send("hardhat_setCode", [poolFees, revertingCode]);
      try {
        let message = await revertMessage(poolFeeAccounting.methods.claimFees(strategy.address).call({ from: strategy.address }),
          "the strategy's fee claim should revert");
        assert.include(message, revertData("0xdeadbeef"), "with the fee holder's error");

        // the hard works go on: the first stakes the LP back, the next claims, sells through the pool, compounds and stakes
        let block = await doHardWork();
        assert.equal((await feeClaims(block)).length, 0, "the fee claim should fail without reverting");
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake");
        await Utils.advanceNBlock(600);
        let lpBefore = await unstakedLP();
        let newLP = await farmer2LP(10);
        await depositVault(farmer2, underlying, vault, newLP);
        block = await doHardWork();
        assert.equal((await feeClaims(block)).length, 0, "the fee claim should fail without reverting");
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0, "swaps should not need the fee holder");
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "should sell the AERO");
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake");
        Utils.assertBNGt(deposits[0].args._amount.toString(), lpBefore.plus(newLP)); // with LP minted from the AERO

        // and withdrawAll empties the gauge
        let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
        let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
        assert.equal((await feeClaims(tx.receipt.blockNumber)).length, 0, "the fee claim should fail without reverting");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
        // the fees owed were never paid, and only grew with the strategy's own sales
        let owed = await pendingFees();
        Utils.assertBNGte(owed.amount0, pending.amount0);
        Utils.assertBNGte(owed.amount1, pending.amount1);
      } finally {
        await hre.network.provider.send("hardhat_setCode", [poolFees, poolFeesCode]);
      }

      // so with the fee holder back, the next hard work collects them all, and stakes the LP again
      pending = await pendingFees();
      let block = await doHardWork();
      let claims = await feeClaims(block);
      assert.equal(claims.length, 1, "should claim the fees");
      Utils.assertBNEq(claims[0].returnValues.amount0, pending.amount0);
      Utils.assertBNEq(claims[0].returnValues.amount1, pending.amount1);
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake everything again");
    });

    it("Collects in the next withdrawAll the pool fees that its own sale in the last one earned", async function() {
      // withdrawAll claims the pool fees before its liquidation swaps through this pool (the AERO sale, and the zap) while
      // it holds all the LP unstaked: the fees of these swaps stay owed to the strategy (two hours of AERO, so that they
      // are not dust)
      await Utils.advanceNBlock(3600);
      let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      assert.equal((await gaugeEvents("EmissionsClaimed", tx.receipt.blockNumber)).length, 1, "the withdrawal should claim");
      assert.equal((await strategyEvents(profitLogInReward, tx.receipt.blockNumber)).length, 1, "should sell the AERO");
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      let pending = await pendingFees();
      console.log("pool fees owed to the strategy after withdrawAll (token0, token1): ", pending.amount0, pending.amount1);
      Utils.assertBNGt(new BigNumber(pending.amount0).plus(pending.amount1), 0);

      // the next withdrawAll, with nothing staked, claims them, compounds them into LP and hands that LP to the vault with
      // the rest. The strategy holds no LP during that zap, so it is owed nothing afterwards
      let vaultLP = new BigNumber(await vault.underlyingBalanceInVault());
      tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      let claims = await feeClaims(tx.receipt.blockNumber);
      assert.equal(claims.length, 1, "withdrawAll should claim the fees owed");
      Utils.assertBNEq(claims[0].returnValues.amount0, pending.amount0);
      Utils.assertBNEq(claims[0].returnValues.amount1, pending.amount1);
      let minted = await mintedLP(tx.receipt.blockNumber);
      Utils.assertBNGt(minted, 0);
      Utils.assertBNEq(await vault.underlyingBalanceInVault(), vaultLP.plus(minted));
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      let owed = await pendingFees();
      Utils.assertBNEq(new BigNumber(owed.amount0).plus(owed.amount1), 0);

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake everything again");
    });

    it("Collects in the next withdrawAll, with nothing staked, the AERO that a failed mint deferred", async function() {
      // a withdrawAll while Aero's minting is paused defers the AERO (V2Gauge _withdraw), and its own claim fails
      await Utils.advanceNBlock(600);
      await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
      try {
        let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
        assert.equal((await gaugeEvents("EmissionsDeferred", tx.receipt.blockNumber)).length, 1, "the withdrawal should defer the AERO");
      } finally {
        await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
      }
      let deferred = new BigNumber(await gauge.deferredEmissions(strategy.address));
      Utils.assertBNGt(deferred, 0);
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);

      // with nothing staked there is no window and nothing to unstake: the next withdrawAll claims it itself (its claim
      // after the unstake) and sells it
      let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 0, "nothing should be left to unstake");
      let collected = await gaugeEvents("DeferredEmissionsClaimed", tx.receipt.blockNumber);
      assert.equal(collected.length, 1, "withdrawAll should collect the deferred AERO");
      Utils.assertBNEq(collected[0].args._amount.toString(), deferred);
      Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), 0);
      assert.equal((await strategyEvents(profitLogInReward, tx.receipt.blockNumber)).length, 1, "should sell the AERO");

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake everything again");
    });

    it("Empties the gauge into the vault, when the gauge withdraw is broken, only after an emergency exit through emergencyWithdraw", async function() {
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(stakedBefore, 0);
      try {
        await withLeafVoterCode(revertingCode, async () => {
          // withdrawAll (also used by rebalance and migration) reverts with the gauge's error, with emergencyWithdraw
          // disabled and enabled alike: it never forfeits the stake's AERO on its own
          for (let enabled of [false, true]) {
            await gaugeFactory.setEmergencyWithdrawEnabled(enabled, { from: emergencyWithdrawAdmin });
            let message = await revertMessage(vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice }),
              "withdrawAll should revert while the gauge is broken (emergencyWithdraw enabled: " + enabled + ")");
            assert.include(message, revertData("0xdeadbeef"), "withdrawAll should revert with the gauge's own error");
            Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
          }

          // the way out: governance's emergency exit leaves through emergencyWithdraw (enabled) ...
          let tx = await strategy.emergencyExit({ from: governance });
          let exits = await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber);
          assert.equal(exits.length, 1, "should exit through emergencyWithdraw");
          Utils.assertBNEq(exits[0].args._amount.toString(), stakedBefore);
          assert.equal(await strategy.pausedInvesting(), true);
          // ... then withdrawAll hands all the LP to the vault; its claim fails without reverting
          let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
          tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
          assert.equal((await gaugeEvents("EmissionsClaimed", tx.receipt.blockNumber)).length, 0, "claiming needs the LeafVoter");
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
          Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
          Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
        });
      } finally {
        // restore Aero (the LeafVoter's code is back) and investing
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }

      // with the gauge working again, the next hard work stakes everything
      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Reports emergencyWithdraw's own error when that fails too in an emergency exit, and still pauses; users get the gauge withdraw's error", async function() {
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(stakedBefore, 0);
      // emergencyWithdraw does no emission accounting (V2Gauge.emergencyWithdraw), so it can only fail at the LP transfer:
      // here the gauge has lost its LP (moved away by impersonating the gauge), while withdraw fails first, on the LeafVoter
      let gaugeLP = new BigNumber(await underlying.balanceOf(gaugeAddress));
      let gaugeEth = await web3.eth.getBalance(gaugeAddress);
      let lpHolder = accounts[8];
      let leafVoterCode = await web3.eth.getCode(leafVoterAddress);
      let moved = false;
      await impersonates([gaugeAddress]);
      await hre.network.provider.send("hardhat_setBalance", [gaugeAddress, "0x8AC7230489E80000"]); // gas for its transfer
      try {
        await underlying.transfer(lpHolder, gaugeLP.toFixed(), { from: gaugeAddress });
        moved = true;
        await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, revertingCode]);
        await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
        // the pool's (OpenZeppelin ERC20) error for a gauge holding no LP
        let insufficientBalance = (amount) => web3.eth.abi.encodeFunctionSignature("ERC20InsufficientBalance(address,uint256,uint256)")
          + web3.eth.abi.encodeParameters(["address", "uint256", "uint256"], [gaugeAddress, 0, amount]).slice(2);

        // a user withdrawal reaching the gauge reverts with the gauge withdraw's error (0xdeadbeef): users never fall back
        let shares = new BigNumber(await vault.balanceOf(farmer1)).div(4).integerValue(BigNumber.ROUND_DOWN);
        let message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }), "withdrawal should revert while the gauge is broken");
        assert.include(message, revertData("0xdeadbeef"), "the withdrawal should revert with the gauge withdraw's own error");

        // an emergency exit falls back, still pauses investing, and reports emergencyWithdraw's error; the stake stays in
        // the gauge's books
        let tx = await strategy.emergencyExit({ from: governance });
        let exitFailures = await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber);
        assert.equal(exitFailures.length, 1);
        assert.equal(exitFailures[0].args.reason, insufficientBalance(stakedBefore.toFixed()), "should report emergencyWithdraw's error");
        assert.equal(await strategy.pausedInvesting(), true, "investing should be paused");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
        assert.notEqual((await strategy.lastStakeBlock()).toString(), "0", "the stake is still there");
      } finally {
        // restore Aero (and investing)
        if (moved) {
          await underlying.transfer(gaugeAddress, gaugeLP.toFixed(), { from: lpHolder });
        }
        await hre.network.provider.send("hardhat_setBalance", [gaugeAddress, web3.utils.toHex(gaugeEth)]);
        await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [gaugeAddress] });
        await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, leafVoterCode]);
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }
      Utils.assertBNEq(await underlying.balanceOf(gaugeAddress), gaugeLP);
    });

    it("Treats a gauge failure without revert data like any other: users get it, an emergency exit reports it or falls back to emergencyWithdraw", async function() {
      // only Aero's own gas check error (InsufficientGasForCall) is re-raised as a gas failure: empty revert data is not.
      // Here every call to the LeafVoter reverts with no data, without burning its gas
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(stakedBefore, 0);
      let shares = new BigNumber(await vault.balanceOf(farmer1)).div(4).integerValue(BigNumber.ROUND_DOWN);
      try {
        await withLeafVoterCode(emptyRevertCode, async () => {
          // user withdrawals and withdrawAll revert with the gauge's (empty) revert data, emergencyWithdraw enabled or not
          for (let enabled of [false, true]) {
            await gaugeFactory.setEmergencyWithdrawEnabled(enabled, { from: emergencyWithdrawAdmin });
            let message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }), "withdrawal should revert");
            assert.include(message, "Transaction reverted without a reason string", "the withdrawal should revert with no data, as the gauge did");
            message = await revertMessage(vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice }), "withdrawAll should revert");
            assert.include(message, "Transaction reverted without a reason string", "withdrawAll should revert with no data, as the gauge did");
            Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
          }

          // emergencyWithdraw disabled: the emergency exit reports the failure, with no data, and still pauses
          await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
          let tx = await strategy.emergencyExit({ from: governance });
          let exitFailures = await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber);
          assert.equal(exitFailures.length, 1, "the exit should fail without reverting");
          assert.include([null, "0x"], exitFailures[0].args.reason, "the gauge's own (empty) revert data");
          assert.equal(await strategy.pausedInvesting(), true);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
          await strategy.continueInvesting({ from: governance });

          // enabled: it falls back to emergencyWithdraw
          await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
          tx = await strategy.emergencyExit({ from: governance });
          let exits = await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber);
          assert.equal(exits.length, 1, "should fall back to emergencyWithdraw");
          Utils.assertBNEq(exits[0].args._amount.toString(), stakedBefore);
          assert.equal((await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber)).length, 0);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        });
      } finally {
        // restore Aero (the LeafVoter's code is back) and investing
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
    });

    it("Pays a user withdrawal from the gauge with far less gas than an emergency exit needs: user exits have no gas floor", async function() {
      // only the best-effort exits (emergencyExit, leaving a switched-off gauge) need gaugeTapeGasLimit + 1,200,000 gas left
      // before calling the gauge; a user withdrawal calls its withdraw directly, which needs a few hundred thousand
      Utils.assertBNEq(await unstakedLP(), 0); // everything staked: the withdrawal reaches the gauge
      let floor = await exitGasFloor();
      assert.isBelow(900000, floor);
      let shares = new BigNumber(await vault.balanceOf(farmer1)).div(10).integerValue(BigNumber.ROUND_DOWN);
      let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
      let farmerBefore = new BigNumber(await underlying.balanceOf(farmer1));
      let tx = await vault.withdraw(shares.toFixed(), { from: farmer1, gas: 900000 });
      console.log("gas used by a user withdrawal from the gauge: ", tx.receipt.gasUsed, " (exit floor: ", floor, ")");
      Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer1)).minus(farmerBefore), expected);
      let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
      assert.equal(withdrawn.length, 1, "the withdrawal should reach the gauge's normal withdraw");
      Utils.assertBNEq(withdrawn[0].args._amount.toString(), expected);
      assert.equal((await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber)).length, 0);
    });

    it("Refuses an emergency exit with too little gas left for the gauge, and just above that leaves through the normal withdraw", async function() {
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      let floor = await exitGasFloor();
      await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
      try {
        // the floor counts the gas left when the exit starts: a transaction with only that much gas has less by then
        let message = await revertMessage(strategy.emergencyExit({ from: governance, gas: floor }), "emergencyExit should revert below the floor");
        assert.include(message, "Not enough gas for the gauge");
        assert.equal(await strategy.pausedInvesting(), false);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);

        // the least gas that gets through lands just above the floor: the gauge's withdraw then gets all but the 200,000 kept
        // back, plenty for it, so the exit leaves through it, although emergencyWithdraw is enabled
        let least = await leastGas({ from: governance, to: strategy.address, data: strategy.contract.methods.emergencyExit().encodeABI() },
          floor, floor + 1000000);
        console.log("least gas for emergencyExit: ", least, " exit floor: ", floor);
        assert.isBelow(least, floor + 150000, "the least gas should be set by the floor");
        let tx = await strategy.emergencyExit({ from: governance, gas: least });
        let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
        assert.equal(withdrawn.length, 1, "should leave through the normal withdraw");
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
        assert.equal((await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber)).length, 0, "emergencyWithdraw is only a fallback");
        assert.equal((await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber)).length, 0);
        assert.equal(await strategy.pausedInvesting(), true);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      } finally {
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
    });

    it("Leaves through emergencyWithdraw in an emergency exit when the gauge withdraw burns all its gas, while user exits revert", async function() {
      // a gauge withdraw that runs out of gas: the LeafVoter hits INVALID, which burns all the gas the gauge passed on
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      let floor = await exitGasFloor();
      let shares = new BigNumber(await vault.balanceOf(farmer1)).div(10).integerValue(BigNumber.ROUND_DOWN);
      await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
      try {
        await withLeafVoterCode(invalidCode, async () => {
          // user exits revert, emergencyWithdraw is not theirs to use
          let message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }), "withdrawal should revert");
          assert.include(message, "Transaction reverted without a reason string");
          message = await revertMessage(vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice }), "withdrawAll should revert");
          assert.include(message, "Transaction reverted without a reason string");
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);

          // an emergency exit with only 200,000 gas more than the floor still gets out: the withdraw burns all the gas it was
          // given, but that was all but the 200,000 kept back for emergencyWithdraw
          let tx = await strategy.emergencyExit({ from: governance, gas: floor + 200000 });
          let exits = await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber);
          assert.equal(exits.length, 1, "should leave through emergencyWithdraw");
          Utils.assertBNEq(exits[0].args._amount.toString(), staked);
          assert.equal((await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber)).length, 0);
          assert.equal(await strategy.pausedInvesting(), true);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
          assert.equal((await strategy.lastStakeBlock()).toString(), "0");

          // then withdrawAll hands all the LP to the vault. Its claim burns 63/64 of the gas it gets too, so it is sent with
          // ample gas
          let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
          await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice, gas: 8000000 });
          Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
          Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
        });
      } finally {
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
    });

    it("Re-raises Aero's gas check error from the gauge withdraw in an emergency exit, even with emergencyWithdraw enabled", async function() {
      // InsufficientGasForCall says the gauge needed more gas: more gas fixes it, so it never justifies forfeiting the
      // stake's AERO through emergencyWithdraw. It comes here from a LeafVoter that returns nothing else
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
      try {
        await withLeafVoterCode(insufficientGasCode, async () => {
          // the gauge's withdraw passes the LeafVoter's revert data through
          let message = await revertMessage(gauge.withdraw.call(staked.toFixed(), { from: strategy.address }), "the gauge's withdraw should revert");
          assert.include(message, revertData(insufficientGasError));
          message = await revertMessage(strategy.emergencyExit({ from: governance }), "emergencyExit should revert");
          assert.include(message, revertData(insufficientGasError), "emergencyExit should re-raise Aero's gas check error");
        });
        assert.equal(await strategy.pausedInvesting(), false);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
      } finally {
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }
    });
  });

  describe("Pool tokens compounded through the zap (no window)", function() {
    before(async function() {
      await assertNoWindow();
      await doHardWork(); // everything staked
    });

    it("Swaps a surplus of USDC (token1) for AERO through the pool, then mints, leaving almost nothing", async function() {
      // selling off: the hard work claims AERO but neither sells it nor puts it in the pool (all the AERO is reserved), and
      // still compounds the other pool token: here the USDC behind 0.05% of farmer2's LP (the zap prices its swap at the
      // pool's margin, so its error grows with the size). AERO is token0 and the reward too: the strategy only holds
      // more AERO than the pool's ratio after an AERO sale that brought in too little USDC, as when Aero's MEV tax hits the
      // sale (the token0 surplus of the MEV-tax test below)
      await strategy.setSell(false, { from: governance });
      try {
        let usdcIn = (await burnLP(2000))[1];
        await usdcToken.transfer(strategy.address, usdcIn.toFixed(), { from: farmer2 });
        let held = await dollars(0, await usdcToken.balanceOf(strategy.address));
        let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let block = await doHardWork();
        let claimed = (await gaugeEvents("EmissionsClaimed", block))[0].args._rewardAmount.toString();
        // the zap swaps part of the USDC for AERO through the pool ...
        let zap = await poolEvents("Swap", block, strategy.address);
        assert.equal(zap.length, 1, "the zap should swap USDC through the pool");
        let swap = zap[0].returnValues;
        Utils.assertBNGt(swap.amount1In, 0);
        Utils.assertBNEq(swap.amount0In, 0);
        Utils.assertBNGt(swap.amount0Out, 0);
        // ... then mints LP with both, which is staked; the AERO reserved is untouched, the mint only takes AERO the zap bought
        let mints = await poolEvents("Mint", block, strategy.address);
        assert.equal(mints.length, 1);
        let bought = new BigNumber(swap.amount0Out);
        let mintedAero = new BigNumber(mints[0].returnValues.amount0);
        Utils.assertBNGte(bought, mintedAero);
        let feeAero = (await feeClaims(block)).reduce((total, claim) => total.plus(claim.returnValues.amount0), new BigNumber(0));
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aeroBefore.plus(claimed).plus(feeAero).plus(bought).minus(mintedAero));
        let minted = await mintedLP(block);
        Utils.assertBNGt(minted, 0);
        assert.equal((await gaugeEvents("Deposit", block)).length, 1);
        let leftover = await dollars(bought.minus(mintedAero), await usdcToken.balanceOf(strategy.address));
        console.log("zap of USDC (token1): held ($, USDC 6 decimals): ", held.toFixed(), " swapped: ", swap.amount1In,
          " minted LP worth: ", (await lpDollars(minted)).toFixed(), " left over: ", leftover.toFixed(), " (", leftover.toNumber() / held.toNumber(),
          "): AERO ", bought.minus(mintedAero).toFixed(), " USDC ", (await usdcToken.balanceOf(strategy.address)).toString());
        // what is left is ~1e-7 of what was held (a USDC wei or two), as AERO: the zap's own swap moves this pool's price,
        // which leaves about (amount swapped / reserve) of what it bought unpaired (see the withdrawAll test below). The
        // bound is 3e-6, as in that test. A zap that priced the pool with a single probe, whose own price impact undervalues
        // the reserve by ~1e-4, swaps a little too much and leaves ~5e-5, as AERO; extrapolating the two probes too far
        // leaves as much USDC. Pricing the swap of a token1 surplus with token0's probe (the zap before the fix) under-swaps
        // by about the pool's 0.3% fee instead, leaving ~3e-3 of it
        assert.isTrue(leftover.times(1000000).lt(held.times(3)),
          "the zap should leave less than 3e-6 of the " + held.toFixed() + " it held, not " + leftover.toFixed());
      } finally {
        await strategy.setSell(true, { from: governance });
      }
    });

    it("Keeps the USDC while Aero has paused swaps (none of it is in the pool's ratio with all the AERO reserved), zaps it once they resume, and keeps the AERO a paused sale cannot sell", async function() {
      await strategy.setSell(false, { from: governance });
      try {
        // the USDC behind 0.1% of farmer2's LP. With selling off all the AERO is reserved, so none of the USDC is matched
        let usdcIn = (await burnLP(1000))[1];
        await usdcToken.transfer(strategy.address, usdcIn.toFixed(), { from: farmer2 });
        let usdcHeld = new BigNumber(await usdcToken.balanceOf(strategy.address));

        await withSwapsPaused(async () => {
          let block = await doHardWork();
          // no swap through the paused pool (Pool.swap would revert IsPaused, and the whole liquidation with it), and
          // nothing in the pool's ratio to mint: the USDC waits
          assert.equal((await poolEvents("Swap", block, strategy.address)).length, 0, "the zap should not swap while swaps are paused");
          assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
          assert.equal((await poolEvents("Mint", block, strategy.address)).length, 0, "nothing is in the pool's ratio");
          Utils.assertBNEq(await usdcToken.balanceOf(strategy.address), usdcHeld);
        });

        // once swaps resume, the next hard work zaps it
        let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let block = await doHardWork();
        let claimed = (await gaugeEvents("EmissionsClaimed", block))[0].args._rewardAmount.toString();
        let zap = await poolEvents("Swap", block, strategy.address);
        assert.equal(zap.length, 1, "should zap the USDC");
        Utils.assertBNGt(zap[0].returnValues.amount1In, 0);
        let mints = await poolEvents("Mint", block, strategy.address);
        assert.equal(mints.length, 1);
        let unused = new BigNumber(zap[0].returnValues.amount0Out).minus(mints[0].returnValues.amount0);
        let feeAero = (await feeClaims(block)).reduce((total, claim) => total.plus(claim.returnValues.amount0), new BigNumber(0));
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aeroBefore.plus(claimed).plus(feeAero).plus(unused));
        Utils.assertBNGt(await dollars(0, usdcHeld), (await dollars(unused, await usdcToken.balanceOf(strategy.address))).times(1000));
      } finally {
        await strategy.setSell(true, { from: governance });
      }

      // with selling on, the hard work's AERO sale goes through this pool (AERO -> USDC, the route of the test setup): while
      // swaps are paused that sale reverts IsPaused, and the whole liquidation with it, fee included. The AERO waits
      await Utils.advanceNBlock(600);
      await withSwapsPaused(async () => {
        let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let block = await doHardWork();
        let failures = await strategyEvents("LiquidationFailed", block);
        assert.equal(failures.length, 1, "the AERO sale should fail");
        assert.equal(failures[0].args.reason, web3.eth.abi.encodeFunctionSignature("IsPaused()"), "the pool's own error");
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "no fee should be taken");
        let claimed = (await gaugeEvents("EmissionsClaimed", block))[0].args._rewardAmount.toString();
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aeroBefore.plus(claimed));
      });
      // and is sold with the next claim once swaps resume
      let aeroKept = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 1);
      Utils.assertBNGt(aeroKept, new BigNumber(await aeroToken.balanceOf(strategy.address)).times(100));
    });

    it("Leaves nothing behind in withdrawAll: the pool fees owed and the pool tokens held go to the vault as LP", async function() {
      let aeroLeft, usdcLeft, held;
      // LP idle in the strategy earns pool fees: the default minStakeInterval keeps new LP out of the gauge
      await strategy.setMinStakeInterval(432000, { from: governance });
      try {
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        let block = await doHardWork();
        assert.equal((await gaugeEvents("Deposit", block)).length, 0);
        Utils.assertBNGt(await underlying.balanceOf(strategy.address), 0);
        // swaps through the pool, both ways, and USDC sent to the strategy
        let amounts = await burnLP(100);
        await poolSwap(farmer2, usdc, amounts[1].toFixed());
        await poolSwap(farmer2, aero, amounts[0].toFixed());
        let pending = await pendingFees();
        Utils.assertBNGt(await dollars(pending.amount0, pending.amount1), 0);
        let sent = (await burnLP(1000))[1];
        await usdcToken.transfer(strategy.address, sent.toFixed(), { from: farmer2 });
        held = (await poolTokensHeld()).plus(await dollars(pending.amount0, pending.amount1));

        let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
        let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
        let claims = await feeClaims(tx.receipt.blockNumber);
        assert.equal(claims.length, 1, "should claim the pool fees");
        Utils.assertBNEq(claims[0].returnValues.amount0, pending.amount0);
        Utils.assertBNEq(claims[0].returnValues.amount1, pending.amount1);
        let minted = await mintedLP(tx.receipt.blockNumber);
        Utils.assertBNGt(minted, 0);
        // all the LP, the compounded included, is in the vault ...
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        Utils.assertBNGte(await vault.underlyingBalanceInVault(), total.plus(minted));
        // ... and the strategy keeps at most dust of each pool token
        aeroLeft = new BigNumber(await aeroToken.balanceOf(strategy.address));
        usdcLeft = new BigNumber(await usdcToken.balanceOf(strategy.address));
        console.log("pool tokens and fees compounded ($, USDC 6 decimals): ", held.toFixed(), " left over: AERO ", aeroLeft.toFixed(),
          " USDC ", usdcLeft.toFixed(), " (AERO worth ", (await dollars(aeroLeft, 0)).toFixed(), ")");
        Utils.assertBNGt(held, (await dollars(aeroLeft, usdcLeft)).times(1000));
      } finally {
        await strategy.setMinStakeInterval(0, { from: governance });
      }

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake everything again");

      // and almost nothing at all, AERO above all: AERO cannot be salvaged, so what withdrawAll leaves of it would stay in
      // the strategy for good after a migration. Checked last, so that a failure here leaves the strategy staked for the
      // tests below. AERO is one of this pool's tokens: the zap's own swap moves the price by about (amount swapped /
      // reserve), which leaves that share of the amount unpaired, as AERO, so the leftover grows with the square of the
      // amount. Here ~3e-7 of the ~21 USDC compounded (~1e13 wei of AERO, worth ~7 USDC wei); the bound is 3e-6. A zap that
      // priced the pool with a single probe, which moves the price it measures, left ~5e-5 here (~1.5e15 wei of AERO, ~1,050
      // USDC wei)
      let leftValue = await dollars(aeroLeft, usdcLeft);
      assert.isTrue(leftValue.lt(held.times(3).idiv(1000000)),
        "withdrawAll should leave pool tokens worth less than 3e-6 of the " + held.toFixed() + " it compounded, not " + leftValue.toFixed());
    });

    it("Zaps through the pool when the keeper's priority fee is above Aero's MEV-tax threshold", async function() {
      // the zap quotes its swap with getAmountOutWithTotalFee, the pool's fee for this transaction with the MEV tax, so
      // the pool's own check (K) passes at any priority fee. 2.5 gwei is above the volatile pools' 1 gwei threshold; this
      // pool's base fee is 30 bps
      let taxedGasPrice = "2500000000";
      let baseFeeBps = 30;
      // the pool fee the strategy's own swap paid in `block`, and what it swapped (in the input token)
      async function zapFee(block) {
        let zap = await poolEvents("Swap", block, strategy.address);
        assert.equal(zap.length, 1, "should zap");
        let fees = await poolEvents("Fees", block, strategy.address);
        assert.equal(fees.length, 1);
        let swapped = new BigNumber(zap[0].returnValues.amount0In).plus(zap[0].returnValues.amount1In);
        let charged = new BigNumber(fees[0].returnValues.amount0).plus(fees[0].returnValues.amount1);
        console.log("zap swapped ", swapped.toFixed(), " (token0 in: ", zap[0].returnValues.amount0In, ") and paid ", charged.toFixed(),
          " in fees (", charged.toNumber() / swapped.toNumber(), "), of which MEV tax over the base fee: ",
          charged.minus(swapped.times(baseFeeBps).idiv(10000)).toFixed());
        Utils.assertBNGt(charged.times(10000), swapped.times(baseFeeBps)); // more than the base fee: taxed
        return zap[0].returnValues;
      }

      // selling off, and only USDC to compound
      await strategy.setSell(false, { from: governance });
      try {
        let amount = (await burnLP(1000))[1];
        await usdcToken.transfer(strategy.address, amount.toFixed(), { from: farmer2 });
        // at that priority fee the pool pays out less than at the keeper's usual one: it charges the tax
        let half = amount.idiv(2).toFixed();
        let untaxed = new BigNumber(await pool.getAmountOutWithTotalFee(half, usdc, { from: strategy.address, gasPrice: keeperGasPrice }));
        let taxed = new BigNumber(await pool.getAmountOutWithTotalFee(half, usdc, { from: strategy.address, gasPrice: taxedGasPrice }));
        console.log("quotes for half of the USDC at the keeper's usual and at the taxed priority fee: ", untaxed.toFixed(), " ", taxed.toFixed());
        Utils.assertBNGt(untaxed, taxed);

        let tx = await controller.doHardWork(vault.address, { from: governance, gasPrice: taxedGasPrice });
        let block = tx.receipt.blockNumber;
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0, "the zap should not fail the pool's check");
        await zapFee(block);
        assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should mint");
        // the zap's split does not count the tax (its price probe quotes the base fee): it left some USDC unpaired
        console.log("USDC left unpaired by the taxed zap: ", (await usdcToken.balanceOf(strategy.address)).toString(), " of ", amount.toFixed());
      } finally {
        await strategy.setSell(true, { from: governance });
      }

      // a hard work at the keeper's usual priority fee compounds that USDC, and sells the AERO kept while selling was off
      let block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 1);

      // with an AERO sale (selling on), at the same priority fee: the sale's AERO -> USDC swap pays the tax too, so the split
      // comes out short of USDC and the zap swaps AERO (token0) for USDC: the token0 surplus this pool can reach, since
      // AERO is also the reward (with selling off all of it is reserved)
      await Utils.advanceNBlock(600);
      let tx = await controller.doHardWork(vault.address, { from: governance, gasPrice: taxedGasPrice });
      block = tx.receipt.blockNumber;
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0, "the sale and the zap should not fail the pool's check");
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "should sell the AERO");
      let swap = await zapFee(block);
      Utils.assertBNGt(swap.amount0In, 0);
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should mint");
      // what the zap could not pair stays in the strategy, in the token it swapped (token0). Its split values that token
      // at the base fee, so under the tax about a tenth of what it swapped stays unpaired; a zap that swapped half of what
      // it should would leave about twice what it swapped. Measured: 0.10 and 2.1, so the bound (a half) is ~5x and ~4x
      // from them; no bound can be more than ~4.6x from both. The stable suite's zap test (a token0 surplus without the
      // tax) catches such a zap by ~1e4x
      let token0Left = new BigNumber(await (await IERC20.at(await pool.token0())).balanceOf(strategy.address));
      console.log("token0 left unpaired by the taxed sale's zap: ", token0Left.toFixed(), " (", token0Left.toNumber() / Number(swap.amount0In),
        " of what it swapped)");
      Utils.assertBNGt(new BigNumber(swap.amount0In).idiv(2), token0Left);
    });
  });

  describe("Exit", function() {
    it("Farmer gets back more LP than it deposited", async function() {
      await Utils.advanceNBlock(1800);
      await doHardWork();
      await vault.withdraw(new BigNumber(await vault.balanceOf(farmer1)).toFixed(), { from: farmer1 });
      let farmerNewBalance = new BigNumber(await underlying.balanceOf(farmer1));
      console.log("farmer LP deposited: ", farmerBalance.toFixed(), " withdrawn: ", farmerNewBalance.toFixed());
      Utils.assertBNGt(farmerNewBalance, farmerBalance);
    });
  });

  describe("Pool type", function() {
    it("Rejects a stable pool at initialization", async function() {
      let stablePool = await IAeroV2Pool.at(stablePoolAddress);
      assert.equal(web3.utils.hexToUtf8(await stablePool.POOL_TYPE()), "V2_STABLE");

      // a fresh proxy around a new volatile implementation: nothing is initialized yet
      let implementation = await VolatileStrategy.new();
      let proxy = await StrategyProxy.new(implementation.address);
      let freshStrategy = await VolatileStrategy.at(proxy.address);

      // the stable pool with its own gauge: only the pool type is wrong
      let message = await revertMessage(
        freshStrategy.initializeBaseStrategy(addresses.Storage, stablePoolAddress, vault.address, stableGaugeAddress, aero, { from: governance }),
        "a stable pool should be rejected");
      assert.include(message, "Pool type mismatch");

      // the revert came from the pool-type check, not from the initializer: the same proxy accepts the volatile pool
      await freshStrategy.initializeBaseStrategy(addresses.Storage, underlying.address, vault.address, gaugeAddress, aero, { from: governance });
      assert.equal((await freshStrategy.underlying()).toLowerCase(), underlying.address.toLowerCase());
      assert.equal((await freshStrategy.rewardPool()).toLowerCase(), gaugeAddress.toLowerCase());
    });

    it("Rejects a gauge of another pool of the same type at initialization", async function() {
      // the gauge of another volatile pool: the pool-type check passes, the gauge check must not
      let otherPool = await IAeroV2Pool.at(await (await IAeroV2Gauge.at(otherGaugeAddress)).stakingToken());
      assert.notEqual(otherPool.address.toLowerCase(), underlying.address.toLowerCase());
      assert.equal(web3.utils.hexToUtf8(await otherPool.POOL_TYPE()), "V2_VOLATILE");

      // a fresh proxy around a new volatile implementation: nothing is initialized yet
      let implementation = await VolatileStrategy.new();
      let proxy = await StrategyProxy.new(implementation.address);
      let freshStrategy = await VolatileStrategy.at(proxy.address);

      let message = await revertMessage(
        freshStrategy.initializeBaseStrategy(addresses.Storage, underlying.address, vault.address, otherGaugeAddress, aero, { from: governance }),
        "a gauge of another pool should be rejected");
      assert.include(message, "Underlying mismatch");

      // the revert came from the gauge check, not from the initializer: the same proxy accepts the pool's own gauge
      await freshStrategy.initializeBaseStrategy(addresses.Storage, underlying.address, vault.address, gaugeAddress, aero, { from: governance });
      assert.equal((await freshStrategy.rewardPool()).toLowerCase(), gaugeAddress.toLowerCase());
    });
  });
});
