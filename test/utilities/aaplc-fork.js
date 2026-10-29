// Install a working ERC20 at AAPLc's address on a fork.
//
// AAPLc (0xb200…d1fb) is a system-level contract on Base: `eth_getCode` returns the single byte
// 0xef, but the live node executes balanceOf/transfer normally. A fork copies the stub, so every
// call traps — which is why the USDC/AAPLc pair was previously untestable and the three live V2
// vaults had no functional coverage at all.
//
// `hardhat_setCode` swaps in MockNamespacedERC20. Because setCode preserves the address's existing
// storage and the real layout is unknown, the mock namespaces every slot, so all balances start at
// zero. Balances are then seeded from the REAL chain state, read via a direct RPC call at the fork
// block rather than assumed — the pool cannot pay out a swap or a burn without them.
const AAPLC = "0xb200000000000000000000c2e324d24d7eecd1fb";
const Mock = artifacts.require("MockNamespacedERC20");

const sel = s => web3.utils.keccak256(s).slice(0, 10);
const pad = a => "000000000000000000000000" + a.slice(2).toLowerCase();

async function liveBalance(url, token, holder, blockTag) {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: token, data: sel("balanceOf(address)") + pad(holder) }, blockTag] }),
  });
  const j = await res.json();
  if (!j.result) throw new Error(`live balanceOf failed: ${JSON.stringify(j.error)}`);
  return web3.utils.toBN(j.result);
}

/// Install the mock and seed `holders` with the balances they hold on the real chain.
/// `extraMint` credits additional addresses (test users) that hold nothing on-chain.
/// `token` defaults to AAPLc; the other 0xb2… tokenized equities (GOOGLc/METAc/NVDAc) behave
/// identically and are installed the same way.
async function installAaplc({ from, holders = [], extraMint = [], token = AAPLC, decimals = 8 }) {
  const url = hre.network.config.forking.url;
  const blockTag = "0x" + (await web3.eth.getBlockNumber()).toString(16);

  // Read live balances BEFORE swapping the code in — afterwards the real balances are unreachable.
  const seeded = [];
  for (const h of holders) seeded.push([h, await liveBalance(url, token, h, blockTag)]);

  const impl = await Mock.new({ from });
  const code = await web3.eth.getCode(impl.address);
  await hre.network.provider.request({ method: "hardhat_setCode", params: [token, code] });

  const t = await Mock.at(token);
  await t.initMock(decimals, { from });
  if ((await t.decimals()).toString() !== String(decimals)) throw new Error("mock install failed: decimals");

  for (const [h, bal] of seeded) if (!bal.isZero()) await t.mint(h, bal, { from });
  for (const [h, amt] of extraMint) await t.mint(h, amt, { from });

  return { token: t, seeded };
}

/// Give `holder` an exact ERC20 balance by writing the balances mapping directly.
///
/// Depending on a whale is fragile — the balance moves between fork blocks and the failure looks
/// like a logic bug ("transfer amount exceeds balance") rather than a missing fixture. This probes
/// candidate slots until `balanceOf` actually reports the target, so it either works or says so,
/// and restores any slot it touched but did not use.
async function setTokenBalance(token, holder, amount, { maxSlot = 20 } = {}) {
  const erc20 = await artifacts.require("IERC20Upgradeable").at(token);
  const target = web3.utils.toBN(amount);
  const want = "0x" + target.toString(16).padStart(64, "0");
  for (let slot = 0; slot <= maxSlot; slot++) {
    const key = web3.utils.keccak256(
      web3.eth.abi.encodeParameters(["address", "uint256"], [holder, slot]),
    );
    const prev = await hre.network.provider.request({ method: "eth_getStorageAt", params: [token, key, "latest"] });
    await hre.network.provider.request({ method: "hardhat_setStorageAt", params: [token, key, want] });
    if (web3.utils.toBN(await erc20.balanceOf(holder)).eq(target)) return slot;
    await hre.network.provider.request({ method: "hardhat_setStorageAt", params: [token, key, prev] });
  }
  throw new Error(`setTokenBalance: no balances slot found for ${token} within 0..${maxSlot}`);
}

module.exports = { AAPLC, installAaplc, liveBalance, setTokenBalance };
