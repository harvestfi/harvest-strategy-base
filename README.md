# Base Chain: Harvest Strategy Development

This [Hardhat](https://hardhat.org/) environment is configured to use Mainnet fork by default and provides templates and utilities for strategy development and testing.

## Installation

1. Run `npm install` to install all the dependencies.
2. Sign up on [Alchemy](https://dashboard.alchemyapi.io/signup/). We recommend using Alchemy over Infura to allow for a reproducible
Mainnet fork testing environment as well as efficiency due to caching.
3. Create a file `.env`, using the template given in `.env.template`.

## Run

All tests are located under the `test` folder.

1. Run `npx hardhat test [test file location]`: `npx hardhat test ./test/aerodrome/aero-usdc.js` (if for some reason the NodeJS heap runs out of memory, make sure to explicitly increase its size via `export NODE_OPTIONS=--max_old_space_size=4096`). This will produce the following output:
  ```
  Base Mainnet Aerodrome AERO-USDC
Impersonating...
0x6a74649aCFD7822ae8Fb78463a9f2192752E5Aa2
0x1902EcfC34A4D2289759AFF23f6F104BC9B8eD53
Fetching Underlying at:  0x2223F9FE624F69Da4D8256A7bCc9104FBA7F8f75
New Vault Deployed:  0xA545A0d87e9De570bD61c647FA34a1dDC0eF663f
Strategy Deployed:  0x7509532E32f0D19FC9F8288B3509548DA6737e45
    Happy path
loop  0
old shareprice:  1000000000000000000
new shareprice:  1000000012606906751
growth:  1.0000000126069069
instant APR: 0.005521825201082464 %
instant APY: 0.005521977238953646 %
loop  1
old shareprice:  1000000012606906751
new shareprice:  1000136838560105460
growth:  1.0001368259514738
instant APR: 59.92976674552253 %
instant APY: 81.99448683145197 %
loop  2
old shareprice:  1000136838560105460
new shareprice:  1000274298283974450
growth:  1.0001374409166517
instant APR: 60.1991214934392 %
instant APY: 82.48455088227541 %
loop  3
old shareprice:  1000274298283974450
new shareprice:  1000411779311201682
growth:  1.0001374433267587
instant APR: 60.20017712030645 %
instant APY: 82.48647407643934 %
loop  4
old shareprice:  1000411779311201682
new shareprice:  1000549278776658240
growth:  1.0001374428693264
instant APR: 60.19997676495281 %
instant APY: 82.48610905741667 %
loop  5
old shareprice:  1000549278776658240
new shareprice:  1000686796795039251
growth:  1.0001374425241196
instant APR: 60.199825564395404 %
instant APY: 82.48583359193947 %
loop  6
old shareprice:  1000686796795039251
new shareprice:  1000824333251821889
growth:  1.000137442062015
instant APR: 60.199623162590754 %
instant APY: 82.48546484586787 %
loop  7
old shareprice:  1000824333251821889
new shareprice:  1000961888147092113
growth:  1.000137441597591
instant APR: 60.199419744854765 %
instant APY: 82.48509424966875 %
loop  8
old shareprice:  1000961888147092113
new shareprice:  1001099461480936011
growth:  1.0001374411308492
instant APR: 60.19921531196548 %
instant APY: 82.48472180477077 %
loop  9
old shareprice:  1001099461480936011
new shareprice:  1001237053368049724
growth:  1.0001374407762742
instant APR: 60.199060008099714 %
instant APY: 82.4844388658119 %
earned!
APR: 60.21026979324024 %
APY: 82.50486243650539 %
      ✔ Farmer should earn money (10513ms)


  1 passing (15s)
  ```

## Develop

Under `contracts/strategies`, there are plenty of examples to choose from in the repository already, therefore, creating a strategy is no longer a complicated task. Copy-pasting existing strategies with minor modifications is acceptable.

Under `contracts/base`, there are existing base interfaces and contracts that can speed up development.

## Contribute

When ready, open a pull request with the following information:
1. Instructions on how to run the test and at which block number
2. A **mainnet fork test output** (like the one above in the README) clearly showing the increases of share price
3. Info about the protocol, including:
   - Live farm page(s)
   - GitHub link(s)
   - Etherscan link(s)
   - Start/end dates for rewards
   - Any limitations (e.g., maximum pool size)
   - Current pool sizes used for liquidation (to make sure they are not too shallow)

   The first few items can be omitted for well-known protocols (such as `curve.fi`).

5. A description of **potential value** for Harvest: why should your strategy be live? High APYs, decent pool sizes, longevity of rewards, well-secured protocols, high-potential collaborations, etc.

A more extensive checklist for assessing protocols and farming opportunities can be found [here](https://www.notion.so/harvestfinance/Farm-ops-check-list-7cd2e0d9da364252ac465cb8a176f0e0)

## Deployment

If your pull request is merged and given a green light for deployment, the Harvest team will take care of on-chain deployment.
