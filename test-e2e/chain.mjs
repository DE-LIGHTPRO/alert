// Starts an anvil, deploys the real contracts to it, and hands back the addresses.
//
// The deployment is script/DeployLocal.s.sol, the same one used by hand, so the test
// drives the contracts that ship rather than a fixture shaped like them. Its mock USDC
// has USDC's 6 decimals and its mock verifier declares IS_STUB, exactly as the deployed
// StubVerifier does, so the page's stub banner behaves here as it does in production.

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const RPC = "http://127.0.0.1:8545";

/// anvil account #0. Unlocked, so eth_sendTransaction is signed by the node and the
/// page's own write path runs unchanged behind a minimal EIP-1193 shim.
export const SELLER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const SELLER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const BUYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

export async function rpc(method, params = []) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

export async function startAnvil() {
  const proc = spawn("anvil", ["--port", "8545", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      await rpc("eth_chainId");
      return proc;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  proc.kill();
  throw new Error("anvil did not answer on 8545 within 15s");
}

export async function deploy(cwd) {
  const { stdout } = await exec(
    "forge",
    ["script", "script/DeployLocal.s.sol:DeployLocal", "--rpc-url", RPC, "--broadcast"],
    { cwd, maxBuffer: 1 << 24 }
  );
  const grab = (label) => {
    const m = stdout.match(new RegExp(`${label}\\s+(0x[0-9a-fA-F]{40})`));
    return m && m[1];
  };
  const out = { usdc: grab("MockUSDC"), escrow: grab("AlertEscrow") };
  // A missing address would otherwise surface as the page quietly reading address zero,
  // which looks like an empty chain rather than a broken deployment.
  for (const [k, v] of Object.entries(out)) {
    if (!v) throw new Error(`could not read ${k} from the deploy output`);
  }
  return out;
}

/// Moves the chain past a deadline. Refund cannot be exercised any other way.
export async function advanceSeconds(s) {
  await rpc("evm_increaseTime", [s]);
  await rpc("evm_mine", []);
}
