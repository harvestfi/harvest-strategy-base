// Live-NAV fork test for the deployed Aave cbETH/WETH fold strategy.
//
// investedUnderlyingBalance() used to add the cached storedBalance(), which is
// refreshed only on interactions, so totalAssets()/convertTo*/getPricePerFullShare
// lagged the real Aave position between them. It now values the position live
// and nets out the fee the next preInteract() would book, so it must equal
// totalAssets() right after a REAL preInteract(), to the wei, in the same tx.
//
// Forks Base at BLOCK, where strategy proxy 0xcfd2… runs impl 0x74ae6e11 (==
// branch fix-checker-supply-flags), and swaps the proxy's implementation slot to
// the new build inside snapshots. FoldNavProbe (contracts/test) is placed at the
// governance address with hardhat_setCode so preInteract()'s `restricted` check
// passes; it reads totalAssets(), runs preInteract(), and reads it again.
//
//   FORK_BLOCK=52890976 npx hardhat test test/aave/fold/live-nav-fork.js
//
// ethers-only on purpose: truffle's confirmation pollers are what deadlocked
// the in-process node in the 2026-10-05 crash.

const { assert } = require("chai");
const { ethers } = hre;

const BLOCK = 52890976;
const VAULT = "0xE78285A51f51916F2311B7017Db036D8351F3Cf9";
const STRAT = "0xcfd2f32E6d533653cEd5Ba7E5fe1a76C3c626757";
const DEPLOYED_IMPL = "0x74ae6e11a89ae6dfe3a304f7881b67a93187ed3f";
const WETH = "0x4200000000000000000000000000000000000006";
const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const CBETH_HOLDER = "0x47cA96Ea59C13F72745928887f84C9F52C3D7348"; // Slipstream cbETH/WETH pool
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PENDING_FEE_SLOT = "0x0af7af9f5ccfa82c3497f40c7c382677637aee27293a6243a22216b51481bd97";
const STRATEGY_NAME = "Aave2AssetFoldStrategyMainnet_ETH_cbETH";
const EIP170 = 24576;

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function deposit() payable",
];
const VAULT_ABI = [
  "function totalAssets() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function deposit(uint256,address) returns (uint256)",
  "function redeem(uint256,address,address) returns (uint256)",
];
const STRAT_ABI = [
  "function governance() view returns (address)",
  "function scheduleUpgrade(address)",
  "function nextImplementationDelay() view returns (uint256)",
  "function storedBalance() view returns (uint256)",
  "function pendingFee() view returns (uint256)",
  "function underlying() view returns (address)",
  "function vault() view returns (address)",
  "function supplyAsset() view returns (address)",
  "function supplyAToken() view returns (address)",
  "function borrowAToken() view returns (address)",
  "function rewardPool() view returns (address)",
  "function collateralFactorNumerator() view returns (uint256)",
  "function borrowTargetFactorNumerator() view returns (uint256)",
  "function fold() view returns (bool)",
  "function slippageBps() view returns (uint256)",
];

