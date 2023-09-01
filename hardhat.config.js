require("@nomiclabs/hardhat-etherscan");
require("@nomiclabs/hardhat-truffle5");
require("@nomiclabs/hardhat-web3");
require("@nomiclabs/hardhat-ethers");

const secret = require('./dev-keys.json');

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      accounts: {
        mnemonic: secret.mnemonic,
      },
      chainId: 8453,
      forking: {
        url: `https://base-mainnet.g.alchemy.com/v2/${secret.alchemyKey}`,
        blockNumber: 3360500, // <-- edit here
      },
    },
    mainnet: {
      url: `https://base-mainnet.g.alchemy.com/v2/${secret.alchemyKey}`,
      accounts: {
        mnemonic: secret.mnemonic,
      },
    },
  },
  solidity: {
    compilers: [
      {
        version: "0.6.12",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    ],
  },
  mocha: {
    timeout: 2000000
  },
  etherscan: {
    apiKey: {
      base: secret.etherscanAPI,
    },
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.com"
        }
      }
    ]
  },
};
