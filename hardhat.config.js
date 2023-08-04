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
        // url: `https://damp-light-sheet.base-mainnet.discover.quiknode.pro/1dd5b147969e3eb19f572b39b3f4b587fdc8629d`,
        url: `https://developer-access-mainnet.base.org`,
        blockNumber: 2185300, // <-- edit here
      },
    },
    mainnet: {
      // url: `https://damp-light-sheet.base-mainnet.discover.quiknode.pro/1dd5b147969e3eb19f572b39b3f4b587fdc8629d`,
      url: `https://developer-access-mainnet.base.org`,
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
