// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The Groth16 verifier zkEmail's registry deploys for a compiled blueprint.
/// @dev    Signature matches snarkjs' generated Solidity verifier. The escrow never
///         talks to this directly: `AlertProofAdapter` owns the mapping from raw
///         public signals to named fields, so a recompiled circuit changes one
///         contract rather than the one holding funds.
interface IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[4] calldata pubSignals
    ) external view returns (bool);
}

/// @notice What a verified Moniepoint debit alert tells the escrow.
///
/// @dev    Four values. The account holder's name, their full account number, their
///         balance and the counterparty's name all stay inside the proof. That is not a
///         nicety: a real Moniepoint alert prints the account number UNMASKED next to the
///         balance, and settling a ₦160,000 trade should not publish either.
struct AlertAttestation {
    /// Hash of the amount string exactly as the email prints it, e.g. "160,000.37".
    ///
    /// Hashed rather than parsed on purpose. Moniepoint prints thousands separators
    /// ("5,000.00"), and turning that into an integer inside a circuit is avoidable work
    /// with avoidable edge cases. The escrow only ever needs to answer "is this the
    /// agreed amount", which is a string comparison.
    bytes32 amountHash;
    /// Hash of the DKIM `d=` value. Always keccak("moniepoint.com") for this deployment.
    bytes32 bankDomainHash;
    /// Hash of the bank's own transaction reference. Spent once, forever.
    bytes32 nullifier;
    /// Hash of the destination account as the alert masks it, e.g. "*****52988".
    bytes32 recipientHash;
}

/// @notice Turns a raw proof into an `AlertAttestation`, or reverts.
///
/// @dev    Deliberately a separate contract from the escrow, and this is what makes a
///         second bank cheap. Moniepoint's regex, field labels and signal layout all
///         live here. Adding GTBank is a new blueprint and a new adapter; the contract
///         holding USDC never learns what a bank is.
interface IAlertVerifier {
    function verifyAlert(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[4] calldata pubSignals
    ) external view returns (AlertAttestation memory);

    /// @notice The single bank domain this verifier can ever attest to.
    /// @dev    Exposed so the escrow can refuse, at `open`, an escrow pinned to a bank
    ///         this deployment could never prove. Without it a seller can lock USDC
    ///         against a bank the verifier does not know, and that escrow is
    ///         unsettleable by construction: funds stuck until the deadline, with
    ///         nothing on chain saying why.
    function expectedBankDomainHash() external view returns (bytes32);
}
