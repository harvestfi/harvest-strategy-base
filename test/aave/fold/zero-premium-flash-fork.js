// Premium-free flashloans for the deployed Aave cbETH/WETH fold strategy.
//
// The deployed impl levers and delevers through Aave flashLoanSimple and pays
// its 5 bps premium on a flash of ~11.5x the user's equity: ~57.5 bps of every
// deposit and ~57.9 bps of every redemption. The new impl levers with Aave
// flashLoan in interestRateMode 2 (the flash becomes variable debt, no premium)
// and delevers with a fee-free Morpho Blue flashLoan, falling back to Aave
// mode 0 when Morpho is short.
//
// Forks Base at ZP_BLOCK (default 52890976), deploys the new AaveReserveLib +
// impl, and runs every case twice from the same snapshot: once on the deployed
// impl, once with the proxy's implementation slot pointed at the new one.
//
//   ZP_BLOCK=52890976 npx hardhat test test/aave/fold/zero-premium-flash-fork.js
//
// Entry cost = 1 - assets credited (vault Deposit event) / assets sent.
// Exit cost  = 1 - WETH received / (shares * live NAV / supply), with the live
//              NAV read through the new impl (a pure view over the same storage).
//
// ethers-only on purpose: truffle's confirmation pollers are what deadlocked
// the in-process node in the 2026-10-05 crash.

const { assert } = require("chai");
const { ethers } = hre;

