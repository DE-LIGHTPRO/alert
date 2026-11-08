// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAlertVerifier, IGroth16Verifier, AlertAttestation} from "./IAlertVerifier.sol";
import {AlertHash} from "./AlertHash.sol";
import {AlertPack} from "./AlertPack.sol";

/// @title  AlertProofAdapter
/// @notice Turns a Groth16 proof into named, hashed facts the escrow can compare.
///
/// @dev    WHAT THIS CONTRACT IS FOR.
///
///         The public-signal LAYOUT is part of the circuit's identity and nothing on
///         chain can detect getting it wrong. Groth16 attests that the prover knew a
///         witness for these field elements, never what they are called. Swap two fields
///         and every proof still verifies perfectly; the failure surfaces later as a
///         user apparently mistyping an amount.
///
///         So the layout lives here, alone, and the contract holding USDC never learns
///         what a bank is. Recompiling the circuit redeploys this and leaves custody
///         untouched. The same seam is what makes a second bank a new adapter rather
///         than a rewrite.
///
///         WHAT CHANGED, AND WHY THE PREVIOUS VERSION COULD NOT HAVE WORKED.
///
///         It read each signal as though it were already a hash. A circuit does not emit
///         hashes; it emits the field's BYTES, packed 31 to a field element. The 60-char
///         MIME boundary used as the nullifier spans three signals. Treating signal[2] as
///         the whole nullifier would have hashed the first 31 bytes of it and silently
///         compared unequal to everything.
///
///         THE LAYOUT BELOW IS PREDICTED, NOT MEASURED.
///
///         It follows from each field's max_length and the 31-byte packing rule, worked
///         out in docs/blueprint-spec.md section 6. The compiled verifier states its own
///         array size in its verifyProof signature; that is the authority. When it
///         lands, check SIGNAL_COUNT and the four offsets against it before anything
///         else. Every one of them is a constant here for exactly that reason.
contract AlertProofAdapter is IAlertVerifier {
    using AlertPack for uint256[];

    // ---------------------------------------------------------------- layout
    //
    // field          max_length   signals   offset
    // email_sender          64          3        0
    // amount                16          1        3
    // nullifier             64          3        4
    // recipient              8          1        7
    // DKIM key hash                     1        8
    //                                   ─
    //                                   9
    uint256 internal constant AMOUNT_AT = 0;
    uint256 internal constant AMOUNT_N = 1;
    uint256 internal constant NULLIFIER_AT = 1;
    uint256 internal constant NULLIFIER_N = 2;
    uint256 internal constant RECIPIENT_AT = 3;
    uint256 internal constant RECIPIENT_N = 1;

    /// @notice How many public signals the compiled circuit emits.
    /// @dev    Predicted. Check against the generated verifier and change here if wrong.
    uint256 public constant SIGNAL_COUNT = 5;

    IGroth16Verifier public immutable groth16;

    /// @notice The bank domain, for the escrow's own `open` check.
    bytes32 public immutable expectedBankDomainHash;

    error ProofInvalid();
    error EmptyField(string which);

    constructor(IGroth16Verifier _groth16, string memory bankDomain) {
        groth16 = _groth16;
        expectedBankDomainHash = AlertHash.fromString(bankDomain);
    }

    /// @inheritdoc IAlertVerifier
    function verifyAlert(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[SIGNAL_COUNT] calldata pubSignals
    ) external view returns (AlertAttestation memory) {
        if (!groth16.verifyProof(pA, pB, pC, pubSignals)) revert ProofInvalid();

        uint256[] memory s = new uint256[](SIGNAL_COUNT);
        for (uint256 i = 0; i < SIGNAL_COUNT; i++) s[i] = pubSignals[i];

        bytes memory amount = AlertPack.unpackSlice(s, AMOUNT_AT, AMOUNT_N);
        bytes memory nullifier = AlertPack.unpackSlice(s, NULLIFIER_AT, NULLIFIER_N);
        bytes memory recipient = AlertPack.unpackSlice(s, RECIPIENT_AT, RECIPIENT_N);

        // An empty field means the circuit matched nothing where it should have matched
        // something. Downstream that becomes a hash of "", which compares unequal and
        // surfaces as the wrong error entirely. Name it here instead.
        if (amount.length == 0) revert EmptyField("amount");
        if (nullifier.length == 0) revert EmptyField("nullifier");
        if (recipient.length == 0) revert EmptyField("recipient");

        return AlertAttestation({
            amountHash: AlertHash.fromBytes(amount),
            bankDomainHash: expectedBankDomainHash,
            nullifier: AlertHash.fromBytes(nullifier),
            recipientHash: AlertHash.fromBytes(recipient)
        });
    }
}
