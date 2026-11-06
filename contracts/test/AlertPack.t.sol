// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AlertPack} from "../src/AlertPack.sol";
import {AlertHash} from "../src/AlertHash.sol";

/// @dev The vectors below were generated from the packing rule in Python, independently
///      of this Solidity, on 7 Nov 2026. That matters: a test that derives its
///      expectation by running the code under test cannot catch the code being wrong,
///      and the specific thing worth catching here is byte order.
///
///      Reading a packed field big-endian produces a valid, stable, reversed string. It
///      hashes to something consistent and compares unequal forever. Nothing reverts and
///      nothing logs; the trade simply never settles.
contract AlertPackTest is Test {
    function test_singleSignal_bankDomain() public pure {
        uint256[] memory s = new uint256[](1);
        s[0] = 0x0000000000000000000000000000000000006d6f632e746e696f7065696e6f6d;
        assertEq(string(AlertPack.unpack(s)), "moniepoint.com");
    }

    function test_singleSignal_amountWithSeparators() public pure {
        uint256[] memory s = new uint256[](1);
        s[0] = 0x00000000000000000000000000000000000000000000000030302e3030302c35;
        assertEq(string(AlertPack.unpack(s)), "5,000.00");
    }

    function test_singleSignal_maskedAccount() public pure {
        uint256[] memory s = new uint256[](1);
        s[0] = 0x0000000000000000000000000000000000000000000000000000003838393235;
        assertEq(string(AlertPack.unpack(s)), "52988");
    }

    function test_singleSignal_senderAddress() public pure {
        uint256[] memory s = new uint256[](1);
        s[0] = 0x0000000000000000006d6f632e746e696f7065696e6f6d40796c7065722d6f6e;
        assertEq(string(AlertPack.unpack(s)), "no-reply@moniepoint.com");
    }

    /// The one that actually spans signals: the 60-character MIME boundary used as the
    /// nullifier. This is the case the old adapter could not have handled at all.
    function test_multiSignal_mimeBoundary() public pure {
        uint256[] memory s = new uint256[](3);
        s[0] = 0x0035623730633239646530653664666239353431323662653538393838613463;
        s[1] = 0x0000003937396538383632663031396262656633343061386330343739646330;
        s[2] = 0;
        assertEq(
            string(AlertPack.unpack(s)),
            "c4a88985eb621459bfd6e0ed92c07b50cd9740c8a043febb910f2688e979"
        );
    }

    /// Reassembling then hashing must land on exactly the value `open` stored, or a
    /// correct proof is rejected with WrongAmount on a correct amount.
    function test_unpackThenHash_matchesWhatOpenStores() public pure {
        uint256[] memory s = new uint256[](1);
        s[0] = 0x00000000000000000000000000000000000000000000000030302e3030302c35;
        bytes memory raw = AlertPack.unpack(s);
        assertEq(AlertHash.fromBytes(raw), AlertHash.fromString("5,000.00"));
    }

    function test_byteOrder_isNotReversed() public pure {
        uint256[] memory s = new uint256[](1);
        s[0] = 0x0000000000000000000000000000000000000000000000000000003838393235;
        // The whole point. Big-endian reading would give "88925" and still look like
        // a plausible account suffix.
        assertTrue(keccak256(AlertPack.unpack(s)) != keccak256(bytes("88925")));
        assertEq(string(AlertPack.unpack(s)), "52988");
    }

    function test_signalsFor_matchesTheSpec() public pure {
        assertEq(AlertPack.signalsFor(16), 1);  // amount
        assertEq(AlertPack.signalsFor(8), 1);   // recipient
        assertEq(AlertPack.signalsFor(64), 3);  // nullifier and email_sender
        assertEq(AlertPack.signalsFor(31), 1);  // exactly one element
        assertEq(AlertPack.signalsFor(32), 2);  // one byte over
        assertEq(AlertPack.signalsFor(0), 0);
    }

    function test_emptySignalsGiveEmptyBytes() public pure {
        uint256[] memory s = new uint256[](2);
        assertEq(AlertPack.unpack(s).length, 0);
    }

    function test_unpackSlice_readsTheRightWindow() public pure {
        // a full signal array with the boundary sitting at index 1..3
        uint256[] memory all = new uint256[](5);
        all[0] = 0x0000000000000000000000000000000000000000000000000000003838393235; // 52988
        all[1] = 0x0035623730633239646530653664666239353431323662653538393838613463;
        all[2] = 0x0000003937396538383632663031396262656633343061386330343739646330;
        all[3] = 0;
        all[4] = 0x0000000000000000000000000000000000006d6f632e746e696f7065696e6f6d; // moniepoint.com

        assertEq(string(AlertPack.unpackSlice(all, 0, 1)), "52988");
        assertEq(
            string(AlertPack.unpackSlice(all, 1, 3)),
            "c4a88985eb621459bfd6e0ed92c07b50cd9740c8a043febb910f2688e979"
        );
        assertEq(string(AlertPack.unpackSlice(all, 4, 1)), "moniepoint.com");
    }

    /// Round-trip: anything packed the circuit's way must come back out unchanged.
    function testFuzz_roundTrip(bytes calldata input) public pure {
        vm.assume(input.length > 0 && input.length <= 62);
        // No interior zero bytes: the circuit pads with them, so they are the terminator.
        for (uint256 i = 0; i < input.length; i++) vm.assume(input[i] != 0);

        uint256 n = AlertPack.signalsFor(input.length);
        uint256[] memory packed = new uint256[](n);
        for (uint256 i = 0; i < input.length; i++) {
            packed[i / 31] |= uint256(uint8(input[i])) << (8 * (i % 31));
        }
        assertEq(AlertPack.unpack(packed), input);
    }
}
