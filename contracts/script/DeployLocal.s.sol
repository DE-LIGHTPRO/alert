// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AlertEscrow, IERC20} from "../src/AlertEscrow.sol";
import {AlertProofAdapter} from "../src/AlertProofAdapter.sol";
import {AlertHash} from "../src/AlertHash.sol";
import {IAlertVerifier, IGroth16Verifier} from "../src/IAlertVerifier.sol";
import {MockUSDC, MockGroth16Verifier} from "../test/mocks/Mocks.sol";

/// @notice Stands the whole system up on a local chain so the REAL web UI can drive it.
///
/// @dev    WHY THIS EXISTS, AND WHAT IT IS NOT.
///
///         Until now this project had contracts tested against mocks and a page tested
///         against no chain. The seam between them had never been exercised once, and
///         that seam is exactly where a UI offers something the contract refuses: the
///         form says one thing, the contract reverts, and neither side is wrong alone.
///
///         So: deploy for real, point the production page at it, and drive a whole trade
///         through the browser.
///
///         What this is NOT: a fork of Base Sepolia. The RPC answers in about ten
///         seconds from here and forking needs hundreds of calls. So USDC is a mock with
///         the same 6 decimals rather than Circle's actual bytecode, and the verifier is
///         a mock that returns true. Everything else is the code that ships.
///
///         That means this exercises the escrow, the UI, the hashing across two
///         languages and the whole flow. It does NOT exercise the real USDC's transfer
///         semantics or any cryptography. Both are stated rather than implied.
contract DeployLocal is Script {
    string constant BANK_DOMAIN = "moniepoint.com";

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        MockUSDC usdc = new MockUSDC();
        MockGroth16Verifier groth16 = new MockGroth16Verifier();
        AlertProofAdapter adapter = new AlertProofAdapter(IGroth16Verifier(address(groth16)), BANK_DOMAIN);
        AlertEscrow escrow = new AlertEscrow(IERC20(address(usdc)), IAlertVerifier(address(adapter)));

        // Fund the first three anvil accounts so a trade can actually be driven.
        usdc.mint(deployer, 1_000_000e6);
        usdc.mint(0x70997970C51812dc3A010C7d01b50e0d17dc79C8, 1_000_000e6);
        usdc.mint(0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC, 1_000_000e6);

        vm.stopBroadcast();

        console.log("MockUSDC         ", address(usdc));
        console.log("MockGroth16      ", address(groth16));
        console.log("AlertProofAdapter", address(adapter));
        console.log("AlertEscrow      ", address(escrow));
    }
}