describe("Aave fold live NAV (fork)", function () {
  let probeCode, probeIface, newImpl, gov, strat, vault, user, base;

  const send = (m, p = []) => ethers.provider.send(m, p);
  const pad32 = (a) => ethers.utils.hexZeroPad(a, 32);
  const implOf = async () => ethers.utils.getAddress("0x" + (await ethers.provider.getStorageAt(STRAT, IMPL_SLOT)).slice(26));
  const useImpl = (addr) => send("hardhat_setStorageAt", [STRAT, IMPL_SLOT, pad32(addr)]);
  const bps = (a, b) => (Number(a.sub(b).mul(1_000_000).div(b)) / 100).toFixed(2);
  async function signer(addr) {
    await send("hardhat_impersonateAccount", [addr]);
    await send("hardhat_setBalance", [addr, "0x56BC75E2D63100000000"]);
    return ethers.provider.getSigner(addr);
  }

  // One eth_call at the governance address: totalAssets(), a real preInteract(),
  // totalAssets() again, plus the cached (pre-change) formula on both sides.
  async function probe() {
    const id = await send("evm_snapshot");
    await send("hardhat_setCode", [gov, probeCode]);
    const raw = await ethers.provider.call({ to: gov, data: probeIface.encodeFunctionData("probe", [VAULT, STRAT]), gasLimit: 10_000_000 });
    await send("evm_revert", [id]);
    const r = probeIface.decodeFunctionResult("probe", raw);
    return { assetsBefore: r[0], cachedBefore: r[1], assetsAfter: r[2], cachedAfter: r[3], feeBooked: r[4] };
  }

  before(async function () {
    await send("hardhat_reset", [{ forking: { jsonRpcUrl: hre.network.config.forking.url, blockNumber: BLOCK } }]);
    await send("evm_mine"); // EDR has no Base hardfork history at the fork block itself
    assert.equal(await implOf(), ethers.utils.getAddress(DEPLOYED_IMPL), "fork block runs the deployed impl");

    // The premium-free flash change added AaveReserveLib.flash, so the
    // upgrade ships with a fresh library (the deployed 0x2B19aB8A lacks it).
    const lib = await (await ethers.getContractFactory("AaveReserveLib")).deploy();
    await lib.deployed();
    const factory = await ethers.getContractFactory(STRATEGY_NAME, {
      libraries: { "contracts/strategies/aave/fold/AaveReserveLib.sol:AaveReserveLib": lib.address },
    });
    newImpl = await factory.deploy();
    await newImpl.deployed();

    const probeContract = await (await ethers.getContractFactory("FoldNavProbe")).deploy();
    await probeContract.deployed();
    probeCode = await ethers.provider.getCode(probeContract.address);
    probeIface = probeContract.interface;

    strat = new ethers.Contract(STRAT, STRAT_ABI, ethers.provider);
    vault = new ethers.Contract(VAULT, VAULT_ABI, ethers.provider);
    gov = await strat.governance();
    user = await signer("0x00000000000000000000000000000000C0FFEE01");
    base = await send("evm_snapshot");
  });

  beforeEach(async function () {
    await send("evm_revert", [base]);
    base = await send("evm_snapshot");
  });

  it("new implementation fits EIP-170", async function () {
    const art = await hre.artifacts.readArtifact(STRATEGY_NAME);
    const size = (art.deployedBytecode.length - 2) / 2;
    console.log(`      runtime size ${size} B, headroom ${EIP170 - size} B`);
    assert.isBelow(size, EIP170);
    // The fork allows unlimited code size, so also check what actually got deployed.
    assert.equal((((await ethers.provider.getCode(newImpl.address)).length - 2) / 2), size);
  });

  const scenarios = [
    { name: "as-is", fee: false, setup: async () => {} },
    {
      name: "fee branch (0.05 cbETH supplied on behalf of the strategy, live > storedBalance)",
      fee: true,
      setup: async () => {
        const amt = ethers.utils.parseEther("0.05");
        await (await new ethers.Contract(CBETH, ERC20, await signer(CBETH_HOLDER)).transfer(await user.getAddress(), amt)).wait();
        await (await new ethers.Contract(CBETH, ERC20, user).approve(AAVE_POOL, amt)).wait();
        const pool = new ethers.Contract(AAVE_POOL, ["function supply(address,uint256,address,uint16)"], user);
        await (await pool.supply(CBETH, amt, STRAT, 0)).wait();
      },
    },
    {
      name: "after 7 idle days",
      fee: false,
      setup: async () => { await send("evm_increaseTime", [7 * 86400]); await send("evm_mine"); },
    },
  ];

  for (const sc of scenarios) {
    it(`${sc.name}: totalAssets() equals totalAssets() after a real preInteract(), to the wei`, async function () {
      await sc.setup();

      // Deployed impl on the same state: its totalAssets() is the cached formula and
      // jumps when preInteract() runs. This is the drift being fixed.
      const old = await probe();
      assert.isTrue(old.assetsBefore.eq(old.cachedBefore), "deployed impl reports the cached formula");
      assert.isTrue(old.assetsAfter.eq(old.cachedAfter), "deployed impl after preInteract");
      assert.isFalse(old.assetsBefore.eq(old.assetsAfter), "deployed impl must lag here, or the case proves nothing");

      await useImpl(newImpl.address);
      const neu = await probe();
      console.log(`      deployed impl: ${ethers.utils.formatEther(old.assetsBefore)} -> ${ethers.utils.formatEther(old.assetsAfter)} on preInteract (drift ${bps(old.assetsBefore, old.assetsAfter)} bps)`);
      console.log(`      new impl:      ${ethers.utils.formatEther(neu.assetsBefore)} -> ${ethers.utils.formatEther(neu.assetsAfter)} (diff ${neu.assetsBefore.sub(neu.assetsAfter).toString()} wei), fee booked ${ethers.utils.formatEther(neu.feeBooked)}`);

      assert.isTrue(neu.cachedBefore.eq(old.cachedBefore), "both probes start from the same state");
      assert.equal(neu.assetsBefore.toString(), neu.assetsAfter.toString(), "live totalAssets() == totalAssets() after preInteract()");
      assert.equal(neu.assetsAfter.toString(), neu.cachedAfter.toString(), "after preInteract() the value is today's formula");
      if (sc.fee) {
        assert.isTrue(neu.feeBooked.gt(0), "fee branch exercised");
      } else {
        assert.isTrue(neu.feeBooked.eq(0), "no-gain branch exercised");
      }
    });
  }

  it("reports the totalAssets() gas cost of reading the position live", async function () {
    const gasOld = await ethers.provider.estimateGas({ to: VAULT, data: vault.interface.encodeFunctionData("totalAssets") });
    await useImpl(newImpl.address);
    const gasNew = await ethers.provider.estimateGas({ to: VAULT, data: vault.interface.encodeFunctionData("totalAssets") });
    console.log(`      totalAssets() gas: deployed ${gasOld}, new ${gasNew} (+${gasNew.sub(gasOld)})`);
    assert.isTrue(gasNew.lt(300_000), "still a cheap view (cold: oracle + both Aave balances)");
  });

  it("totalAssets() floors at zero instead of reverting when the fee exceeds the strategy's value", async function () {
    await send("hardhat_setStorageAt", [STRAT, PENDING_FEE_SLOT, pad32(ethers.utils.parseEther("1000000").toHexString())]);
    let oldReverted = false;
    try { await vault.totalAssets(); } catch (e) { oldReverted = true; }
    assert.isTrue(oldReverted, "deployed impl underflows");

    await useImpl(newImpl.address);
    const idle = await new ethers.Contract(WETH, ERC20, ethers.provider).balanceOf(VAULT);
    assert.equal((await vault.totalAssets()).toString(), idle.toString(), "strategy contributes 0, vault idle remains");
  });

  it("ships as a timelocked scheduleUpgrade: layout preserved, NAV continuous, deposit and redeem work", async function () {
    const g = await signer(gov);
    const getters = ["underlying", "vault", "supplyAsset", "supplyAToken", "borrowAToken", "rewardPool",
      "collateralFactorNumerator", "borrowTargetFactorNumerator", "fold", "slippageBps", "pendingFee", "governance"];
    const read = async () => Object.fromEntries(await Promise.all(getters.map(async (k) => [k, String(await strat[k]())])));

    await (await strat.connect(g).scheduleUpgrade(newImpl.address)).wait();
    await send("evm_increaseTime", [Number(await strat.nextImplementationDelay()) + 60]);
    await send("evm_mine");

    const before = await read();
    const truth = (await probe()).assetsAfter; // deployed impl's value once fees are accrued
    await (await new ethers.Contract(STRAT, ["function upgrade()"], g).upgrade()).wait();
    assert.equal(await implOf(), ethers.utils.getAddress(newImpl.address), "proxy upgraded");
    assert.deepEqual(await read(), before, "every keccak-slot getter reads the same after the upgrade");

    // The upgrade tx is one block later, so allow that block's interest (< 1e-6).
    const now = await vault.totalAssets();
    assert.isTrue(now.sub(truth).abs().mul(1_000_000).lte(truth), `NAV jumped across the upgrade: ${truth} -> ${now}`);
    const p = await probe();
    assert.equal(p.assetsBefore.toString(), p.assetsAfter.toString(), "live after the real upgrade");

    const amt = ethers.utils.parseEther("1");
    const u = await user.getAddress();
    const weth = new ethers.Contract(WETH, ERC20, user);
    await (await weth.deposit({ value: amt })).wait();
    await (await weth.approve(VAULT, amt)).wait();
    await (await vault.connect(user).deposit(amt, u, { gasLimit: 15_000_000 })).wait();
    const shares = await vault.balanceOf(u);
    assert.isTrue(shares.gt(0), "deposit minted shares");
    const w0 = await weth.balanceOf(u);
    await (await vault.connect(user).redeem(shares, u, u, { gasLimit: 15_000_000 })).wait();
    const got = (await weth.balanceOf(u)).sub(w0);
    console.log(`      1 WETH round trip returned ${ethers.utils.formatEther(got)} WETH`);
    assert.isTrue(got.gte(amt.mul(97).div(100)), "round trip within the known entry+exit cost");
    const after = await probe();
    assert.equal(after.assetsBefore.toString(), after.assetsAfter.toString(), "still live after deposit + redeem");
  });
});
