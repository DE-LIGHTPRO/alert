// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AlertEscrow, IERC20} from "../src/AlertEscrow.sol";
import {AlertProofAdapter} from "../src/AlertProofAdapter.sol";
import {AlertHash} from "../src/AlertHash.sol";
import {IAlertVerifier, IGroth16Verifier} from "../src/IAlertVerifier.sol";

/// @notice Deploys the adapter and escrow against an already-deployed Groth16 verifier.
///
/// @dev    The verifier is NOT deployed here. zkEmail's registry deploys it when the
///         blueprint finishes compiling, and its address comes from there. Deploying our
///         own stub and pointing at it would produce a system that passes every test and
///         proves nothing, which is the failure mode this project can least afford.
///
///         Usage:
///           export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
///           export PRIVATE_KEY=0x...
///           export VERIFIER_ADDRESS=0x...      # from the registry, after compile
///           forge script script/Deploy.s.sol:Deploy \
///             --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast -vvv
contract Deploy is Script {
    /// Circle's canonical USDC on Base Sepolia.
    /// Verified against Circle's published testnet addresses; re-check before mainnet.
    address constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    string constant BANK_DOMAIN = "moniepoint.com";

    function run() external {
        address verifier = vm.envAddress("VERIFIER_ADDRESS");
        require(verifier != address(0), "VERIFIER_ADDRESS not set");
        require(verifier.code.length > 0, "VERIFIER_ADDRESS holds no code");

        address usdc = vm.envOr("USDC_ADDRESS", USDC_BASE_SEPOLIA);
        require(usdc.code.length > 0, "USDC address holds no code on this chain");

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));

        AlertProofAdapter adapter = new AlertProofAdapter(IGroth16Verifier(verifier), BANK_DOMAIN);

        AlertEscrow escrow = new AlertEscrow(IERC20(usdc), IAlertVerifier(address(adapter)));

        vm.stopBroadcast();

        console.log("chain id          ", block.chainid);
        console.log("USDC              ", usdc);
        console.log("Groth16 verifier  ", verifier);
        console.log("AlertProofAdapter ", address(adapter));
        console.log("AlertEscrow       ", address(escrow));
        console.log("");
        console.log("bank domain hash  ");
        console.logBytes32(AlertHash.fromString(BANK_DOMAIN));

        // Fail the deployment rather than print a reassuring summary, if the two halves
        // disagree.
        //
        // There used to be a third line here asserting
        //   adapter.expectedBankDomainHash() == AlertHash.fromString(BANK_DOMAIN)
        // which the constructor had just set from that same constant. It was a tautology:
        // it read as the check that the adapter was pinned to the right bank and could not
        // fail under any input. The reachable version of that mistake is a sender pinned
        // to a different domain than the escrow gates on, and it is now enforced in the
        // adapter's constructor, so every deployment gets it rather than this script.
        //
        // The two below are real: both sides are set independently of each other.
        require(address(escrow.verifier()) == address(adapter), "escrow not wired to adapter");
        require(address(escrow.usdc()) == usdc, "escrow not wired to USDC");
    }
}
