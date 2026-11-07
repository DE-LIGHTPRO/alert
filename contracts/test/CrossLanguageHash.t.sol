// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AlertHash} from "../src/AlertHash.sol";

/// @title  CrossLanguageHash
/// @notice Asserts the page and the contract hash a string to the same field element.
///
/// @dev    THE SEAM THIS COVERS, AND WHY NOTHING ELSE COULD.
///
///         Three implementations truncate a keccak256 to 248 bits: the circuit,
///         AlertHash.sol, and web/hash.js. A disagreement between any two raises no
///         error anywhere. `open` stores a hash the proof can never produce, and the
///         settlement reverts with WrongAmount on an amount that is perfectly correct —
///         a seller watching a buyer's correct payment get refused.
///
///         Every existing test lived inside one language. AlertHash.t.sol asserts the
///         mask equals 2^248 - 1, which is true of any self-consistent implementation and
///         says nothing about the other two.
///
///         WHY THE VECTORS ARE NOT GENERATED HERE.
///
///         They come from scripts/gen-field-hash-vectors.mjs, which imports the page's
///         own web/hash.js. Generating them with Solidity and asserting them in Solidity
///         would pass no matter what either side did: exactly the tautology that
///         script/Deploy.s.sol's `require(adapter.expectedBankDomainHash() == hash(...))`
///         was, a line that read as a safety check and could not fail.
///
///         CI regenerates the fixture and fails on a diff, so JavaScript cannot drift
///         alone either. The circuit is the one side still unchecked, because it has not
///         finished compiling; see docs/blueprint-spec.md section 6.
contract CrossLanguageHashTest is Test {
    string constant FIXTURE = "../fixtures/field-hash-vectors.json";

    function _json() internal view returns (string memory) {
        string memory json = vm.readFile(FIXTURE);
        require(bytes(json).length > 0, "fixture is empty");
        return json;
    }

    function test_everyVectorMatchesSolidity() public view {
        string memory json = _json();

        // Parallel arrays, not an array of objects. forge's parseJson*Array takes a
        // single path and rejects a wildcard, and decoding into a {string input; bytes32
        // hash;} struct orders the fields alphabetically against the JSON keys, putting
        // the hash in the input slot with no error. The generator emits this shape for
        // that reason, and the lengths are checked here rather than assumed.
        string[] memory inputs = vm.parseJsonStringArray(json, ".inputs");
        bytes32[] memory hashes = vm.parseJsonBytes32Array(json, ".hashes");

        assertEq(inputs.length, hashes.length, "fixture arrays disagree in length");
        assertGt(inputs.length, 10, "fixture lost vectors");

        for (uint256 i = 0; i < inputs.length; i++) {
            assertEq(
                AlertHash.fromString(inputs[i]),
                hashes[i],
                string.concat("JS and Solidity disagree on: ", inputs[i])
            );
            // fromBytes must agree with fromString on the same bytes, since the adapter
            // reaches the second one and `open` the first.
            assertEq(AlertHash.fromBytes(bytes(inputs[i])), hashes[i]);
        }
    }

    /// @dev The mask is only meaningful if it clears bits. Every vector must be field
    ///      safe, and a hash that happened to be field safe without masking would not
    ///      prove the mask ran, so this asserts the property rather than the arithmetic.
    function test_everyVectorIsFieldSafe() public view {
        bytes32[] memory hashes = vm.parseJsonBytes32Array(_json(), ".hashes");
        for (uint256 i = 0; i < hashes.length; i++) {
            assertTrue(AlertHash.isFieldSafe(uint256(hashes[i])));
        }
    }

    /// @dev At least one vector must have had its top byte actually truncated, otherwise
    ///      this whole file would pass against an implementation that never masked.
    function test_fixtureExercisesTheTruncation() public view {
        string[] memory inputs = vm.parseJsonStringArray(_json(), ".inputs");
        uint256 truncated = 0;
        for (uint256 i = 0; i < inputs.length; i++) {
            if (uint256(keccak256(bytes(inputs[i]))) > AlertHash.FIELD_MASK) truncated++;
        }
        assertGt(truncated, 0, "no vector exercises the mask: add inputs until one does");
    }

    /// @dev The fixture records which viem the page loads. A bump that changed keccak256
    ///      or the UTF-8 encoding would show up as a diff in the vectors, but only if the
    ///      two stay pinned to the same version, so the pin is asserted rather than
    ///      trusted. web/hash.js is read as text because solc cannot import it.
    function test_fixtureAndPageAgreeOnTheViemVersion() public view {
        string memory pinned = vm.parseJsonString(_json(), ".viem");
        string memory page = vm.readFile("../web/hash.js");
        assertTrue(
            vm.contains(page, string.concat("viem@", pinned)),
            string.concat("web/hash.js does not import viem@", pinned)
        );
    }
}
