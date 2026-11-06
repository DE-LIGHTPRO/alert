// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AlertEscrow, IERC20} from "../src/AlertEscrow.sol";
import {AlertProofAdapter} from "../src/AlertProofAdapter.sol";
import {AlertHash} from "../src/AlertHash.sol";
import {IAlertVerifier, IGroth16Verifier} from "../src/IAlertVerifier.sol";

/// @notice A verifier that accepts every proof. Deployed ONLY so the public demo can be
///         driven end to end while the real circuit is still compiling.
///
/// @dev    This is not a weakened verifier, it is no verifier. Anything calling an escrow
///         wired to this can settle it with eight zeroes. It is named for what it is, it
///         announces itself on chain through `IS_STUB`, and the interface reads that flag
///         to put a warning on every screen.
contract StubVerifier is IGroth16Verifier {
    /// @notice Always true. Read by the front end to label the deployment honestly.
    bool public constant IS_STUB = true;

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[4] calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

/// @notice Deploys Alert to a public testnet against the stub above.
///
/// @dev    WHY THIS EXISTS.
///
///         The live URL has been showing a correct but inert app: contracts undeployed,
///         every action disabled. Judges and voters click a link and find a dead form.
///
///         This makes the escrow, the amount binding, the replay guard, the relayer
///         property and the refund path all genuinely usable on a public chain, while
///         the one thing that is not real says so loudly in three places: the contract
///         name, the IS_STUB flag, and a banner the interface refuses to hide.
///
///         `Deploy.s.sol` is the real one and takes VERIFIER_ADDRESS from the registry.
///         When the circuit lands, that replaces this. The escrow's verifier is
///         immutable by design, so swapping means a fresh deployment either way.
///
///         Run it without putting a key in your shell history:
///           forge script script/DeployDemo.s.sol:DeployDemo \
///             --rpc-url https://sepolia.base.org --broadcast --interactive 1
contract DeployDemo is Script {
    /// Circle's USDC on Base Sepolia.
    address constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    string constant BANK_DOMAIN = "moniepoint.com";

    function run() external {
        address usdc = vm.envOr("USDC_ADDRESS", USDC_BASE_SEPOLIA);
        require(usdc.code.length > 0, "no USDC contract at that address on this chain");

        vm.startBroadcast();

        StubVerifier stub = new StubVerifier();
        AlertProofAdapter adapter = new AlertProofAdapter(IGroth16Verifier(address(stub)), BANK_DOMAIN);
        AlertEscrow escrow = new AlertEscrow(IERC20(usdc), IAlertVerifier(address(adapter)));

        vm.stopBroadcast();

        // Refuse to report success on a half-wired deployment. An escrow whose adapter is
        // pinned to a different bank refuses every `open` with BankNotSupported, which is
        // far cheaper to catch here than from a user's failed transaction.
        require(
            adapter.expectedBankDomainHash() == AlertHash.fromString(BANK_DOMAIN),
            "adapter domain mismatch"
        );
        require(address(escrow.verifier()) == address(adapter), "escrow not wired to adapter");
        require(address(escrow.usdc()) == usdc, "escrow not wired to USDC");

        console.log("chain              ", block.chainid);
        console.log("USDC               ", usdc);
        console.log("StubVerifier       ", address(stub));
        console.log("AlertProofAdapter  ", address(adapter));
        console.log("AlertEscrow        ", address(escrow));
        console.log("");
        console.log("PROOFS ARE NOT VERIFIED IN THIS DEPLOYMENT.");
        console.log("Set CONFIG.escrow to the AlertEscrow address and keep the stub banner on.");
    }
}
