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
  parseEventLogs,
  formatUnits,
  parseUnits,
} from "https://esm.sh/viem@2.21.54";
import { baseSepolia } from "https://esm.sh/viem@2.21.54/chains";

// --------------------------------------------------------------- configuration

// Filled in after `forge script script/Deploy.s.sol:Deploy`. Deliberately empty until
// then: an address invented to make the UI render would be the exact defect this
// project's rules exist to prevent.
const DEFAULTS = {
  escrow: "0xE6434AC3952D9EDEfe0107B47457a987CAc6211B",
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
  "function settle(uint256 escrowId, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[9] pubSignals)",
  "function nextEscrowId() view returns (uint256)",
  "function verifier() view returns (address)",
  "function amountClaimed(bytes32) view returns (bool)",
  "function nullifierSpent(bytes32) view returns (bool)",
  "function getEscrow(uint256) view returns ((address seller,address buyer,uint128 usdcAmount,uint64 deadline,uint8 status,bytes32 amountHash,bytes32 recipientHash,bytes32 bankDomainHash))",
  "event EscrowOpened(uint256 indexed escrowId, address indexed seller, address indexed buyer, uint128 usdcAmount, string nairaAmountText, uint64 deadline)",
]);

const ADAPTER_ABI = parseAbi([
  "function groth16() view returns (address)",
  "function expectedBankDomainHash() view returns (bytes32)",
]);

// A stub verifier announces itself. Read from the chain rather than a config flag,
// because a flag is a claim about the deployment and this is the deployment answering.
const STUB_ABI = parseAbi(["function IS_STUB() view returns (bool)"]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const STATUS = ["None", "Open", "Settled", "Refunded"];

// --------------------------------------------------------------- field hashing

// The hash lives in web/hash.js so a script can import it outside a browser and generate
// the vectors contracts/test/CrossLanguageHash.t.sol asserts. Re-exported here because
// callers already import it from this module.
// Imported AND re-exported, deliberately. `export { x } from "./y.js"` alone forwards the
// name to importers without binding it in this module's scope, and app.js calls
// fieldHash twice itself: once in allocateKobo and once in openEscrow. Written as a bare
// re-export, both threw "fieldHash is not defined" the moment a seller pressed Lock.
//
// Nothing could see it. There is no TypeScript here, the module parses and loads,
// ui.js and every probe that imports app.js gets a working fieldHash, and no test
// reaches openEscrow because it needs a wallet and a chain. It surfaced only by driving
// the real form against a local chain.
import { fieldHash, FIELD_MASK } from "./hash.js";
export { fieldHash, FIELD_MASK };

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

/// Is this deployment wired to a verifier that checks nothing?
///
/// Asked of the chain, not of our own config. The escrow names its adapter, the adapter
/// names its verifier, and a stub verifier exposes IS_STUB. A deployment cannot therefore
/// present itself as real by shipping a different front end, and the banner cannot drift
/// out of sync with what is actually deployed.
///
/// Returns true for a stub, false for a real verifier, and null when it cannot tell.
///
/// The three cases used to collapse into false: a real verifier, and an unreachable RPC,
/// and anything else that threw. The old comment acknowledged this and asked each caller
/// to treat a throw as unknown, which the callers had no way to do, because a throw and
/// a real verifier arrived as the same value.
///
/// That is fine for the app's warning banner, which only ever acts on true. It is not
/// fine for the receipt, where false is rendered as a positive claim that Moniepoint
/// signed something. A page must not assert an attestation because a network call failed.
///
/// Reachability is established separately: if the escrow names its adapter and the
/// adapter names its verifier, the chain answered, so a failing IS_STUB read after that
/// really does mean a verifier with no such function.
export async function verifierIsStub(publicClient) {
  if (!CONFIG.escrow) return null;
  let groth16;
  try {
    const adapter = await publicClient.readContract({
      address: CONFIG.escrow,
      abi: ESCROW_ABI,
      functionName: "verifier",
    });
    groth16 = await publicClient.readContract({
      address: adapter,
      abi: ADAPTER_ABI,
      functionName: "groth16",
    });
  } catch (e) {
    return null; // the chain did not answer: no opinion
  }
  try {
    return Boolean(
      await publicClient.readContract({ address: groth16, abi: STUB_ABI, functionName: "IS_STUB" })
    );
  } catch (e) {
    // The chain answered twice already, so this is a verifier without IS_STUB.
    return false;
  }
}

export async function escrowCount(publicClient) {
  return await publicClient.readContract({
    address: CONFIG.escrow,
    abi: ESCROW_ABI,
    functionName: "nextEscrowId",
  });
}

// --------------------------------------------------------------- writes

/// Waits for a transaction and refuses to call a revert a success.
///
/// Every write here awaited `waitForTransactionReceipt` and returned it unexamined. A
/// receipt means mined, not succeeded: a reverted transaction produces one too, with
/// `status: "reverted"` and no logs. Driving the refund path before its deadline, the
/// escrow correctly refused, the transaction was mined reverted, and the page reported
/// "Reclaimed." with a transaction hash while the USDC never moved and the escrow stayed
/// Open.
///
/// On the settle path the same bug tells a buyer their money was released when nothing
/// happened. A wallet usually estimates gas first and warns, which is why this survived,
/// but estimation is not a guarantee: the state can change between estimating and
/// mining, which is exactly what a deadline or a competing settle does.
///
/// Rule 45 of the sibling project, in transaction form. A receipt is not a success.
async function confirmed(publicClient, hash, what) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(
      `The ${what} transaction was mined but reverted, so nothing moved. ` +
        `Check the escrow's status and deadline before trying again.`
    );
  }
  return receipt;
}

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
    await confirmed(publicClient, approveHash, "approval");
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
  const receipt = await confirmed(publicClient, hash, "lock");

  // The escrow number, decoded from the event rather than read back as
  // nextEscrowId() - 1, which would name somebody else's trade if two opens land in the
  // same block. Without it the seller has a transaction hash and no way to tell the
  // buyer which escrow to look up, and the buyer's card asks for exactly that number.
  //
  // null when it cannot be found, never a guess: the caller says so rather than printing
  // a number that might belong to another trade.
  let escrowId = null;
  try {
    const [opened] = parseEventLogs({
      abi: ESCROW_ABI,
      eventName: "EscrowOpened",
      logs: receipt.logs,
    });
    if (opened) escrowId = Number(opened.args.escrowId);
  } catch (e) {
    escrowId = null;
  }
  return { receipt, escrowId };
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
  return await confirmed(publicClient, hash, "settle");
}

export async function refundEscrow(walletClient, account, publicClient, id) {
  const hash = await walletClient.writeContract({
    address: CONFIG.escrow,
    abi: ESCROW_ABI,
    functionName: "refund",
    args: [BigInt(id)],
    account,
  });
  return await confirmed(publicClient, hash, "refund");
}

// .eml reading lives in ./eml.js, which imports nothing, so it can be tested in node
// against the real fixtures (`node web/eml.test.mjs`). Re-exported here only so callers
// have one import to reach for.
export { previewEml, missingFields, dewrap } from "./eml.js";
