// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGroth16Verifier} from "../../src/IAlertVerifier.sol";

/// @dev Minimal 6-decimal token standing in for USDC on Base.
contract MockUSDC {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev A token that returns NOTHING from transfer/transferFrom, like USDT on mainnet.
///      Present so the escrow's return-data handling is exercised rather than assumed.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "balance");
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev A token whose transfer returns `false` instead of reverting. The escrow must
///      treat that as a failure; ignoring the return value is a classic drain.
contract FalseReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @dev Stands in for the Groth16 verifier zkEmail deploys. The real one checks a
///      pairing; this one answers however the test sets it, so escrow logic can be
///      tested independently of a circuit that does not exist yet.
contract MockGroth16Verifier is IGroth16Verifier {
    /// Announces itself the way script/DeployDemo.s.sol's StubVerifier does.
    ///
    /// Without this the local deployment accepted every proof while the page reported a
    /// real attestation, because verifierIsStub() can only recognise a stub that says so.
    /// A local chain that behaves unlike the deployed one is worse than no local chain:
    /// every UI check run against it silently measures the wrong thing.
    bool public constant IS_STUB = true;

    bool public shouldVerify = true;

    function setShouldVerify(bool v) external {
        shouldVerify = v;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[5] calldata)
        external
        view
        returns (bool)
    {
        return shouldVerify;
    }
}