const BLOCK = Number(process.env.ZP_BLOCK || 52890976);
const VAULT = "0xE78285A51f51916F2311B7017Db036D8351F3Cf9";
const STRAT = "0xcfd2f32E6d533653cEd5Ba7E5fe1a76C3c626757";
const WETH = "0x4200000000000000000000000000000000000006";
const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
const CLPOOL = "0x47cA96Ea59C13F72745928887f84C9F52C3D7348"; // Slipstream cbETH(token0)/WETH(token1), the UL route
const DEBT = "0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E";
const CBETH_ATOKEN = "0xcf3D55c10DB69f28fD1A75Bd73f3D8A2d9c595ad"; // holds the Aave cbETH reserve: a deep cbETH source
const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const POOL_CONFIGURATOR = "0x5731a04B1E775f0fdd454Bf70f3335886e9A96be";
const POOL_ADMIN = "0x9390B1735def18560c509E2d0bc090E9d6BA257a";
const WETH_BALANCE_SLOT = 3; // WETH9: name, symbol, decimals, balanceOf
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const STRATEGY_NAME = "Aave2AssetFoldStrategyMainnet_ETH_cbETH";
const LIB = "contracts/strategies/aave/fold/AaveReserveLib.sol:AaveReserveLib";
const EIP170 = 24576;
const USER = "0x00000000000000000000000000000000C0FFEE01";

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function deposit() payable",
];
const VAULT_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function deposit(uint256,address) returns (uint256)",
  "function redeem(uint256,address,address) returns (uint256)",
  "event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares)",
];
const STRAT_ABI = [
  "function leverFlashPremiumBps() view returns (uint256)",
  "function deleverFlashPremiumBps() view returns (uint256)",
  "function executeOperation(address[],uint256[],uint256[],address,bytes) returns (bool)",
  "function onMorphoFlashLoan(uint256,bytes)",
  "function universalLiquidator() view returns (address)",
];
const EVENTS = new ethers.utils.Interface([
  "event FlashLoan(address indexed target, address initiator, address indexed asset, uint256 amount, uint8 interestRateMode, uint256 premium, uint16 indexed referralCode)",
  "event FlashLoan(address indexed caller, address indexed token, uint256 assets)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);
const CL_SWAP = EVENTS.getEventTopic("Swap");
const AAVE_FLASH = EVENTS.getEventTopic("FlashLoan(address,address,address,uint256,uint8,uint256,uint16)");
const MORPHO_FLASH = EVENTS.getEventTopic("FlashLoan(address,address,uint256)");

describe("Aave fold premium-free flashloans (fork)", function () {
  let oldImpl, newImpl, lib, strat, vault, weth, user, base;
  const results = [];

  const send = (m, p = []) => ethers.provider.send(m, p);
  const pad32 = (a) => ethers.utils.hexZeroPad(a, 32);
  const E = (x) => ethers.utils.formatEther(x);
  const useImpl = (addr) => send("hardhat_setStorageAt", [STRAT, IMPL_SLOT, pad32(addr)]);
  const bps = (num, den) => Number(num.mul(1_000_000).div(den)) / 100;
  async function signer(addr) {
    await send("hardhat_impersonateAccount", [addr]);
    await send("hardhat_setBalance", [addr, "0x56BC75E2D63100000000"]);
    return ethers.provider.getSigner(addr);
  }
  async function inSnapshot(fn) {
    const id = await send("evm_snapshot");
    try { return await fn(); } finally { await send("evm_revert", [id]); }
  }
  function flashes(rc) {
    const aave = [], morpho = [];
    for (const l of rc.logs) {
      if (l.address === ethers.utils.getAddress(AAVE_POOL) && l.topics[0] === AAVE_FLASH) {
        const p = EVENTS.parseLog(l);
        aave.push({ amount: p.args.amount, mode: p.args.interestRateMode, premium: p.args.premium });
      }
      if (l.address === ethers.utils.getAddress(MORPHO) && l.topics[0] === MORPHO_FLASH) {
        morpho.push({ amount: EVENTS.parseLog(l).args.assets });
      }
    }
    return { aave, morpho };
  }
  // The live NAV, read through the new impl's investedUnderlyingBalance.
  async function liveNav() {
    await useImpl(newImpl.address);
    return vault.totalAssets();
  }

  async function deposit(amt) {
    await (await weth.deposit({ value: amt })).wait();
    await (await weth.approve(VAULT, amt)).wait();
    const rc = await (await vault.connect(user).deposit(amt, USER, { gasLimit: 15_000_000 })).wait();
    const ev = rc.logs.map((l) => { try { return vault.interface.parseLog(l); } catch (e) { return null; } })
      .find((x) => x && x.name === "Deposit");
    return { rc, credited: ev.args.assets, cost: bps(amt.sub(ev.args.assets), amt), ...flashes(rc) };
  }

  async function redeem(shares) {
    const nav = await liveNav();
    const fair = shares.mul(nav).div(await vault.totalSupply());
    return { fair, run: async () => {
      const w0 = await weth.balanceOf(USER);
      const rc = await (await vault.connect(user).redeem(shares, USER, USER, { gasLimit: 15_000_000 })).wait();
      const got = (await weth.balanceOf(USER)).sub(w0);
      return { rc, got, cost: bps(fair.sub(got), fair), ...flashes(rc) };
    } };
  }

  // Undo a deposit's price impact on the Slipstream pool: sell back the cbETH
  // its swaps took out, through the same UL route. Exits are then measured from
  // the untouched pool price, not from one the entry pushed in their favour.
  async function restorePool(rc) {
    const sqrt = async () => (await new ethers.Contract(CLPOOL, ["function slot0() view returns (uint160)"], ethers.provider).slot0());
    let cbOut = ethers.BigNumber.from(0);
    for (const l of rc.logs) {
      if (l.address === ethers.utils.getAddress(CLPOOL) && l.topics[0] === CL_SWAP) cbOut = cbOut.sub(EVENTS.parseLog(l).args.amount0);
    }
    const cb = new ethers.Contract(CBETH, [...ERC20, "function transfer(address,uint256) returns (bool)"], await signer(CBETH_ATOKEN));
    await (await cb.transfer(USER, cbOut)).wait();
    const ul = new ethers.Contract(await strat.universalLiquidator(), ["function swap(address,address,uint256,uint256,address) returns (uint256)"], user);
    await (await cb.connect(user).approve(ul.address, cbOut)).wait();
    await (await ul.swap(CBETH, WETH, cbOut, 1, USER, { gasLimit: 3_000_000 })).wait();
    return sqrt();
  }

  async function tryRun(fn) {
    try { return await fn(); } catch (e) { return { error: (e.reason || e.message).slice(0, 120) }; }
  }

  before(async function () {
    await send("hardhat_reset", [{ forking: { jsonRpcUrl: hre.network.config.forking.url, blockNumber: BLOCK } }]);
    await send("evm_mine"); // EDR has no Base hardfork history at the fork block itself
    oldImpl = ethers.utils.getAddress("0x" + (await ethers.provider.getStorageAt(STRAT, IMPL_SLOT)).slice(26));

    lib = await (await ethers.getContractFactory("AaveReserveLib")).deploy();
    await lib.deployed();
    newImpl = await (await ethers.getContractFactory(STRATEGY_NAME, { libraries: { [LIB]: lib.address } })).deploy();
    await newImpl.deployed();

    strat = new ethers.Contract(STRAT, STRAT_ABI, ethers.provider);
    vault = new ethers.Contract(VAULT, VAULT_ABI, ethers.provider);
    user = await signer(USER);
    weth = new ethers.Contract(WETH, ERC20, user);
    console.log(`      block ${BLOCK}, deployed impl ${oldImpl}, Morpho WETH ${E(await weth.balanceOf(MORPHO))}`);
    base = await send("evm_snapshot");
  });

  beforeEach(async function () {
    await send("evm_revert", [base]);
    base = await send("evm_snapshot");
  });

  after(function () {
    if (results.length) console.log("RESULT_JSON " + JSON.stringify({ block: BLOCK, rows: results }));
  });

  it("new implementation fits EIP-170", async function () {
    const art = await hre.artifacts.readArtifact(STRATEGY_NAME);
    const size = (art.deployedBytecode.length - 2) / 2;
    const libArt = await hre.artifacts.readArtifact("AaveReserveLib");
    console.log(`      strategy ${size} B (headroom ${EIP170 - size} B), AaveReserveLib ${(libArt.deployedBytecode.length - 2) / 2} B`);
    assert.isBelow(size, EIP170);
    // scripts/16's stale-library guard: runtime code == artifact once the
    // PUSH20 <own address> prefix is masked; the deployed 0x2B19 lib fails it.
    const mask = (c) => c.toLowerCase().slice(0, 4) + "0".repeat(40) + c.toLowerCase().slice(44);
    assert.equal(mask(await ethers.provider.getCode(lib.address)), libArt.deployedBytecode.toLowerCase());
    assert.notEqual(mask(await ethers.provider.getCode("0x2B19aB8A9b31798f2536c440B596816e2aa10033")), libArt.deployedBytecode.toLowerCase());
  });

  it("premium getters report 0 / 0 while Morpho can lend the whole debt", async function () {
    await useImpl(newImpl.address);
    assert.equal((await strat.leverFlashPremiumBps()).toString(), "0");
    assert.equal((await strat.deleverFlashPremiumBps()).toString(), "0");
  });

  for (const size of ["0.01", "0.1", "1", "5", "20", "30"]) {
    it(`deposit ${size} WETH: the lever flash is mode-2 debt with no premium`, async function () {
      const amt = ethers.utils.parseEther(size);
      const old = await inSnapshot(() => tryRun(() => deposit(amt)));
      await useImpl(newImpl.address);
      const neu = await tryRun(() => deposit(amt));
      const row = { kind: "deposit", size, oldCostBps: old.cost, newCostBps: neu.cost, oldError: old.error, newError: neu.error,
        oldPremium: old.aave && old.aave[0] && E(old.aave[0].premium), flash: neu.aave && neu.aave[0] && E(neu.aave[0].amount),
        gasOld: old.rc && old.rc.gasUsed.toString(), gasNew: neu.rc && neu.rc.gasUsed.toString() };
      results.push(row);
      console.log(`      entry cost: deployed ${old.error ? "REVERT " + old.error : old.cost + " bps"}, new ${neu.error ? "REVERT " + neu.error : neu.cost + " bps"}`);
      if (old.error) {
        // Past the Slipstream pool's in-tick capacity both builds revert on the swap floor.
        assert.isOk(neu.error || neu.cost < 25, "new build is never worse than the deployed one");
        return;
      }
      assert.isUndefined(neu.error, "new build must deposit wherever the deployed one does");
      assert.equal(neu.aave.length, 1, "one Aave flash");
      assert.equal(neu.aave[0].mode, 2, "interestRateMode 2: the flash is opened as variable debt");
      assert.isTrue(neu.aave[0].premium.isZero(), "no premium");
      assert.equal(neu.morpho.length, 0, "the lever does not use Morpho");
      assert.isTrue(old.aave[0].premium.gt(0), "deployed build paid a premium");
      assert.isAbove(old.cost - neu.cost, 50, "saves the ~57.5 bps premium");
      assert.isBelow(neu.cost, 25, "entry cost is now the swaps only (~17.5 bps)");
    });
  }

  it("deposit: the extra mode-2 debt is exactly the premium the deployed build paid on top of the flash", async function () {
    const amt = ethers.utils.parseEther("1");
    const debt = new ethers.Contract(DEBT, ERC20, ethers.provider);
    const old = await inSnapshot(async () => { const d0 = await debt.balanceOf(STRAT); const r = await deposit(amt); return { r, dd: (await debt.balanceOf(STRAT)).sub(d0) }; });
    await useImpl(newImpl.address);
    const d0 = await debt.balanceOf(STRAT);
    const r = await deposit(amt);
    const dd = (await debt.balanceOf(STRAT)).sub(d0);
    // Deployed: flash F/(1+p), borrow F/(1+p) + premium. New: flash F, debt F.
    // Both target the same debt increase, so the two debt deltas agree to a few
    // wei. Each delta also holds one block of interest on the existing debt.
    console.log(`      debt +${E(old.dd)} (deployed: flash ${E(old.r.aave[0].amount)} + premium ${E(old.r.aave[0].premium)}) vs +${E(dd)} (new: flash ${E(r.aave[0].amount)})`);
    assert.isTrue(dd.sub(old.dd).abs().lte(10), "same debt increase");
    assert.isTrue(r.aave[0].amount.sub(dd).abs().lte(d0.div(1_000_000)), "debt grows by the flashed amount (+ a block of interest)");
  });

  for (const size of ["0.01", "0.1", "1", "5", "20", "all"]) {
    it(`redeem ${size === "all" ? "everything" : size + " WETH worth"}: the delever flash comes from Morpho for free`, async function () {
      await useImpl(newImpl.address);
      const sqrtBefore = await new ethers.Contract(CLPOOL, ["function slot0() view returns (uint160)"], ethers.provider).slot0();
      const entry = await deposit(ethers.utils.parseEther("25")); // shares to exit, entered on the new build
      const sqrtAfter = await restorePool(entry.rc);
      // Pool price back to within 0.1 bps of where it started.
      assert.isBelow(Math.abs(bps(sqrtAfter.sub(sqrtBefore), sqrtBefore)), 0.1, "pool price restored");
      const held = await vault.balanceOf(USER);
      const nav = await liveNav();
      const shares = size === "all" ? held
        : ethers.utils.parseEther(size).mul(await vault.totalSupply()).div(nav);
      const pre = await send("evm_snapshot");

      await useImpl(oldImpl);
      let q = await redeem(shares);
      await useImpl(oldImpl);
      const old = await tryRun(q.run);
      await send("evm_revert", [pre]);

      q = await redeem(shares);
      const neu = await tryRun(q.run);
      results.push({ kind: "redeem", size, fair: E(q.fair), oldCostBps: old.cost, newCostBps: neu.cost, oldError: old.error, newError: neu.error,
        oldPremium: old.aave && old.aave[0] && E(old.aave[0].premium), flash: neu.morpho && neu.morpho[0] && E(neu.morpho[0].amount),
        gasOld: old.rc && old.rc.gasUsed.toString(), gasNew: neu.rc && neu.rc.gasUsed.toString() });
      console.log(`      exit cost on ${E(q.fair)} WETH: deployed ${old.error ? "REVERT " + old.error : old.cost + " bps"}, new ${neu.error ? "REVERT " + neu.error : neu.cost + " bps"}`);
      assert.isUndefined(old.error, "deployed build redeems");
      assert.isUndefined(neu.error, "new build redeems");
      assert.equal(neu.aave.length, 0, "no Aave flash");
      assert.equal(neu.morpho.length, 1, "one Morpho flash");
      assert.isTrue(old.aave[0].premium.gt(0), "deployed build paid a premium");
      assert.isAbove(old.cost - neu.cost, 50, "saves the ~57.9 bps premium");
      assert.isBelow(neu.cost, 5, "exit cost is now the swap only (~-2.5 bps)");
    });
  }

  it("redeem falls back to an Aave mode-0 flash (with premium) when Morpho is short, and the getter says so", async function () {
    await useImpl(newImpl.address);
    await deposit(ethers.utils.parseEther("1"));
    const slot = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [MORPHO, WETH_BALANCE_SLOT]));
    await send("hardhat_setStorageAt", [WETH, slot, pad32(ethers.utils.parseEther("1").toHexString())]);
    assert.equal(E(await weth.balanceOf(MORPHO)), "1.0", "Morpho now holds 1 WETH");

    const pool = new ethers.Contract(AAVE_POOL, ["function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)"], ethers.provider);
    assert.equal((await strat.deleverFlashPremiumBps()).toString(), (await pool.FLASHLOAN_PREMIUM_TOTAL()).toString());
    assert.equal((await strat.leverFlashPremiumBps()).toString(), "0", "the lever never depends on Morpho");

    const q = await redeem(await vault.balanceOf(USER));
    const r = await q.run();
    console.log(`      fallback exit cost ${r.cost} bps, Aave flash ${E(r.aave[0].amount)} premium ${E(r.aave[0].premium)}`);
    assert.equal(r.morpho.length, 0);
    assert.equal(r.aave.length, 1);
    assert.equal(r.aave[0].mode, 0, "plain flash, repaid");
    assert.isTrue(r.aave[0].premium.gt(0), "pays the premium");
    assert.isAbove(r.cost, 45, "the deployed build's cost, not a free exit");

    // A lever still works: it never touches Morpho.
    const d = await deposit(ethers.utils.parseEther("1"));
    assert.equal(d.aave[0].mode, 2);
  });

  it("callbacks only run inside the strategy's own flashloans", async function () {
    await useImpl(newImpl.address);
    const params = ethers.utils.defaultAbiCoder.encode(["uint8", "uint256", "uint256"], [1, 0, 0]);
    const expectRevert = async (p, msg) => {
      let reason = null;
      try { await (await p).wait(); } catch (e) { reason = e.reason || e.message; }
      assert.isNotNull(reason, `expected revert ${msg}`);
      assert.include(reason, msg);
    };
    const one = ethers.utils.parseEther("1");

    await expectRevert(strat.connect(user).onMorphoFlashLoan(one, params, { gasLimit: 2_000_000 }), "!morpho");
    // Even Morpho itself is refused outside our own flashLoan (transient flag unset).
    const morpho = await signer(MORPHO);
    await expectRevert(strat.connect(morpho).onMorphoFlashLoan(one, params, { gasLimit: 2_000_000 }), "!morpho");

    await expectRevert(strat.connect(user).executeOperation([WETH], [one], [0], STRAT, params, { gasLimit: 2_000_000 }), "!pool");
    // A third party pointing an Aave flashLoan at the strategy is refused (initiator check).
    const pool = new ethers.Contract(AAVE_POOL, ["function flashLoan(address,address[],uint256[],uint256[],address,bytes,uint16)"], user);
    await expectRevert(pool.flashLoan(STRAT, [WETH], [one], [0], USER, params, 0, { gasLimit: 3_000_000 }), "!sender");
    await expectRevert(pool.flashLoan(STRAT, [WETH], [one], [2], STRAT, params, 0, { gasLimit: 3_000_000 }), "!sender");
  });

  it("a near-full WETH borrow cap clamps the mode-2 lever instead of reverting", async function () {
    const debt = new ethers.Contract(DEBT, ERC20, ethers.provider);
    const cfg = new ethers.Contract(POOL_CONFIGURATOR, ["function setBorrowCap(address,uint256)"], await signer(POOL_ADMIN));
    const ts = await debt.totalSupply();
    const cap = ts.div(ethers.constants.WeiPerEther).add(3); // 2-3 WETH of headroom
    try {
      await (await cfg.setBorrowCap(WETH, cap, { gasLimit: 500_000 })).wait();
    } catch (e) {
      this.skip(); // the fork's admin lost POOL_ADMIN at this block
    }
    await useImpl(newImpl.address);
    const d0 = await debt.balanceOf(STRAT);
    const r = await deposit(ethers.utils.parseEther("5")); // unclamped this would flash ~57 WETH
    const dd = (await debt.balanceOf(STRAT)).sub(d0);
    console.log(`      cap headroom ${E(cap.mul(ethers.constants.WeiPerEther).sub(ts))}, flash ${E(r.aave[0].amount)}, debt +${E(dd)}`);
    assert.equal(r.aave[0].mode, 2);
    assert.isTrue(r.aave[0].amount.lt(ethers.utils.parseEther("3")), "lever clamped to the cap headroom");
    assert.isTrue((await debt.totalSupply()).lte(cap.mul(ethers.constants.WeiPerEther)), "under the borrow cap");
  });
});
