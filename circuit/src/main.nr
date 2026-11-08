// Does a real Moniepoint alert produce a proof, locally, with no registry involved?
//
// WHY THIS CIRCUIT IS SMALLER THAN THE PRODUCT NEEDS.
//
// The zkEmail registry failed to compile this project's blueprint twice: v1 with four
// extracted fields ran 50 minutes and died, v2 with three ran 17. A smaller circuit
// dying sooner is what stopped the size theory, and pointed at the service instead.
//
// So this proves the one thing that does not depend on the registry at all: that an
// email carrying a valid DKIM signature from moniepoint.com exists, and gives it a
// unique nullifier. No field extraction, no body, no regex. Verifying the signature
// over the header is ~86,553 constraints; the upstream example that also hashes the
// body is ~222,783, and the extraction circuits are what kept failing.
//
// WHAT IT PROVES AND WHAT IT DOES NOT.
//
// It proves authenticity and uniqueness: Moniepoint's mail provider signed this exact
// message, and it cannot be replayed. It does NOT prove the amount or the destination
// account, so it cannot settle an escrow on its own. The escrow still needs the
// extracting circuit. This is evidence that the cryptography works on a real alert from
// a real Nigerian bank, produced on a laptop, which is the claim the failed compiles
// left unsupported.
use zkemail::{dkim::RSAPubkey, KEY_LIMBS_2048};
use std::hash::pedersen_hash;

// Moniepoint's headers measured at 960 bytes in docs/blueprint-spec.md; 1024 is the
// next power of two above that and costs nothing we are short of.
global MAX_EMAIL_HEADER_LENGTH: u32 = 1024;

/**
 * @param header   the email header, zero-padded to MAX_EMAIL_HEADER_LENGTH
 * @param pubkey   the DKIM RSA modulus and Barrett reduction parameter
 * @param signature the DKIM RSA signature
 * @return 0: Poseidon hash of the pubkey modulus, the root of trust
 *         1: Poseidon hash of the redc parameter
 *         2: Pedersen hash of the signature, a per-email nullifier
 */
fn main(
    header: BoundedVec<u8, MAX_EMAIL_HEADER_LENGTH>,
    pubkey: RSAPubkey<KEY_LIMBS_2048>,
    signature: [Field; KEY_LIMBS_2048],
) -> pub [Field; 3] {
    assert(header.len() <= MAX_EMAIL_HEADER_LENGTH);

    // The whole claim: this header carries a signature valid under that key.
    pubkey.verify_dkim_signature(header, signature);

    // hash(signature) is unique per message and reveals nothing about its contents.
    // Cleaner than the MIME boundary the registry blueprint had to use, which only
    // existed because the narration line could not carry a per-trade reference.
    let nullifier = pedersen_hash(signature);

    [pubkey.hash(), nullifier, nullifier]
}
