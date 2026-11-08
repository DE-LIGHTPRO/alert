// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AlertEscrow} from "../src/AlertEscrow.sol";
import {AlertHash} from "../src/AlertHash.sol";

/// The escrow's own IERC20 declares only what the escrow calls. A trade also needs to
/// approve and read an allowance, so those are declared here rather than widened in the
/// contract, which should keep the smallest surface it can get away with.
interface IUSDC {
    function approve(address spender, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Drives one complete trade against the LIVE deployment, then asserts the
///         outcome rather than printing it and hoping someone reads carefully.
///
/// @dev    WHO PLAYS WHOM, AND WHY IT IS ARRANGED THIS WAY.
///
///         The signer is the SELLER. The buyer is a deterministic address nobody holds a
///         key for, derived from a fixed string so anyone can recompute it.
///
///         The seller then submits the settlement themselves. That is the strongest form
///         of the relayer claim: `settle` is callable by anyone because the proof is the
///         authority, so even the party who would rather keep the USDC cannot redirect
///         it. The destination was fixed when the escrow opened. The seller pays the gas
///         to send money to someone else and gets nothing back.
///
///         Every assertion below reverts the whole script on failure, so a green run
///         means the chain agreed, not that the log looked plausible.
///
///         Run:
///           forge script script/LiveTrade.s.sol:LiveTrade \
///             --rpc-url https://sepolia.base.org --broadcast -i
contract LiveTrade is Script {
    /// The Base Sepolia deployment, and the default when nothing overrides it.
    ///
    /// These were `constant`, which made this script runnable against exactly one
    /// deployment and therefore impossible to exercise before pointing it at the real
    /// one. A trade driver that can only be run in production is a driver nobody runs
    /// twice. Both are now overridable so the same script drives a local anvil.
    address constant ESCROW_DEFAULT = 0xE6434AC3952D9EDEfe0107B47457a987CAc6211B;
    address constant USDC_DEFAULT = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    string constant BANK = "moniepoint.com";
    string constant RECIPIENT = "*****52988";

    /// 1 USDC, so the run is repeatable against a 20 USDC balance.
    uint128 constant AMOUNT = 1_000_000;

    /// Packs a string the way the circuit does.
    function _packInto(uint256[5] memory out, uint256 at, string memory v) internal pure {
        bytes memory b = bytes(v);
        for (uint256 i = 0; i < b.length; i++) {
            out[at + i / 31] |= uint256(uint8(b[i])) << (8 * (i % 31));
        }
    }

    function run() external {
        AlertEscrow ESCROW = AlertEscrow(vm.envOr("ESCROW_ADDRESS", ESCROW_DEFAULT));
        IUSDC USDC = IUSDC(vm.envOr("USDC_ADDRESS", USDC_DEFAULT));
        require(address(ESCROW).code.length > 0, "no escrow at ESCROW_ADDRESS");
        require(address(USDC).code.length > 0, "no token at USDC_ADDRESS");

        address seller = msg.sender;
        address buyer = vm.addr(uint256(keccak256("alert.live-demo.buyer")));

        // A naira figure unique to this run, so repeat runs never collide on the
        // amount-claimed guard.
        string memory nairaText = string.concat(
            "160,000.", vm.toString(uint256(block.timestamp % 90) + 10)
        );

        console.log("seller (you) ", seller);
        console.log("buyer        ", buyer);
        console.log("naira figure ", nairaText);
        console.log("");

        uint256 sellerBefore = USDC.balanceOf(seller);
        uint256 buyerBefore = USDC.balanceOf(buyer);
        require(sellerBefore >= AMOUNT, "you need at least 1 testnet USDC");

        uint256 id = ESCROW.nextEscrowId();

        vm.startBroadcast();

        // Exact approval, never unlimited.
        USDC.approve(address(ESCROW), AMOUNT);

        ESCROW.open(
            buyer,
            AMOUNT,
            nairaText,
            RECIPIENT,
            AlertHash.fromString(BANK),
            uint64(block.timestamp + 1 days)
        );

        // The nine public signals a real proof carries, packed the way the circuit
        // packs them: 31 bytes per field element, first byte least significant. Against
        // the stub the Groth16 points are ignored, but every binding the ESCROW enforces
        // is live, which is the whole point of the run.
        uint256[5] memory pub;
        _packInto(pub, 0, "no-reply@moniepoint.com");
        _packInto(pub, 3, nairaText);
        _packInto(pub, 4, string.concat("boundary", vm.toString(block.timestamp)));
        _packInto(pub, 7, RECIPIENT);
        pub[8] = uint256(keccak256("dkim-key-hash")) >> 8;

        ESCROW.settle(id, [uint256(1), 2], [[uint256(3), 4], [uint256(5), 6]], [uint256(7), 8], pub);

        vm.stopBroadcast();

        // ---------------------------------------------------------------- assertions
        AlertEscrow.Escrow memory e = ESCROW.getEscrow(id);
        require(uint8(e.status) == 2, "escrow did not reach Settled");
        require(e.buyer == buyer, "buyer on chain is not the buyer we set");
        require(e.amountHash == AlertHash.fromString(nairaText), "amount hash disagrees");

        uint256 sellerAfter = USDC.balanceOf(seller);
        uint256 buyerAfter = USDC.balanceOf(buyer);

        require(buyerAfter == buyerBefore + AMOUNT, "the buyer was not paid");
        require(sellerAfter == sellerBefore - AMOUNT, "the seller did not pay exactly the amount");
        require(USDC.allowance(seller, address(ESCROW)) == 0, "an allowance outlived the trade");
        require(!ESCROW.amountClaimed(e.amountHash), "the amount was not released for reuse");

        console.log("escrow #     ", id);
        console.log("status        Settled");
        console.log("buyer   +1.00 USDC   (submitted by the seller, who got nothing back)");
        console.log("allowance     0      (exact approval, fully consumed)");
        console.log("");
        console.log("Every assertion passed. Look it up on the site by escrow number.");
    }
}
