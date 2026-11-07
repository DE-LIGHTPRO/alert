// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AlertHash} from "../src/AlertHash.sol";

/// @title  Cross-language hash vectors
///
/// @dev    `AlertHash.fromString` here and `fieldHash` in web/app.js must agree on every
///         byte. If they ever disagree, `open` stores one value, the buyer's browser
///         computes another, and the UI tells someone their perfectly correct amount does
///         not match the escrow. Nothing errors. Nothing logs. The trade just cannot be
///         settled, and the cause is two functions that were each locally correct.
///
///         This is the recurring defect in the author's other projects, recorded as "two
///         variables, one decision": each half right, nothing wrong inside either, no
///         test looking across both.
///
///         WHERE THESE VECTORS ACTUALLY CAME FROM.
///
///         This said they were produced with `cast keccak` and verified in a browser, and
///         argued that being literal rather than recomputed is what lets them catch the
///         code being wrong. The second half is right and the first half undermines it:
///         `cast keccak` is Foundry's keccak, the same implementation solc uses, so the
///         vectors only ever confirmed Solidity against itself. The browser check was a
///         one-time manual act that left no artifact, and a later reader cannot tell it
///         happened.
///
///         All five inputs are now also in fixtures/field-hash-vectors.json, generated
///         from web/hash.js and asserted by CrossLanguageHash.t.sol, which is the test
///         that genuinely crosses the two languages. Re-checked 7 Nov 2026: every literal
///         below is reproduced byte for byte by the JavaScript. So the values were
///         correct all along; only the reason to believe them was missing.
///
///         They stay here as an independently written second copy. The generated fixture
///         would agree with a broken generator; these would not.
contract AlertHashTest is Test {
    function test_vectors_matchTheJavaScriptImplementation() public pure {
        // a naira figure with the per-escrow kobo tag
        assertEq(
            AlertHash.fromString("160,000.37"),
            bytes32(0x0079c837255432a920ceb640a944b69f95183d1322016fc9192257b93695069c)
        );
        // the amount exactly as a Moniepoint alert prints it
        assertEq(
            AlertHash.fromString("5,000.00"),
            bytes32(0x0017dd492dd00e146182b463f23cd7a0661bdf03175770820fb1837e44fd0985)
        );
        // the five digits the circuit extracts
        assertEq(
            AlertHash.fromString("52988"),
            bytes32(0x00ba2a7e64ae243bc0e0e9e404ce141d3963b552e55fbbad003e677051055eee)
        );
        // the masked form the escrow stores
        assertEq(
            AlertHash.fromString("*****52988"),
            bytes32(0x00d1a12e017aa9dcf60642c07cef4b8eb34bb10a41b2bea4352b773c9853bb3f)
        );
        // the bank domain the adapter pins
        assertEq(
            AlertHash.fromString("moniepoint.com"),
            bytes32(0x00e8193c4dd042bcd6cf94290e9acc7e310a38b00f7d7a55647a2545a73262ed)
        );
    }

    /// @dev The whole point of the mask. A full keccak256 exceeds the BN254 scalar field
    ///      and would wrap as a public signal, so the top byte must always be clear.
    function testFuzz_isAlwaysFieldSafe(string calldata s) public pure {
        bytes32 h = AlertHash.fromString(s);
        assertTrue(AlertHash.isFieldSafe(uint256(h)), "hash exceeded the field mask");
        assertEq(uint8(h[0]), 0, "top byte must be clear");
    }

    /// @dev Truncation must not be so aggressive that collisions become findable. 248
    ///      bits leaves 2^124 birthday security, which is ample; this pins that the mask
    ///      was not "simplified" to something smaller later.
    function test_maskIs248Bits() public pure {
        assertEq(AlertHash.FIELD_MASK, (uint256(1) << 248) - 1);
    }

    function test_differentStringsDiffer() public pure {
        assertTrue(AlertHash.fromString("160,000.37") != AlertHash.fromString("160,000.38"));
        assertTrue(AlertHash.fromString("160,000.37") != AlertHash.fromString("160000.37"));
    }
}
