// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

/// @title ErrorsLib
/// @author Harvest Community Foundation
/// @notice Library exposing error messages.
library ErrorsLib {
    /* MORPHO */

    /// @notice Error message for when the loan token slot is not correct.
    error LOAN_TOKEN_SLOT_NOT_CORRECT();

    /// @notice Error message for when the oracle slot is not correct.
    error ORACLE_SLOT_NOT_CORRECT();

    /// @notice Error message for when the IRM slot is not correct.
    error IRM_SLOT_NOT_CORRECT();

    /// @notice Error message for when the LLTV slot is not correct.
    error LLTV_SLOT_NOT_CORRECT();

    /// @notice Error message for when the loop mode slot is not correct.
    error LOOP_MODE_SLOT_NOT_CORRECT();

    /// @notice Error message for when the morpho pre pay slot is not correct.
    error MORPHO_PRE_PAY_SLOT_NOT_CORRECT();

    /* FLASH LOAN */

    /// @notice Error message for when the flash loan caller is invalid.
    error INVALID_FLASH_LOAN_CALLER();

    /// @notice Error message for when the flash loan is already in progress.
    error FLASH_LOAN_ALREADY_IN_PROGRESS();

    /// @notice Error message for when the flash loan is not in progress.
    error FLASH_LOAN_NOT_IN_PROGRESS();

    /* MOONWELL */

    /// @notice Error message for when the mToken slot is not correct.
    error MTOKEN_SLOT_NOT_CORRECT();

    /// @notice Error message for when the collateral factor numerator slot is not correct.
    error COLLATERALFACTORNUMERATOR_SLOT_NOT_CORRECT();

    /// @notice Error message for when the factor denominator slot is not correct.
    error FACTORDENOMINATOR_SLOT_NOT_CORRECT();

    /// @notice Error message for when the borrow target factor numerator slot is not correct.
    error BORROWTARGETFACTORNUMERATOR_SLOT_NOT_CORRECT();

    /* UTILS */

    /// @notice Error message for when the token is not salvagable.
    error TokenNotSalvagable(address token);
}
