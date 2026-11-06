// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  AlertPack
/// @notice Rebuilds a string from the field elements a zkEmail circuit emits.
///
/// @dev    WHY THIS IS NEEDED, AND WHY IT IS NOT OBVIOUS.
///
///         The adapter was written as though each extracted field arrived as one public
///         signal holding a hash. It does not. A circuit emits the field's BYTES, packed
///         31 at a time into BN254 field elements, first byte in the least significant
///         position. So the 60-character MIME boundary used as the nullifier arrives as
///         three signals, and reassembling them is the contract's job before it can hash
///         anything.
///
///         Getting the direction wrong is the dangerous failure here. Reading the bytes
///         big-endian produces a perfectly valid string that is simply reversed, hashes
///         to something stable, and compares unequal forever. Nothing errors. The trade
///         just never settles, and the cause looks like a user mistyping an amount.
///
///         So the vectors in AlertPack.t.sol are generated from the packing rule
///         independently, not derived by running this code.
library AlertPack {
    /// Bytes carried by one field element. 31, not 32, because a BN254 element is
    /// slightly under 256 bits and a full 32 bytes could exceed the modulus.
    uint256 internal constant BYTES_PER_SIGNAL = 31;

    error TooManySignals();

    /// @notice Reassembles packed signals into the original bytes.
    /// @dev    Trailing zero bytes are padding from the circuit's fixed-width field and
    ///         are dropped. A zero byte cannot appear inside any field this project
    ///         extracts: amounts, hex boundaries, digits and email addresses are all
    ///         printable ASCII.
    function unpack(uint256[] memory signals) internal pure returns (bytes memory out) {
        uint256 n = signals.length;
        if (n > 64) revert TooManySignals(); // nothing here is remotely that long

        bytes memory buf = new bytes(n * BYTES_PER_SIGNAL);
        uint256 len = 0;

        for (uint256 i = 0; i < n; i++) {
            uint256 v = signals[i];
            for (uint256 j = 0; j < BYTES_PER_SIGNAL; j++) {
                // First byte of the chunk sits in the lowest-order position.
                bytes1 b = bytes1(uint8(v >> (8 * j)));
                buf[i * BYTES_PER_SIGNAL + j] = b;
                if (b != 0) len = i * BYTES_PER_SIGNAL + j + 1;
            }
        }

        out = new bytes(len);
        for (uint256 k = 0; k < len; k++) out[k] = buf[k];
    }

    /// @notice Convenience for the common case: unpack a slice of a signal array.
    /// @param  signals the full public-signal array from the proof
    /// @param  start   index of this field's first signal
    /// @param  count   how many signals this field occupies
    function unpackSlice(uint256[] memory signals, uint256 start, uint256 count)
        internal
        pure
        returns (bytes memory)
    {
        uint256[] memory part = new uint256[](count);
        for (uint256 i = 0; i < count; i++) part[i] = signals[start + i];
        return unpack(part);
    }

    /// @notice How many signals a field of `maxLength` bytes occupies.
    /// @dev    The same arithmetic docs/blueprint-spec.md uses to predict the array size,
    ///         kept here so the two cannot drift.
    function signalsFor(uint256 maxLength) internal pure returns (uint256) {
        return (maxLength + BYTES_PER_SIGNAL - 1) / BYTES_PER_SIGNAL;
    }
}
