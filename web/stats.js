// Live numbers for the landing page, read from the chain.
//
// A landing page that states its own numbers in static HTML is indistinguishable from a
// mockup, and reads like one. These come from the escrow itself, so the page cannot
// claim a trade that did not happen, and it goes quiet rather than inventing a figure
// when the chain is unreachable.

import { makePublicClient, CONFIG } from "./app.js";
import { parseAbi, formatUnits } from "https://esm.sh/viem@2.21.54";

const ABI = parseAbi([
  "function nextEscrowId() view returns (uint256)",
  "function getEscrow(uint256) view returns ((address seller,address buyer,uint128 usdcAmount,uint64 deadline,uint8 status,bytes32 amountHash,bytes32 recipientHash,bytes32 bankDomainHash))",
]);

/// Walks every escrow and totals what actually moved.
///
/// Fine at this size and deliberately not cached: a stale number on a page whose whole
/// argument is "verify it yourself" would be the wrong corner to cut. If this ever grows
/// past a few hundred escrows it becomes an event query, not a loop.
export async function readStats() {
  if (!CONFIG.escrow) return null;
  const client = makePublicClient();

  const count = await client.readContract({
    address: CONFIG.escrow,
    abi: ABI,
    functionName: "nextEscrowId",
  });

  const n = Number(count);
  let settled = 0;
  let open = 0;
  let released = 0n;
  let locked = 0n;

  for (let i = 0; i < n; i++) {
    const e = await client.readContract({
      address: CONFIG.escrow,
      abi: ABI,
      functionName: "getEscrow",
      args: [BigInt(i)],
    });
    if (e.status === 2) {
      settled++;
      released += e.usdcAmount;
    } else if (e.status === 1) {
      open++;
      locked += e.usdcAmount;
    }
  }

  return {
    total: n,
    settled,
    open,
    releasedUsdc: formatUnits(released, 6),
    lockedUsdc: formatUnits(locked, 6),
  };
}
