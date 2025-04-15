// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

/// @title ConstantsLib
/// @author Harvest Community Foundation
/// @notice Library exposing constants in the MorphoLoopingStrategy(MLS).
library MLSConstantsLib {
    /// @dev The address of the WETH token.
    address internal constant WETH = address(0x4200000000000000000000000000000000000006);

    /// @dev The address of the Balancer bVault.
    address internal constant BVAULT = address(0xBA12222222228d8Ba445958a75a0704d566BF2C8);

    /// @dev The address of the Harvest multisig.
    address internal constant HARVEST_MSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);

    /* MORPHO */

    /// @dev The address of the Morpho Blue contract.
    address internal constant MORPHO_BLUE = address(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);

    /// @dev The slot of the loan token.
    bytes32 internal constant LOAN_TOKEN_SLOT = 0x7ce29ca599ec4a5f9fb8fb07213532368fc685cbc286b763d4cfaf236287c015;

    /// @dev The slot of the oracle.
    bytes32 internal constant ORACLE_SLOT = 0xa9fe60782b14a01d25885c070d2fff6c0854cc3765300f7c79a8e8b9792c55bb;

    /// @dev The slot of the IRM(Interest Rate Models).
    bytes32 internal constant IRM_SLOT = 0xf506d3a83fcfb2893f5b546f4c872321227a32e7cd6dd056b03f999d33e3c982;

    /// @dev The slot of the LLTV(Liq. Loan-To-Value).
    bytes32 internal constant LLTV_SLOT = 0x3026ff2a3e1d5bc232fbed88c368457106225b498851d320cb4714f4c01a49aa;

    /// @dev The slot of the loop mode.
    bytes32 internal constant LOOP_MODE_SLOT = 0x7fde0c8fed0c67e0aad5548621b7c8c40b238d07cad6735de9a5bffe464c79f6;

    /// @dev The slot of the morpho pre pay.
    bytes32 internal constant MORPHO_PRE_PAY_SLOT = 0x15ef0a518c284159ce00448aabf99b63238d88ae2c512063daf55e149525d49d;

    /* MOONWELL */

    /// @dev The slot of the mToken.
    bytes32 internal constant MTOKEN_SLOT = 0x21e6ad38ea5ca89af03560d16f1da9e505dccbd1ec61d0683be425888164fec3;

    /// @dev The slot of the collateral factor numerator.
    bytes32 internal constant COLLATERALFACTORNUMERATOR_SLOT =
        0x129eccdfbcf3761d8e2f66393221fa8277b7623ad13ed7693a0025435931c64a;

    /// @dev The slot of the factor denominator.
    bytes32 internal constant FACTORDENOMINATOR_SLOT =
        0x4e92df66cc717205e8df80bec55fc1429f703d590a2d456b97b74f0008b4a3ee;

    /// @dev The slot of the borrow target factor numerator.
    bytes32 internal constant BORROWTARGETFACTORNUMERATOR_SLOT =
        0xa65533f4b41f3786d877c8fdd4ae6d27ada84e1d9c62ea3aca309e9aa03af1cd;
}
