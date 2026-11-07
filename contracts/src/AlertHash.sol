// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  AlertHash
/// @notice The one place a string becomes a field-safe hash.
///
/// @dev    WHY THIS EXISTS AS A LIBRARY RATHER THAN AN INLINE keccak256.
///
///         A Groth16 public signal is an element of the BN254 scalar field, which is
///         about 254 bits. keccak256 produces 256. A full hash therefore cannot be a
///         public signal: it wraps, silently, and the circuit and the chain then disagree
///         about the value of the same string with no error anywhere.
///
///         So every hash crossing that boundary is truncated to 248 bits (31 bytes),
///         which is the convention zkEmail's own circuits use and leaves a comfortable
///         margin under the field modulus.
///
///         The danger is not the truncation. It is doing it in three places. If the
///         circuit masks and the escrow does not, the stored hash never matches and every
///         settlement reverts with `WrongAmount` on an amount that is perfectly correct.
///
///         The JavaScript half is `web/hash.js`, and the two are held together by
///         `test/CrossLanguageHash.t.sol`, which asserts vectors generated from that file
///         rather than from this one. This docblock previously named
///         `script/field-hash.mjs`, a file that does not exist in this repository and was
///         never written: a docblock can name a guard that has never existed, and reads
///         as though the seam were covered.
library AlertHash {
    /// 248 bits set. Anything above is discarded.
    uint256 internal constant FIELD_MASK = (uint256(1) << 248) - 1;

    /// @notice Field-safe hash of an arbitrary string.
    function fromString(string memory s) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(bytes(s))) & FIELD_MASK);
    }

    /// @notice Field-safe hash of raw bytes.
    function fromBytes(bytes memory b) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(b)) & FIELD_MASK);
    }

    /// @notice True if a value came out of a circuit without wrapping.
    /// @dev    Used by the adapter to reject a malformed proof rather than let a wrapped
    ///         value compare unequal later and surface as the wrong error.
    function isFieldSafe(uint256 v) internal pure returns (bool) {
        return v <= FIELD_MASK;
    }
}
