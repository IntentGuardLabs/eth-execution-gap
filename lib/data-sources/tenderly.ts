import axios from "axios";
import { retryWithBackoff } from "@/lib/utils";
import { rateLimiters } from "@/lib/rate-limiter";
import { API_RATE_LIMITS } from "@/lib/constants";
import type { SimulationResult } from "@/lib/types";

const TENDERLY_API_URL = "https://api.tenderly.co/api/v1";

// Generous gas limit for simulations — avoids OOG on complex DeFi txs
const SIMULATION_GAS_LIMIT = 8_000_000;

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
 * Simulate a transaction at a specific block state
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
  blockNumber: number
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
    console.log(`[tenderly] Simulating tx from=${txData.from.slice(0,10)}... to=${txData.to.slice(0,10)}... at block ${blockNumber}`);
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
              save: false,
              save_if_fails: false,
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
      console.warn(`[tenderly] Simulation returned no transaction object at block ${blockNumber}`);
      return null;
    }

    const assetChanges = response.transaction.transaction_info?.asset_changes || [];
    console.log(`[tenderly] Simulation success at block ${blockNumber}: ${assetChanges.length} asset changes`);

    return {
      transaction_info: {
        asset_changes: assetChanges,
      },
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const status = (error as any)?.response?.status;
    console.error(`[tenderly] FAILED simulating at block ${blockNumber}: ${status ? `HTTP ${status} — ` : ""}${errMsg}`);
    return null;
  }
}

/**
 * Get asset changes from simulation result
 */
export function extractAssetChanges(
  result: SimulationResult | null
): Array<{
  type: string;
  from: string;
  to: string;
  token_info?: {
    address: string;
    symbol: string;
    decimals: number;
  };
  amount: string;
}> {
  if (!result?.transaction_info?.asset_changes) {
    return [];
  }

  return result.transaction_info.asset_changes;
}

/**
 * Compute net token flows for a wallet from simulation asset changes.
 *
 * Returns an array of per-token net amounts:
 *   net > 0 → wallet received tokens
 *   net < 0 → wallet sent tokens
 *
 * This replaces the previous "first positive transfer" approach,
 * which missed multi-hop swaps and partial fills.
 */
export function computeNetTokenFlows(
  changes: Array<{
    type: string;
    from: string;
    to: string;
    token_info?: {
      address: string;
      symbol: string;
      decimals: number;
    };
    amount: string;
  }>,
  userAddress: string
): Array<{ tokenAddress: string; symbol: string; decimals: number; net: bigint }> {
  const user = userAddress.toLowerCase();
  const netByToken = new Map<string, { symbol: string; decimals: number; net: bigint }>();

  for (const change of changes) {
    if (change.type !== "ERC20" || !change.token_info?.address) continue;

    const tokenAddr = change.token_info.address.toLowerCase();
    const entry = netByToken.get(tokenAddr) || {
      symbol: change.token_info.symbol || "???",
      decimals: change.token_info.decimals || 18,
      net: BigInt(0),
    };

    const amt = BigInt(change.amount);

    // Inflow to wallet
    if (change.to.toLowerCase() === user) {
      entry.net += amt;
    }
    // Outflow from wallet
    if (change.from.toLowerCase() === user) {
      entry.net -= amt;
    }

    netByToken.set(tokenAddr, entry);
  }

  return Array.from(netByToken.entries()).map(([tokenAddress, { symbol, decimals, net }]) => ({
    tokenAddress,
    symbol,
    decimals,
    net,
  }));
}

/**
 * Get the primary token output for the wallet from asset changes.
 *
 * For a swap, this is the token with the largest positive net flow
 * (the token the user received in exchange for what they sent).
 */
export function getTokenOutputFromChanges(
  changes: Array<{
    type: string;
    from: string;
    to: string;
    token_info?: {
      address: string;
      symbol: string;
      decimals: number;
    };
    amount: string;
  }>,
  userAddress: string
): { amount: string; tokenAddress: string; symbol?: string } | null {
  const flows = computeNetTokenFlows(changes, userAddress);

  // Find the token with the largest positive net flow (what the user received)
  const received = flows
    .filter((f) => f.net > BigInt(0))
    .sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0));

  if (received.length === 0) return null;

  const best = received[0];
  return {
    amount: best.net.toString(),
    tokenAddress: best.tokenAddress,
    symbol: best.symbol,
  };
}
