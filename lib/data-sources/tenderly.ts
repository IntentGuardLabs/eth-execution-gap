import axios from "axios";
import { retryWithBackoff } from "@/lib/utils";
import { rateLimiters } from "@/lib/rate-limiter";
import { API_RATE_LIMITS } from "@/lib/constants";
import type { SimulationResult, TenderlyAssetChange } from "@/lib/types";

const TENDERLY_API_URL = "https://api.tenderly.co/api/v1";

// Generous gas limit for simulations — avoids OOG on complex DeFi txs (HR-2).
// Exported so callers that build txData can reference the same constant
// rather than hard-coding "8000000".
export const SIMULATION_GAS_LIMIT = 8_000_000;

/**
 * Convert a decimal string to hex with 0x prefix (Tenderly requires this for value)
 */
function toHex(decimalStr: string): string {
  if (!decimalStr || decimalStr === "0") return "0x0";
  try {
    return "0x" + BigInt(decimalStr).toString(16);
  } catch {
    return "0x0";
  }
}

/**
 * Simulate a transaction at a specific block AND position within that
 * block.
 *
 * `transactionIndex` semantics (Tenderly v1 `simulate`, `simulation_type: "full"`):
 *   - `0`  → the sim runs at the HEAD of `blockNumber`, before any of the
 *             txs that were included in that block. This is the right
 *             choice for the "expected outcome" (mempool-arrival) sim:
 *             we want the state the user's wallet would have observed
 *             when the tx was assembled.
 *   - `n`  → the sim runs at position `n`, with all `transaction_index < n`
 *             already executed. For the "actual outcome" sim, pass the
 *             tx's real on-chain `transactionIndex` so the simulation
 *             environment matches the position the tx actually landed at.
 *   - omitted → Tenderly defaults to running AT THE END of the block,
 *             which is wrong for both sides of the gap analysis. We
 *             always pass an explicit value.
 */
