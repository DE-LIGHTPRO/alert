// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAlertVerifier, AlertAttestation} from "./IAlertVerifier.sol";
import {AlertHash} from "./AlertHash.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title  AlertEscrow
/// @notice Holds the crypto leg of a naira/USDC trade and releases it against a
///         zero-knowledge proof of the buyer's bank alert email.
///
/// @dev    WHY THIS CONTRACT HOLDS FUNDS, when the rest of this author's work does not.
///
///         Sealed's invariant is that no contract ever takes custody. Escrow is the one
///         shape where that cannot hold: the whole product is "the seller's USDC is
///         somewhere neither party can touch until the naira is proven". So the funds
///         sit here.
///
///         "Non-custodial" still means something precise, and it is worth stating rather
///         than implying. There is no owner, no admin, no pause, no upgrade path and no
///         privileged key anywhere in this file. The only two ways USDC leaves are a
///         valid proof (to the buyer) or the deadline passing (back to the seller).
///         Nobody, including whoever deployed it, can do anything else with it.
///
///         WHY THE BUYER PROVES, AND NOT THE SELLER.
///
///         The seller locks USDC, the buyer sends naira, and the proof releases to the
///         buyer. So the buyer wants to prove and the seller does not: if nobody proves,
///         the deadline passes and the USDC refunds to the seller, who by then holds the
///         naira as well. That is not a stalemate, it is a theft, and it is the whole
///         reason the evidence has to be the buyer's own DEBIT alert rather than the
///         seller's credit alert.
///
///         It follows that the buyer must pay from a bank that emails debit alerts.
///         Measured 6 Nov 2026: Moniepoint does. OPay does not.
contract AlertEscrow {
    using AlertHash for string;

    enum Status {
        None,
        Open,
        Settled,
        Refunded
    }

    struct Escrow {
        address seller;
        address buyer;
        /// USDC held, in 6-decimal base units.
        uint128 usdcAmount;
        uint64 deadline;
        Status status;
        /// Hash of the naira figure as the alert will print it, e.g. "160,000.37".
        bytes32 amountHash;
        /// Hash of the destination account as the alert masks it, e.g. "*****52988".
        bytes32 recipientHash;
        /// Hash of the DKIM signing domain this escrow accepts.
        bytes32 bankDomainHash;
    }

    IERC20 public immutable usdc;
    IAlertVerifier public immutable verifier;

    uint256 public nextEscrowId;
    mapping(uint256 => Escrow) public escrows;

    /// @notice Bank transaction references already spent, forever.
    mapping(bytes32 => bool) public nullifierSpent;

    /// @notice Amount strings currently claimed by an open escrow.
    ///
    /// @dev    THIS IS THE BINDING, and it replaced an escrow code in the narration.
    ///
    ///         The original design had the buyer type a per-trade code into the transfer
    ///         narration. Measured against three real alerts on 6 Nov 2026, Moniepoint
    ///         overwrites the narration with its own template and the user's text does
    ///         not survive. So the code cannot be carried that way.
    ///
    ///         Instead the amount itself is the tag. The bot quotes ₦160,000.37 rather
    ///         than ₦160,000, allocating the kobo per escrow. The amount is in every
    ///         alert, in both directions, and needs nothing from the user but typing the
    ///         figure they were given.
    ///
    ///         That only binds if no two OPEN escrows share an amount, which is what this
    ///         map enforces. Without it, one alert could settle either of two identical
    ///         trades, and the nullifier would not help: both would be first uses.
    mapping(bytes32 => bool) public amountClaimed;

    error ZeroAddress();
    error ZeroAmount();
    error DeadlineInPast();
    error NotOpen();
    error Expired();
    error NotYetExpired();
    error NotSeller();
    error NullifierAlreadySpent();
    error BankNotSupported(bytes32 requested, bytes32 supported);
    error AmountAlreadyClaimed(bytes32 amountHash);
    error WrongAmount();
    error WrongRecipient();
    error TransferFailed();

    event EscrowOpened(
        uint256 indexed escrowId,
        address indexed seller,
        address indexed buyer,
        uint128 usdcAmount,
        /// The exact figure the buyer must transfer, emitted rather than stored so the
        /// displayed amount and the checked hash cannot drift apart: the hash is derived
        /// from this very string, here, at open time.
        string nairaAmountText,
        uint64 deadline
    );
    event EscrowSettled(uint256 indexed escrowId, address indexed buyer, bytes32 indexed nullifier);
    event EscrowRefunded(uint256 indexed escrowId, address indexed seller);

    constructor(IERC20 _usdc, IAlertVerifier _verifier) {
        if (address(_usdc) == address(0) || address(_verifier) == address(0)) revert ZeroAddress();
        usdc = _usdc;
        verifier = _verifier;
    }

    /// @notice Seller locks USDC against a naira payment they expect to receive.
    ///
    /// @param  nairaAmountText The figure exactly as Moniepoint will print it, including
    ///         thousands separators and two decimals: "160,000.37". The bot allocates the
    ///         kobo so no two open escrows collide.
    /// @param  recipientMasked The seller's account as the alert masks it: "*****52988".
    function open(
        address buyer,
        uint128 usdcAmount,
        string calldata nairaAmountText,
        string calldata recipientMasked,
        bytes32 bankDomainHash,
        uint64 deadline
    ) external returns (uint256 escrowId) {
        if (buyer == address(0)) revert ZeroAddress();
        if (usdcAmount == 0) revert ZeroAmount();
        if (bytes(nairaAmountText).length == 0 || bytes(recipientMasked).length == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlineInPast();

        // Refuse configuration this deployment can never satisfy, at the door.
        //
        // A mutation test found this: removing the settle-time bank check left every
        // test green, because the adapter is pinned to one domain and so the two values
        // always agreed. Chasing that down showed the real defect was not a weak check
        // at settle but an unvalidated parameter at open. A seller could pin an escrow
        // to kuda.com against a moniepoint.com verifier, lock their USDC, and find it
        // unsettleable with no error until the deadline.
        bytes32 supported = verifier.expectedBankDomainHash();
        if (bankDomainHash != supported) revert BankNotSupported(bankDomainHash, supported);

        bytes32 amountHash = AlertHash.fromString(nairaAmountText);
        if (amountClaimed[amountHash]) revert AmountAlreadyClaimed(amountHash);
        amountClaimed[amountHash] = true;

        escrowId = nextEscrowId++;
        escrows[escrowId] = Escrow({
            seller: msg.sender,
            buyer: buyer,
            usdcAmount: usdcAmount,
            deadline: deadline,
            status: Status.Open,
            amountHash: amountHash,
            recipientHash: AlertHash.fromString(recipientMasked),
            bankDomainHash: bankDomainHash
        });

        _pullUsdc(msg.sender, usdcAmount);

        emit EscrowOpened(escrowId, msg.sender, buyer, usdcAmount, nairaAmountText, deadline);
    }

    /// @notice Release the USDC against a proof of the bank alert.
    ///
    /// @dev    DELIBERATELY CALLABLE BY ANYONE. The proof is the authority here, not
    ///         `msg.sender`. A buyer who holds no ETH on Base can hand the proof to a
    ///         relayer and still get paid, and a relayer who tries to redirect the funds
    ///         cannot: the destination is `escrow.buyer`, fixed when the escrow opened.
    function settle(
        uint256 escrowId,
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[9] calldata pubSignals
    ) external {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Open) revert NotOpen();
        if (block.timestamp > e.deadline) revert Expired();

        // Reverts if the proof does not verify.
        AlertAttestation memory a = verifier.verifyAlert(pA, pB, pC, pubSignals);

        if (nullifierSpent[a.nullifier]) revert NullifierAlreadySpent();

        // Exact, not "at least". An earlier version took any amount >= the agreed one,
        // to be forgiving about rounding. That was wrong once the amount became the
        // binding: a larger payment would then satisfy a smaller escrow it was never
        // meant for.
        if (a.amountHash != e.amountHash) revert WrongAmount();

        // The naira has to have reached THIS seller, not merely left the buyer's account.
        if (a.recipientHash != e.recipientHash) revert WrongRecipient();

        // There is deliberately NO bank check here. The adapter refuses any domain but
        // its own, and `open` refuses any escrow but that domain, so a comparison at
        // this point is provably always true. Keeping it would look like a guard while
        // being incapable of failing, which is worse than not having one: the next
        // person reads it as the thing protecting them.

        // Effects before interaction.
        e.status = Status.Settled;
        nullifierSpent[a.nullifier] = true;
        amountClaimed[e.amountHash] = false;

        uint128 amount = e.usdcAmount;
        address buyer = e.buyer;

        _pushUsdc(buyer, amount);

        emit EscrowSettled(escrowId, buyer, a.nullifier);
    }

    /// @notice Seller reclaims after the deadline, if no proof ever arrived.
    /// @dev    The only other exit. There is no path where a third party decides.
    function refund(uint256 escrowId) external {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Open) revert NotOpen();
        if (msg.sender != e.seller) revert NotSeller();
        if (block.timestamp <= e.deadline) revert NotYetExpired();

        e.status = Status.Refunded;
        // Release the amount so the bot can allocate those kobo again. Leaving it
        // claimed would leak the usable amount space one dead escrow at a time.
        amountClaimed[e.amountHash] = false;

        uint128 amount = e.usdcAmount;
        address seller = e.seller;

        _pushUsdc(seller, amount);

        emit EscrowRefunded(escrowId, seller);
    }

    function getEscrow(uint256 escrowId) external view returns (Escrow memory) {
        return escrows[escrowId];
    }

    /// @dev USDC on Base returns a bool, but tokens that return nothing are common enough
    ///      that assuming a return value is how integrations break. Accept both shapes,
    ///      and treat a `false` return as a failure rather than ignoring it.
    function _pullUsdc(address from, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _pushUsdc(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(usdc).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
