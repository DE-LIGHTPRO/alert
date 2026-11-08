// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AlertEscrow, IERC20} from "../src/AlertEscrow.sol";
import {AlertProofAdapter} from "../src/AlertProofAdapter.sol";
import {AlertHash} from "../src/AlertHash.sol";
import {IAlertVerifier, IGroth16Verifier} from "../src/IAlertVerifier.sol";
import {MockUSDC, MockGroth16Verifier} from "./mocks/Mocks.sol";

contract AlertEscrowTest is Test {
    AlertEscrow escrow;
    AlertProofAdapter adapter;
    MockGroth16Verifier groth16;
    MockUSDC usdc;

    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");
    address relayer = makeAddr("relayer");
    address stranger = makeAddr("stranger");

    string constant BANK = "moniepoint.com";
    /// As Moniepoint prints it: thousands separator, two decimals. The .37 is the per
    /// escrow tag the bot allocates.
    string constant AMOUNT = "160,000.37";
    /// As the debit alert masks the destination account.
    string constant RECIPIENT = "*****52988";
    /// Real MIME boundaries: 60 hex characters, which is why they span three signals.
    string constant NULLIFIER_A = "c4a88985eb621459bfd6e0ed92c07b50cd9740c8a043febb910f2688e979";
    // 60 hex characters, like NULLIFIER_A. This was 64, which fits the v1 field width of
    // 64 but not the thing it stands for: a SendGrid MIME boundary is always exactly 60.
    // The slack hid it until the tighter layout packed it into the recipient slot and
    // the replay test failed with WrongRecipient.
    string constant NULLIFIER_B = "1703d552bd106ea7baa0f91c2e4d7a35b8c0916fe3a24d5c80b7e1f6a2c3";

    uint128 constant USDC_AMOUNT = 100_000_000; // 100 USDC, 6dp

    uint64 deadline;

    function setUp() public {
        usdc = new MockUSDC();
        groth16 = new MockGroth16Verifier();
        adapter = new AlertProofAdapter(IGroth16Verifier(address(groth16)), BANK);
        escrow = new AlertEscrow(IERC20(address(usdc)), IAlertVerifier(address(adapter)));
        deadline = uint64(block.timestamp + 1 days);
        usdc.mint(seller, USDC_AMOUNT * 10);
    }

    // ---------------------------------------------------------------- helpers

    function _open(string memory amountText) internal returns (uint256 id) {
        vm.startPrank(seller);
        usdc.approve(address(escrow), USDC_AMOUNT);
        id = escrow.open(buyer, USDC_AMOUNT, amountText, RECIPIENT, AlertHash.fromString(BANK), deadline);
        vm.stopPrank();
    }

    function _open() internal returns (uint256) {
        return _open(AMOUNT);
    }

    /// Packs a string the way the circuit does: 31 bytes per field element, first byte
    /// in the least significant position.
    function _packInto(uint256[5] memory out, uint256 at, string memory v) internal pure {
        bytes memory b = bytes(v);
        for (uint256 i = 0; i < b.length; i++) {
            out[at + i / 31] |= uint256(uint8(b[i])) << (8 * (i % 31));
        }
    }

    /// The nine public signals, in the layout AlertProofAdapter declares.
    function _signals(
        string memory amountText,
        string memory nullifier,
        string memory recipient
    ) internal pure returns (uint256[5] memory s) {
        _packInto(s, 0, amountText); // 1 signal
        _packInto(s, 1, nullifier);  // 2
        _packInto(s, 3, recipient);  // 1
        s[4] = uint256(keccak256("dkim-key-hash")) >> 8; // the key hash signal
    }

    function _goodSignals() internal pure returns (uint256[5] memory) {
        return _signals(AMOUNT, NULLIFIER_A, RECIPIENT);
    }

    function _settle(uint256 id, uint256[5] memory s) internal {
        escrow.settle(id, [uint256(1), 2], [[uint256(3), 4], [uint256(5), 6]], [uint256(7), 8], s);
    }

    // ------------------------------------------------------------------ open

    function test_open_pullsUsdcAndRecordsState() public {
        uint256 id = _open();

        assertEq(usdc.balanceOf(address(escrow)), USDC_AMOUNT, "escrow holds the USDC");
        assertEq(usdc.balanceOf(seller), USDC_AMOUNT * 9, "seller paid in");

        AlertEscrow.Escrow memory e = escrow.getEscrow(id);
        assertEq(e.seller, seller);
        assertEq(e.buyer, buyer);
        assertEq(e.usdcAmount, USDC_AMOUNT);
        assertEq(e.amountHash, AlertHash.fromString(AMOUNT));
        assertEq(e.recipientHash, AlertHash.fromString(RECIPIENT));
        assertEq(uint8(e.status), uint8(AlertEscrow.Status.Open));
    }

    /// The binding that replaced the narration code. Two open escrows must never share
    /// an amount, or one alert could settle either and the nullifier would not help:
    /// both would be first uses.
    function test_open_rejectsAnAmountAlreadyClaimed() public {
        _open();
        vm.startPrank(seller);
        usdc.approve(address(escrow), USDC_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(AlertEscrow.AmountAlreadyClaimed.selector, AlertHash.fromString(AMOUNT))
        );
        escrow.open(buyer, USDC_AMOUNT, AMOUNT, RECIPIENT, AlertHash.fromString(BANK), deadline);
        vm.stopPrank();
    }

    function test_open_allowsADifferentKoboTag() public {
        _open("160,000.37");
        uint256 second = _open("160,000.38");
        assertEq(escrow.getEscrow(second).amountHash, AlertHash.fromString("160,000.38"));
    }

    /// @dev Found by mutation, not by design. Removing the settle-time bank check left
    ///      the suite green, which said the check was redundant. It was, and the real
    ///      hole was one layer up: `open` took the bank as an unvalidated parameter, so
    ///      a seller could lock USDC against a bank this deployment can never prove and
    ///      have no way out before the deadline.
    function test_open_rejectsBankTheVerifierCannotProve() public {
        vm.startPrank(seller);
        usdc.approve(address(escrow), USDC_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                AlertEscrow.BankNotSupported.selector, AlertHash.fromString("kuda.com"), AlertHash.fromString(BANK)
            )
        );
        escrow.open(buyer, USDC_AMOUNT, AMOUNT, RECIPIENT, AlertHash.fromString("kuda.com"), deadline);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(escrow)), 0, "nothing was locked");
    }

    function test_open_rejectsZeroBuyer() public {
        vm.startPrank(seller);
        usdc.approve(address(escrow), USDC_AMOUNT);
        vm.expectRevert(AlertEscrow.ZeroAddress.selector);
        escrow.open(address(0), USDC_AMOUNT, AMOUNT, RECIPIENT, AlertHash.fromString(BANK), deadline);
        vm.stopPrank();
    }

    function test_open_rejectsEmptyAmountText() public {
        vm.startPrank(seller);
        usdc.approve(address(escrow), USDC_AMOUNT);
        vm.expectRevert(AlertEscrow.ZeroAmount.selector);
        escrow.open(buyer, USDC_AMOUNT, "", RECIPIENT, AlertHash.fromString(BANK), deadline);
        vm.stopPrank();
    }

    function test_open_rejectsDeadlineInPast() public {
        vm.startPrank(seller);
        usdc.approve(address(escrow), USDC_AMOUNT);
        vm.expectRevert(AlertEscrow.DeadlineInPast.selector);
        escrow.open(buyer, USDC_AMOUNT, AMOUNT, RECIPIENT, AlertHash.fromString(BANK), uint64(block.timestamp));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- settle

    function test_settle_paysBuyer() public {
        uint256 id = _open();
        _settle(id, _goodSignals());

        assertEq(usdc.balanceOf(buyer), USDC_AMOUNT, "buyer received");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow emptied");
        assertEq(uint8(escrow.getEscrow(id).status), uint8(AlertEscrow.Status.Settled));
    }

    /// The property that lets a buyer with no ETH on Base still get paid.
    function test_settle_callableByAnyone_butPaysTheBuyer() public {
        uint256 id = _open();

        vm.prank(relayer);
        _settle(id, _goodSignals());

        assertEq(usdc.balanceOf(buyer), USDC_AMOUNT, "buyer paid");
        assertEq(usdc.balanceOf(relayer), 0, "relayer got nothing");
    }

    /// Exact, not "at least". A larger payment must not satisfy a smaller escrow it was
    /// never meant for, now that the amount IS the binding.
    function test_settle_rejectsADifferentAmount() public {
        uint256 id = _open();
        uint256[5] memory s = _signals("160,000.38", NULLIFIER_A, RECIPIENT);
        vm.expectRevert(AlertEscrow.WrongAmount.selector);
        _settle(id, s);
    }

    function test_settle_rejectsAnOverpayment() public {
        uint256 id = _open();
        uint256[5] memory s = _signals("999,999.99", NULLIFIER_A, RECIPIENT);
        vm.expectRevert(AlertEscrow.WrongAmount.selector);
        _settle(id, s);
    }

    /// Money leaving the buyer's account is not money reaching THIS seller.
    function test_settle_rejectsAPaymentToSomeoneElse() public {
        uint256 id = _open();
        uint256[5] memory s = _signals(AMOUNT, NULLIFIER_A, "*****11111");
        vm.expectRevert(AlertEscrow.WrongRecipient.selector);
        _settle(id, s);
    }


    function test_settle_rejectsInvalidProof() public {
        uint256 id = _open();
        groth16.setShouldVerify(false);
        vm.expectRevert(AlertProofAdapter.ProofInvalid.selector);
        _settle(id, _goodSignals());
    }

    /// @dev An empty field means the circuit matched nothing where it had to match
    ///      something. Left unnamed it becomes a hash of "" and surfaces downstream as
    ///      the wrong error entirely.
    function test_settle_rejectsEmptyNullifier() public {
        uint256 id = _open();
        uint256[5] memory s = _signals(AMOUNT, "", RECIPIENT);
        vm.expectRevert(abi.encodeWithSelector(AlertProofAdapter.EmptyField.selector, "nullifier"));
        _settle(id, s);
    }

    function test_settle_rejectsEmptyAmount() public {
        uint256 id = _open();
        uint256[5] memory s = _signals("", NULLIFIER_A, RECIPIENT);
        vm.expectRevert(abi.encodeWithSelector(AlertProofAdapter.EmptyField.selector, "amount"));
        _settle(id, s);
    }

    /// @dev The recipient guard was the one with no test, and it is the one whose absence
    ///      is hardest to read: an empty recipient still reverts, but as the escrow's
    ///      WrongRecipient, which tells a seller the buyer paid the wrong account when in
    ///      fact the circuit extracted nothing. Found by the mutation run, not by review.
    function test_settle_rejectsEmptyRecipient() public {
        uint256 id = _open();
        uint256[5] memory s = _signals(AMOUNT, NULLIFIER_A, "");
        vm.expectRevert(abi.encodeWithSelector(AlertProofAdapter.EmptyField.selector, "recipient"));
        _settle(id, s);
    }

    function test_settle_rejectsAfterDeadline() public {
        uint256 id = _open();
        vm.warp(deadline + 1);
        vm.expectRevert(AlertEscrow.Expired.selector);
        _settle(id, _goodSignals());
    }

    function test_settle_rejectsAlreadySettled() public {
        uint256 id = _open();
        _settle(id, _goodSignals());
        vm.expectRevert(AlertEscrow.NotOpen.selector);
        _settle(id, _goodSignals());
    }

    /// A settled escrow frees its amount, or the bot leaks the usable kobo space one
    /// completed trade at a time.
    function test_settle_releasesTheAmountForReuse() public {
        uint256 id = _open();
        _settle(id, _goodSignals());
        assertFalse(escrow.amountClaimed(AlertHash.fromString(AMOUNT)), "freed");

        uint256 again = _open();
        assertEq(escrow.getEscrow(again).amountHash, AlertHash.fromString(AMOUNT));
    }

    // ------------------------------------------------------------------ replay

    /// One alert, one settlement, ever. Here the two escrows differ by a kobo, so the
    /// amount binding does NOT catch it and the nullifier has to.
    function test_replay_sameAlertCannotSettleTwoEscrows() public {
        uint256 first = _open("160,000.37");
        uint256 second = _open("160,000.38");

        bytes32 nullifier = bytes32(uint256(0xABCD));
        _settle(first, _signals("160,000.37", NULLIFIER_A, RECIPIENT));

        vm.expectRevert(AlertEscrow.NullifierAlreadySpent.selector);
        _settle(second, _signals("160,000.38", NULLIFIER_A, RECIPIENT));

        assertEq(usdc.balanceOf(buyer), USDC_AMOUNT, "paid exactly once");
    }

    /// The second, independent defence. A FRESH alert still cannot settle a trade it was
    /// not made for, because the kobo tag is per escrow.
    function test_replay_freshAlertCannotSettleADifferentTrade() public {
        uint256 mine = _open("160,000.37");
        uint256 theirs = _open("160,000.38");

        vm.expectRevert(AlertEscrow.WrongAmount.selector);
        _settle(theirs, _signals("160,000.37", NULLIFIER_B, RECIPIENT));

        _settle(mine, _signals("160,000.37", NULLIFIER_B, RECIPIENT));
        assertEq(usdc.balanceOf(buyer), USDC_AMOUNT);
    }

    // ---------------------------------------------------------------- refund

    function test_refund_afterDeadlinePaysSeller() public {
        uint256 id = _open();
        vm.warp(deadline + 1);

        vm.prank(seller);
        escrow.refund(id);

        assertEq(usdc.balanceOf(seller), USDC_AMOUNT * 10, "seller whole again");
        assertEq(uint8(escrow.getEscrow(id).status), uint8(AlertEscrow.Status.Refunded));
        assertFalse(escrow.amountClaimed(AlertHash.fromString(AMOUNT)), "amount freed");
    }

    function test_refund_rejectedBeforeDeadline() public {
        uint256 id = _open();
        vm.prank(seller);
        vm.expectRevert(AlertEscrow.NotYetExpired.selector);
        escrow.refund(id);
    }

    function test_refund_rejectedForNonSeller() public {
        uint256 id = _open();
        vm.warp(deadline + 1);
        vm.prank(stranger);
        vm.expectRevert(AlertEscrow.NotSeller.selector);
        escrow.refund(id);
    }

    function test_refund_rejectedAfterSettlement() public {
        uint256 id = _open();
        _settle(id, _goodSignals());
        vm.warp(deadline + 1);
        vm.prank(seller);
        vm.expectRevert(AlertEscrow.NotOpen.selector);
        escrow.refund(id);
    }

    function test_settle_rejectedAfterRefund() public {
        uint256 id = _open();
        vm.warp(deadline + 1);
        vm.prank(seller);
        escrow.refund(id);

        vm.warp(deadline - 1);
        vm.expectRevert(AlertEscrow.NotOpen.selector);
        _settle(id, _goodSignals());
    }

    // The four constructor-pairing tests that lived here are deleted, not skipped.
    //
    // They checked that a pinned sender address belonged to the pinned bank domain:
    // a lookalike domain, a sender shorter than the domain, a mismatched pair. v2 of
    // the blueprint stops extracting email_sender at all, so the adapter pins no sender
    // and there is no pair left to disagree. Leaving them asserting against a constructor
    // that no longer takes the argument would be worse than removing them: a test that
    // cannot fail is a claim nobody is checking.
    //
    // What replaced the guarantee: senderDomain is pinned in the blueprint and the
    // circuit verifies the DKIM signature against it, so a proof still cannot be made
    // from an email Moniepoint's provider did not sign.
}
