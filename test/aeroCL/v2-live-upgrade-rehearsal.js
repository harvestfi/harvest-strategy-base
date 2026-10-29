// Rehearse the ACTUAL upgrade the live AAPLc vaults need: from the deployed implementation
// (0x9D5D35E4…, which still has the 50/50 compound bug) to the current build.
//
// The existing upgrade test deploys a fresh copy of the SAME code, so it proves the mechanism but
// not layout compatibility across a real code change. This upgrades a LIVE proxy against forked
// mainnet state and checks every storage-backed read survives.
//
// Note the AAPLc token cannot execute on a fork (its on-chain code is the single byte 0xef), so
// this deliberately touches only reads that do not call into it.
const { impersonates } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");
const Strategy = artifacts.require("AerodromeCLStrategyV2");
const StrategyProxy = artifacts.require("StrategyProxy");
const CLRebalanceLibV2 = artifacts.require("CLRebalanceLibV2");
const BN = web3.utils.toBN;
const assert = require("assert");

const LIVE = [
  ["w240", "0x17AC5f9f53B3d6a05516Fb664d5c9b7FC196fcd2"],
  ["w120", "0x6643fb9800095B543eDa1668bb8e4C322eFd0eb1"],
  ["w60",  "0x1e9917422e2deB862e7ff2c15Ba872186EbFF61e"],
];
const DEPLOYED_IMPL = "0x9D5D35E4822E856a8c2B5349a5E8aD60bEf53F49";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

describe("live strategy upgrade rehearsal (USDC/AAPLc)", function () {
  this.timeout(3600000);
  let gov, newImpl;

  before(async () => {
    // This suite upgrades the LIVE proxies, so it needs a fork at or after their deploy. The
    // repo's pinned FORK_BLOCK predates them, and a stale pin shows up as a bare "no code at
    // address" — reset to head so the rehearsal always runs against current mainnet state.
    await hre.network.provider.request({ method: "hardhat_reset", params: [{
      forking: { jsonRpcUrl: hre.network.config.forking.url },
    }] });
    for (const [label, addr] of LIVE) {
      assert.notEqual(await web3.eth.getCode(addr), "0x", `premise: ${label} proxy ${addr} must exist on the fork`);
    }
    gov = addresses.Governance;
    await impersonates([gov]);
    await hre.network.provider.request({ method: "hardhat_setBalance", params: [gov, "0x21E19E0C9BAB2400000"] });
    // Prefer rehearsing the ACTUAL deployed implementation when one is given — a locally-built
    // copy proves the storage layout but not that the address governance will schedule is the
    // build we tested. With REHEARSE_IMPL set this becomes a check on the real artifact.
    if (process.env.REHEARSE_IMPL) {
      newImpl = { address: process.env.REHEARSE_IMPL };
      assert.notEqual(await web3.eth.getCode(newImpl.address), "0x",
        `premise: REHEARSE_IMPL ${newImpl.address} must have code on the fork`);
      assert.notEqual(newImpl.address.toLowerCase(), DEPLOYED_IMPL.toLowerCase(),
        "premise: rehearsing the impl already live would prove nothing");
    } else {
      const lib = await CLRebalanceLibV2.new({ from: gov });
      await Strategy.link(lib);
      newImpl = await Strategy.new({ from: gov });
    }
    console.log(`      new implementation ${newImpl.address}`);
    console.log(`      replacing          ${DEPLOYED_IMPL}`);
  });

  for (const [label, proxyAddr] of LIVE) {
    it(`${label}: upgrades in place with all state preserved`, async () => {
      const s = await Strategy.at(proxyAddr);
      const before = {
        vault: await s.vault(),
        gauge: await s.rewardPool(),
        rewardToken: await s.rewardToken(),
        controller: await s.controller(),
        governance: await s.governance(),
        unprocessedReward: (await s.unprocessedReward()).toString(),
        harvestPaused: await s.harvestPaused(),
        withdrawOnlyMode: await s.withdrawOnlyMode(),
        swapSkippedCount: (await s.swapSkippedCount()).toString(),
        lastSwapSkippedAt: (await s.lastSwapSkippedAt()).toString(),
        maxSlippageBps: (await s.maxSlippageBps()).toString(),
        minReward: (await s.minRewardToCompound(await s.rewardToken())).toString(),
        posId: (await s.posId()).toString(),
        bufferPosId: (await s.bufferPosId()).toString(),
        sell: await s.sell(),
      };
      const implBefore = "0x" + (await web3.eth.getStorageAt(proxyAddr, IMPL_SLOT)).slice(26);
      assert.equal(implBefore.toLowerCase(), DEPLOYED_IMPL.toLowerCase(), "premise: proxy must start on the deployed impl");

      await s.scheduleUpgrade(newImpl.address, { from: gov });
      const delay = Number((await s.nextImplementationTimestamp()).toString()) - Math.floor(Date.now() / 1000);
      await hre.network.provider.send("evm_increaseTime", [Math.max(delay, 0) + 3600]);
      await hre.network.provider.send("evm_mine");
      await (await StrategyProxy.at(proxyAddr)).upgrade({ from: gov });

      const implAfter = "0x" + (await web3.eth.getStorageAt(proxyAddr, IMPL_SLOT)).slice(26);
      assert.equal(implAfter.toLowerCase(), newImpl.address.toLowerCase(), "implementation must have changed");

      const after = {
        vault: await s.vault(), gauge: await s.rewardPool(), rewardToken: await s.rewardToken(),
        controller: await s.controller(), governance: await s.governance(),
        unprocessedReward: (await s.unprocessedReward()).toString(),
        harvestPaused: await s.harvestPaused(), withdrawOnlyMode: await s.withdrawOnlyMode(),
        swapSkippedCount: (await s.swapSkippedCount()).toString(),
        lastSwapSkippedAt: (await s.lastSwapSkippedAt()).toString(),
        maxSlippageBps: (await s.maxSlippageBps()).toString(),
        minReward: (await s.minRewardToCompound(await s.rewardToken())).toString(),
        posId: (await s.posId()).toString(), bufferPosId: (await s.bufferPosId()).toString(),
        sell: await s.sell(),
      };
      const drift = Object.keys(before).filter(k => String(before[k]) !== String(after[k]));
      console.log(`      ${label}: impl ${implBefore.slice(0,10)}… -> ${implAfter.slice(0,10)}…; ${drift.length} fields drifted`);
      if (drift.length) console.log(`      DRIFT: ${drift.map(k => `${k} ${before[k]} -> ${after[k]}`).join(" | ")}`);
      assert.deepEqual(drift, [], "no storage-backed value may change across the upgrade");
      // and the new logic is actually reachable through the proxy
      assert.equal((await s.bufferPosId()).toString(), before.bufferPosId, "buffer id still resolves post-upgrade");
    });
  }
});
