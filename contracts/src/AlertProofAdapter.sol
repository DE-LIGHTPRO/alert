// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAlertVerifier, IGroth16Verifier, AlertAttestation} from "./IAlertVerifier.sol";
import {AlertHash} from "./AlertHash.sol";

/// @title  AlertProofAdapter
/// @notice Owns the mapping from the circuit's raw public signals to named fields.
///
/// @dev    The public-signal ORDER is part of the circuit's identity, and nothing on
///         chain can detect getting it wrong. Swap signals 0 and 3 and every proof still
///         verifies perfectly: Groth16 only attests that the prover knew a witness for
///         these field elements, never what they are called. The failure then looks like
///         a user mistyping an amount.
///
///         So the layout lives here, in one contract, documented, with the escrow that
///         holds funds kept separate from it. Recompiling the circuit redeploys this and
///         leaves the custody contract alone. The same seam is what makes a second bank
///         a new adapter rather than a rewrite.
///
///         LAYOUT, which must match the blueprint's `Fields to Extract` order exactly:
///
///           pubSignals[0]  amountHash     hash of "5,000.00" as printed, commas and all
///           pubSignals[1]  bankDomainHash hash of the DKIM d= value
///           pubSignals[2]  nullifier      hash of the bank's transaction reference
///           pubSignals[3]  recipientHash  hash of "*****52988" as the alert masks it
contract AlertProofAdapter is IAlertVerifier {
    IGroth16Verifier public immutable groth16;

    /// @notice The only signing domain this adapter will attest to.
    /// @dev    Pinned at construction rather than passed in, so a caller cannot ask the
    ///         adapter to vouch for a domain the circuit was never compiled against.
    bytes32 public immutable expectedBankDomainHash;

    error ProofInvalid();
    error SignalNotFieldSafe(uint256 index);
    error UnexpectedBankDomain(bytes32 got, bytes32 expected);
    error ZeroNullifier();
    error ZeroAmountHash();

    constructor(IGroth16Verifier _groth16, string memory bankDomain) {
        groth16 = _groth16;
        expectedBankDomainHash = AlertHash.fromString(bankDomain);
    }

    /// @inheritdoc IAlertVerifier
    function verifyAlert(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[4] calldata pubSignals
    ) external view returns (AlertAttestation memory) {
        if (!groth16.verifyProof(pA, pB, pC, pubSignals)) revert ProofInvalid();

        // Every signal here is a 248-bit truncated hash. A value above that mask did not
        // come from `AlertHash`, and letting it through would surface later as "wrong
        // amount" on an amount that is perfectly correct.
        for (uint256 i = 0; i < 4; i++) {
            if (!AlertHash.isFieldSafe(pubSignals[i])) revert SignalNotFieldSafe(i);
        }

        bytes32 domainHash = bytes32(pubSignals[1]);
        if (domainHash != expectedBankDomainHash) {
            revert UnexpectedBankDomain(domainHash, expectedBankDomainHash);
        }

        // A zero nullifier is a SECURITY guard: it would be spendable exactly once
        // across ALL escrows, so the first use would brick every later settlement.
        if (pubSignals[2] == 0) revert ZeroNullifier();

        // A zero amount hash is a DIAGNOSTIC guard, and the distinction is worth making
        // rather than letting both read as protection. No escrow can hold a zero amount
        // hash (`AlertHash.fromString("")` is not zero, and `open` refuses the empty
        // string anyway), so without this the escrow would reject it one step later as
        // `WrongAmount`. The outcome is identical. What changes is the error: a circuit
        // emitting zero is a bug in the circuit, and saying so beats blaming the amount.
        //
        // A mutation test caught this being untested. It is pinned by
        // `test_settle_rejectsZeroAmountHash`, which asserts the error type, because
        // that error IS the whole value of the guard.
        if (pubSignals[0] == 0) revert ZeroAmountHash();

        return AlertAttestation({
            amountHash: bytes32(pubSignals[0]),
            bankDomainHash: domainHash,
            nullifier: bytes32(pubSignals[2]),
            recipientHash: bytes32(pubSignals[3])
        });
    }
}
