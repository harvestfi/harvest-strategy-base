// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./VaultProxy.sol";
import "./upgradability/StrategyProxy.sol";

interface ICLVaultInit {
    function initializeVault(
        address _storage,
        uint256 _stakedPosId,
        uint256 _bufferPosId,
        address _posManager,
        uint256 _targetWidth,
        uint256 _targetStakedBps,
        uint256 _bandBps,
        uint256 _windowSafety
    ) external;
}

interface IStrategyInit {
    function initializeBaseStrategy(
        address _storage,
        address _vault,
        address _rewardPool,
        address _rewardToken
    ) external;
}

interface IERC721Min {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function approve(address to, uint256 tokenId) external;
}

/// @notice Deploys a CLVaultV2 / AerodromeCLStrategyV2 proxy AND initializes it in ONE transaction.
///
/// Deploying the proxy and initializing it as two transactions leaves the proxy sitting on-chain,
/// uninitialized and public, for at least one block. `initializeVault` and `initializeBaseStrategy`
/// are both `initializer`-guarded but otherwise permissionless, so anyone can call them first with
/// their own storage (and, for the vault, their own position ids or a fake position manager). That
/// does not steal the seeds — `initializeVault` pulls the NFTs from `msg.sender`, so a front-runner
/// can only ever contribute their own — but it burns the proxy permanently and forces a redeploy.
/// On Base this needs no mempool access at all: the proxy's creation is public the moment it lands,
/// and the attacker simply takes the next block.
///
/// Doing both in one transaction removes the window entirely: the proxy address does not exist until
/// the transaction that also initializes it.
///
/// Stateless and ownerless by design — it holds nothing between calls, so a standing ERC721 approval
/// to it grants no lasting power beyond the transaction it is used in.
contract CLProxyDeployer {
    event VaultDeployed(address indexed vault, address indexed deployer, uint256 shares);
    event StrategyDeployed(address indexed strategy, address indexed vault);

    /// @param stakedPosId / bufferPosId must be owned by the caller and approved to THIS contract.
    /// @return vault the initialized vault proxy. The caller receives the seed shares.
    function deployVault(
        address vaultImpl,
        address storage_,
        uint256 stakedPosId,
        uint256 bufferPosId,
        address posManager,
        uint256 targetWidth,
        uint256 targetStakedBps,
        uint256 bandBps,
        uint256 windowSafety
    ) external returns (address vault) {
        // Take custody first: initializeVault pulls the NFTs from ITS msg.sender, which is this
        // contract, so they have to be here before the call rather than in the caller's wallet.
        IERC721Min(posManager).transferFrom(msg.sender, address(this), stakedPosId);
        IERC721Min(posManager).transferFrom(msg.sender, address(this), bufferPosId);

        vault = address(new VaultProxy(vaultImpl));

        IERC721Min(posManager).approve(vault, stakedPosId);
        IERC721Min(posManager).approve(vault, bufferPosId);
        ICLVaultInit(vault).initializeVault(
            storage_, stakedPosId, bufferPosId, posManager,
            targetWidth, targetStakedBps, bandBps, windowSafety
        );

        // initializeVault mints the seed shares to its msg.sender — this contract. Forward them, or
        // the whole seed position would be owned by a stateless helper that cannot withdraw it.
        uint256 shares = IERC20(vault).balanceOf(address(this));
        require(shares > 0, "CLProxyDeployer: no shares minted");
        require(IERC20(vault).transfer(msg.sender, shares), "CLProxyDeployer: share transfer failed");

        emit VaultDeployed(vault, msg.sender, shares);
    }

    function deployStrategy(
        address strategyImpl,
        address storage_,
        address vault,
        address rewardPool,
        address rewardToken
    ) external returns (address strategy) {
        strategy = address(new StrategyProxy(strategyImpl));
        IStrategyInit(strategy).initializeBaseStrategy(storage_, vault, rewardPool, rewardToken);
        emit StrategyDeployed(strategy, vault);
    }
}