export async function simulateTransaction(
  txData: {
    from: string;
    to: string;
    input: string;
    value: string;
    gas: string;
    gasPrice: string;
  },
  blockNumber: number,
  transactionIndex: number = 0
): Promise<SimulationResult | null> {
  const account = process.env.TENDERLY_ACCOUNT;
  const project = process.env.TENDERLY_PROJECT;
  const apiKey = process.env.TENDERLY_API_KEY;

  if (!account || !project || !apiKey) {
    console.error(`[tenderly] Missing config: account=${!!account}, project=${!!project}, apiKey=${!!apiKey}`);
    throw new Error(
      "Tenderly configuration incomplete. Please set TENDERLY_ACCOUNT, TENDERLY_PROJECT, and TENDERLY_API_KEY."
    );
  }

  const simUrl = `${TENDERLY_API_URL}/account/${account}/project/${project}/simulate`;

  try {
    console.log(
      `[tenderly] Simulating tx from=${txData.from.slice(0, 10)}... to=${txData.to.slice(0, 10)}... at block ${blockNumber} index ${transactionIndex}`
    );
    console.log(`[tenderly] POST ${simUrl}`);

    const response = await retryWithBackoff(
      async () => {
        return await rateLimiters.tenderly.execute(async () => {
          const { data } = await axios.post(
            simUrl,
            {
              network_id: "1",
              from: txData.from,
              to: txData.to,
              input: txData.input,
              value: toHex(txData.value),
              gas: SIMULATION_GAS_LIMIT,
              gas_price: toHex(txData.gasPrice),
              block_number: blockNumber,
              transaction_index: transactionIndex,
              save: false,
              save_if_fails: false,
              simulation_type: "full",
            },
            {
              headers: {
                "X-Access-Key": apiKey,
                "Content-Type": "application/json",
              },
              timeout: API_RATE_LIMITS.TENDERLY_SIMULATION_TIMEOUT_MS,
            }
          );

          return data;
        });
      },
      2,
      2000
    );

    if (!response.transaction) {
      console.warn(
        `[tenderly] Simulation returned no transaction object at block ${blockNumber} index ${transactionIndex}`
      );
      return null;
    }

    // Tenderly returns `transaction.status` (boolean): true = the simulated
    // EVM execution succeeded; false = it reverted. On revert, `asset_changes`
    // is typically empty — callers MUST treat this differently from a clean
    // zero-flow run, otherwise the gap math compares "tx reverted" against
    // "tx executed" and reports the entire trade as a gap (false signal).
    const status: boolean = response.transaction.status !== false;
    const errorMessage: string | undefined =
      response.transaction.error_message || undefined;
    const assetChanges = response.transaction.transaction_info?.asset_changes || [];

    if (!status) {
      console.warn(
        `[tenderly] Simulation REVERTED at block ${blockNumber} index ${transactionIndex}: ${errorMessage ?? "(no error_message)"}`
      );
    } else {
      console.log(
        `[tenderly] Simulation success at block ${blockNumber} index ${transactionIndex}: ${assetChanges.length} asset changes`
      );
    }

    return {
      transaction_info: {
        asset_changes: assetChanges,
      },
      status,
      errorMessage,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const status = (error as any)?.response?.status;
    console.error(
      `[tenderly] FAILED simulating at block ${blockNumber} index ${transactionIndex}: ${status ? `HTTP ${status} — ` : ""}${errMsg}`
    );
    return null;
  }
}

// Native ETH pseudo-address for net flow tracking (HR-9)
const ETH_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Compute net token flows for a wallet from simulation asset changes.
 *
 * Returns an array of per-token net amounts:
 *   net > 0 → wallet received tokens
 *   net < 0 → wallet sent tokens
 *
 * Uses the **real** Tenderly asset_changes shape (corrected 2026-04-15):
 *
 *   - Token contract address comes from `token_info.contract_address`
 *     (NOT `token_info.address` — that field doesn't exist).
 *   - ERC-20 vs. native ETH is discriminated via `token_info.standard`
 *     (`"ERC20"` vs. `"NativeCurrency"`), NOT via the top-level `type`
 *     (which is an event label: `"Mint"` / `"Transfer"` / `"Burn"`).
 *   - BigInt amounts come from `raw_amount` (wei/base-unit string).
 *     The `amount` field is a human-readable decimal string unsuitable
 *     for BigInt math.
 *   - `Mint` events have `from === undefined` (minted from nothing);
 *     `Burn` events sometimes omit `to`. The user checks short-circuit
 *     on undefined so these are handled correctly.
 *
 * Includes native ETH transfers (HR-9) under the zero address with 18
 * decimals. Non-fungibles (ERC-721/1155) and anything with an unknown
 * `standard` are logged and dropped.
 */
export function computeNetTokenFlows(
  changes: TenderlyAssetChange[],
  userAddress: string
): Array<{ tokenAddress: string; symbol: string; decimals: number; net: bigint }> {
  const user = userAddress.toLowerCase();
  const netByToken = new Map<string, { symbol: string; decimals: number; net: bigint }>();

  console.log(`[tenderly] computeNetTokenFlows: ${changes.length} changes for user ${user.slice(0, 10)}...`);

  for (const change of changes) {
    const ti = change.token_info;
    if (!ti) {
      // A truly token_info-less entry is rare in the v1 "full" response,
      // but if it happens we have nothing to key the flow on.
      console.log(
        `[tenderly]   SKIP no token_info: type=${change.type} amount=${change.amount} from=${change.from?.slice(0, 10) ?? "null"} to=${change.to?.slice(0, 10) ?? "null"}`
      );
      continue;
    }

    let tokenAddr: string;
    let symbol: string;
    const decimals = ti.decimals ?? 18;

    if (ti.standard === "NativeCurrency") {
      // Native ETH (HR-9). contract_address is absent; the flow gets keyed
      // under the zero-address pseudo-token for consistency with downstream
      // decoder tokenIn/tokenOut resolution for ETH-in/out swap methods.
      tokenAddr = ETH_ADDRESS;
      symbol = "ETH";
    } else if (ti.standard === "ERC20" && ti.contract_address) {
      tokenAddr = ti.contract_address.toLowerCase();
      symbol = ti.symbol || "???";
    } else {
      // Non-fungibles (ERC-721/1155), unclassified, or ERC-20 missing a
      // contract address. Dropping is correct: we'd rather miss a gap
      // than score it against the wrong token bucket.
      console.log(
        `[tenderly]   SKIP: standard=${ti.standard} type=${change.type} contract=${ti.contract_address?.slice(0, 10) ?? "null"} symbol=${ti.symbol ?? "?"} amount=${change.amount}`
      );
      continue;
    }

    // Prefer raw_amount (BigInt-parseable wei string). Fall back to
    // truncated integer part of `amount` only for defensiveness — in
    // practice every observed Tenderly response has provided raw_amount.
    let amt: bigint;
    try {
      if (change.raw_amount) {
        amt = BigInt(change.raw_amount);
      } else {
        const rawAmount = change.amount?.includes(".")
          ? change.amount.split(".")[0]
          : change.amount;
        amt = BigInt(rawAmount || "0");
      }
    } catch {
      console.warn(
        `[tenderly]   amount parse failed: raw_amount=${change.raw_amount} amount=${change.amount}`
      );
      amt = BigInt(0);
    }

    const fromAddr = change.from?.toLowerCase();
    const toAddr = change.to?.toLowerCase();
    const fromMatch = fromAddr === user ? "FROM-USER" : "";
    const toMatch = toAddr === user ? "TO-USER" : "";
    console.log(
      `[tenderly]   ${symbol} (${tokenAddr.slice(0, 10)}...): raw=${amt.toString()} from=${fromAddr?.slice(0, 10) || "null"} to=${toAddr?.slice(0, 10) || "null"} ${fromMatch} ${toMatch}`.trim()
    );

    const entry = netByToken.get(tokenAddr) || {
      symbol,
      decimals,
      net: BigInt(0),
    };

    // Inflow to user (Mint to user, Transfer to user, etc.)
    if (toAddr === user) entry.net += amt;
    // Outflow from user (Transfer from user, Burn from user, etc.)
    if (fromAddr === user) entry.net -= amt;

    netByToken.set(tokenAddr, entry);
  }

  const result = Array.from(netByToken.entries()).map(([tokenAddress, { symbol, decimals, net }]) => ({
    tokenAddress,
    symbol,
    decimals,
    net,
  }));

  const positive = result.filter((f) => f.net > BigInt(0));
  const negative = result.filter((f) => f.net < BigInt(0));
  console.log(`[tenderly] Net flows: ${positive.length} positive, ${negative.length} negative, ${result.filter((f) => f.net === BigInt(0)).length} zero`);
  for (const f of result) {
    console.log(`[tenderly]   ${f.symbol}: net=${f.net.toString()} (${f.net > BigInt(0) ? "RECEIVED" : f.net < BigInt(0) ? "SENT" : "ZERO"})`);
  }

  return result;
}

