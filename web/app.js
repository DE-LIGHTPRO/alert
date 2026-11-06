// Alert — escrow front end.
//
// Loaded as a module from a CDN rather than bundled. npm on this machine refuses git
// dependencies (`allow-git=none`) and @zk-email/sdk pulls a snarkjs fork over git, so a
// build step would have been a second problem to solve before the first one shipped.
// esm.sh serves viem as plain ESM and the whole app stays a static file.

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  formatUnits,
  parseUnits,
  keccak256,
  toHex,
  stringToBytes,
} from "https://esm.sh/viem@2.21.54";
import { baseSepolia } from "https://esm.sh/viem@2.21.54/chains";

// --------------------------------------------------------------- configuration

// Filled in after `forge script script/Deploy.s.sol:Deploy`. Deliberately empty until
// then: an address invented to make the UI render would be the exact defect this
// project's rules exist to prevent.
const DEFAULTS = {
  escrow: "",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Circle USDC, Base Sepolia
  rpc: "", // empty means viem's default for the chain
  chainId: 84532,
  explorer: "https://sepolia.basescan.org",
  bankDomain: "moniepoint.com",
};

// An override lets the SHIPPED page be pointed at a local chain, so the production build
// itself can be driven end to end instead of a copy of it that might differ. Set it with:
//   localStorage.setItem("alert-config", JSON.stringify({escrow:"0x…", rpc:"http://localhost:8545", chainId:31337}))
// Wrapped because localStorage throws in a private window, and a config override must
// never be the reason the page fails to load.
function loadConfig() {
  try {
    const raw = localStorage.getItem("alert-config");
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (e) {}
  return { ...DEFAULTS };
}

export const CONFIG = loadConfig();

const ESCROW_ABI = parseAbi([
  "function open(address buyer, uint128 usdcAmount, string nairaAmountText, string recipientMasked, bytes32 bankDomainHash, uint64 deadline) returns (uint256)",
  "function refund(uint256 escrowId)",
  "function settle(uint256 escrowId, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[4] pubSignals)",
  "function nextEscrowId() view returns (uint256)",
  "function amountClaimed(bytes32) view returns (bool)",
  "function nullifierSpent(bytes32) view returns (bool)",
  "function getEscrow(uint256) view returns ((address seller,address buyer,uint128 usdcAmount,uint64 deadline,uint8 status,bytes32 amountHash,bytes32 recipientHash,bytes32 bankDomainHash))",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const STATUS = ["None", "Open", "Settled", "Refunded"];

// --------------------------------------------------------------- field hashing

// The JS half of contracts/src/AlertHash.sol. A Groth16 public signal is a BN254 field
// element of about 254 bits and keccak256 produces 256, so every hash crossing that
// boundary is truncated to 248 bits. Both sides must agree exactly: if this masked and
// the contract did not, every settlement would revert with WrongAmount on an amount that
// is perfectly correct.
const FIELD_MASK = (1n << 248n) - 1n;

export function fieldHash(s) {
  const full = BigInt(keccak256(stringToBytes(s)));
  return toHex(full & FIELD_MASK, { size: 32 });
}

// --------------------------------------------------------------- kobo allocation

// The amount IS the binding. Moniepoint overwrites the transfer narration with its own
// template, so a per-trade code cannot ride along in it (CLAUDE.md rule 2). Instead each
// escrow gets a unique kobo value, and the contract refuses two open escrows that share
// an amount.
export function formatNaira(whole, kobo) {
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${grouped}.${String(kobo).padStart(2, "0")}`;
}

/// Finds a kobo suffix whose amount no open escrow has claimed.
export async function allocateKobo(publicClient, wholeNaira) {
  if (!CONFIG.escrow) throw new Error("Escrow address not configured");
  // Start somewhere other than 0 so the common case does not always collide.
  const start = Math.floor(Math.random() * 100);
  for (let i = 0; i < 100; i++) {
    const kobo = (start + i) % 100;
    const text = formatNaira(wholeNaira, kobo);
    const claimed = await publicClient.readContract({
      address: CONFIG.escrow,
      abi: ESCROW_ABI,
      functionName: "amountClaimed",
      args: [fieldHash(text)],
    });
    if (!claimed) return { kobo, text };
  }
  throw new Error("All 100 kobo values for that amount are in use. Pick a different naira figure.");
}

// --------------------------------------------------------------- chain clients

/// The chain the page is pointed at. Base Sepolia unless an override says otherwise.
export const chain =
  CONFIG.chainId === baseSepolia.id
    ? baseSepolia
    : {
        ...baseSepolia,
        id: CONFIG.chainId,
        name: `chain ${CONFIG.chainId}`,
        rpcUrls: { default: { http: [CONFIG.rpc] } },
      };

export function makePublicClient() {
  return createPublicClient({ chain, transport: http(CONFIG.rpc || undefined) });
}

export async function connect() {
  if (!window.ethereum) throw new Error("No wallet found. Install a browser wallet to continue.");
  const walletClient = createWalletClient({ chain, transport: custom(window.ethereum) });
  const [account] = await walletClient.requestAddresses();

  const chainId = await walletClient.getChainId();
  if (chainId !== chain.id) {
    try {
      await walletClient.switchChain({ id: chain.id });
    } catch (e) {
      // Not yet added to the wallet.
      await walletClient.addChain({ chain });
      await walletClient.switchChain({ id: chain.id });
    }
  }
  return { walletClient, account };
}

// --------------------------------------------------------------- reads

export async function readEscrow(publicClient, id) {
  const e = await publicClient.readContract({
    address: CONFIG.escrow,
    abi: ESCROW_ABI,
    functionName: "getEscrow",
    args: [BigInt(id)],
  });
  return {
    seller: e.seller,
    buyer: e.buyer,
    usdcAmount: e.usdcAmount,
    usdcText: formatUnits(e.usdcAmount, 6),
    deadline: Number(e.deadline),
    status: STATUS[e.status] ?? "Unknown",
    statusCode: e.status,
    amountHash: e.amountHash,
    recipientHash: e.recipientHash,
    bankDomainHash: e.bankDomainHash,
  };
}

export async function escrowCount(publicClient) {
  return await publicClient.readContract({
    address: CONFIG.escrow,
    abi: ESCROW_ABI,
    functionName: "nextEscrowId",
  });
}

// --------------------------------------------------------------- writes

export async function openEscrow(walletClient, account, publicClient, params) {
  const { buyer, usdc, nairaAmountText, recipientMasked, hours } = params;
  const usdcAmount = parseUnits(String(usdc), 6);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + hours * 3600);

  // Exact approval, never maxUint256. An unlimited approval outlives the trade and is
  // what a later compromise of the spender inherits.
  const allowance = await publicClient.readContract({
    address: CONFIG.usdc,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account, CONFIG.escrow],
  });

  if (allowance < usdcAmount) {
    const approveHash = await walletClient.writeContract({
      address: CONFIG.usdc,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [CONFIG.escrow, usdcAmount],
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  const hash = await walletClient.writeContract({
    address: CONFIG.escrow,
    abi: ESCROW_ABI,
    functionName: "open",
    args: [
      buyer,
      usdcAmount,
      nairaAmountText,
      recipientMasked,
      fieldHash(CONFIG.bankDomain),
      deadline,
    ],
    account,
  });
  return await publicClient.waitForTransactionReceipt({ hash });
}

/// Releases the escrow against a proof. Deliberately callable by anyone, so this works
/// whether the buyer sends it themselves or hands it to a relayer: the destination is
/// fixed on chain and a relayer cannot redirect it.
export async function settleEscrow(walletClient, account, publicClient, id, args) {
  const { pA, pB, pC, pubSignals } = args;
  const hash = await walletClient.writeContract({
    address: CONFIG.escrow,
    abi: ESCROW_ABI,
    functionName: "settle",
    args: [BigInt(id), pA, pB, pC, pubSignals],
    account,
  });
  return await publicClient.waitForTransactionReceipt({ hash });
}

export async function refundEscrow(walletClient, account, publicClient, id) {
  const hash = await walletClient.writeContract({
    address: CONFIG.escrow,
    abi: ESCROW_ABI,
    functionName: "refund",
    args: [BigInt(id)],
    account,
  });
  return await publicClient.waitForTransactionReceipt({ hash });
}

// .eml reading lives in ./eml.js, which imports nothing, so it can be tested in node
// against the real fixtures (`node web/eml.test.mjs`). Re-exported here only so callers
// have one import to reach for.
export { previewEml, missingFields, dewrap } from "./eml.js";
