import { EXECUTION_DELAY_THRESHOLD_MS } from "@/lib/constants";
import { rateLimiters } from "@/lib/rate-limiter";
import type { TransactionAnalysisResult } from "@/lib/types";

// ETH pseudo-address used by DeFiLlama
const ETH_NULL_ADDRESS = "0x0000000000000000000000000000000000000000";
const ETH_LLAMA_KEY = "coingecko:ethereum";

/**
 * Batch-fetch current USD prices from DeFiLlama.
 *
 * DeFiLlama is free, needs no API key, supports CORS, and accepts
 * comma-separated token lists for batch pricing.
 *
 * Returns a map of lowercase token address → USD price.
 */
async function batchGetTokenPrices(
  tokenAddresses: string[]
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (tokenAddresses.length === 0) return prices;

  // Build DeFiLlama coin keys — "ethereum:{address}" for ERC-20, special key for ETH
  const coinKeys = tokenAddresses.map((addr) => {
    if (addr.toLowerCase() === ETH_NULL_ADDRESS) return ETH_LLAMA_KEY;
    return `ethereum:${addr}`;
  });

  // DeFiLlama accepts up to ~100 coins per call; batch in chunks
  const CHUNK_SIZE = 80;
  for (let i = 0; i < coinKeys.length; i += CHUNK_SIZE) {
    const chunk = coinKeys.slice(i, i + CHUNK_SIZE);
    const chunkAddresses = tokenAddresses.slice(i, i + CHUNK_SIZE);

    try {
      await rateLimiters.defillama.execute(async () => {
        const url = `https://coins.llama.fi/prices/current/${chunk.join(",")}`;
        const response = await fetch(url);

        if (!response.ok) {
          console.warn(`[pricer] DeFiLlama returned ${response.status} for batch of ${chunk.length} tokens`);
          return;
        }

        const data = await response.json();
        const coins = data.coins || {};

        for (let j = 0; j < chunk.length; j++) {
          const key = chunk[j];
          const addr = chunkAddresses[j].toLowerCase();
          if (coins[key]?.price != null) {
            prices.set(addr, coins[key].price);
          }
        }
      });
    } catch (error) {
      console.error(`[pricer] Error fetching DeFiLlama prices:`, error);
      // Non-fatal: tokens in this chunk will remain unpriced (0)
    }
  }

  const priced = prices.size;
  const unpriced = tokenAddresses.length - priced;
  if (unpriced > 0) {
    console.warn(`[pricer] ${unpriced} of ${tokenAddresses.length} tokens have no DeFiLlama price`);
  }

  return prices;
}

/**
 * Convert a raw token gap to USD using a pre-fetched price.
 *
 * Uses safe BigInt division to avoid Number overflow on large amounts:
 *   whole = gap / divisor   (integer part — safe as Number for any realistic amount)
 *   frac  = gap % divisor   (fractional part — always < divisor, safe as Number)
 *   result = (whole + frac / divisor) * price
 */
function gapToUsd(gapRaw: string, price: number, decimals: number): number {
  if (price === 0) return 0;

  try {
    const gap = BigInt(gapRaw);
    const divisor = BigInt(10 ** Math.min(decimals, 18)); // clamp to avoid BigInt overflow on exotic decimals

    const whole = gap / divisor;
    const frac = gap % divisor;
    const gapInTokens = Number(whole) + Number(frac) / Number(divisor);

    return gapInTokens * price;
  } catch (error) {
    console.error(`[pricer] Error converting gap to USD:`, error);
    return 0;
  }
}

/**
 * Categorize MEV loss type
 */
function categorizeGapType(
  inclusionDelayMs: number | undefined,
  isSandwiched: boolean
): "sandwich" | "delay" | "slippage" {
  if (isSandwiched) {
    return "sandwich";
  }

  if (inclusionDelayMs && inclusionDelayMs > EXECUTION_DELAY_THRESHOLD_MS) {
    return "delay";
  }

  return "slippage";
}

/**
 * Calculate MEV losses for all transactions.
 *
 * Fetches prices in a single batch call to DeFiLlama (instead of 1 call per tx),
 * then applies prices locally.
 */
export async function calculateGaps(
  results: TransactionAnalysisResult[],
  userAddress: string
): Promise<TransactionAnalysisResult[]> {
  // Collect unique token addresses and batch-fetch prices
  const uniqueTokens = [...new Set(results.map((r) => r.tokenAddress).filter(Boolean))];
  console.log(`[pricer] Fetching prices for ${uniqueTokens.length} unique tokens via DeFiLlama`);
  const priceMap = await batchGetTokenPrices(uniqueTokens);

  const updated: TransactionAnalysisResult[] = [];

  for (const result of results) {
    try {
      const price = priceMap.get(result.tokenAddress.toLowerCase()) || 0;

      const gapUsd = gapToUsd(
        result.gapRaw,
        price,
        18 // Default ERC20 decimals
      );

      const gapType = categorizeGapType(
        result.inclusionDelayMs,
        result.isSandwiched
      );

      updated.push({
        ...result,
        gapUsd,
        gapType,
      });
    } catch (error) {
      console.error(`Error calculating gap for ${result.txHash}:`, error);
      updated.push({
        ...result,
        gapUsd: 0,
      });
    }
  }

  return updated;
}

/**
 * Calculate summary statistics
 */
export function calculateSummary(results: TransactionAnalysisResult[]) {
  const totalLossUsd = results.reduce((sum, r) => sum + r.gapUsd, 0);
  const sandwichLossUsd = results
    .filter((r) => r.gapType === "sandwich")
    .reduce((sum, r) => sum + r.gapUsd, 0);
  const delayLossUsd = results
    .filter((r) => r.gapType === "delay")
    .reduce((sum, r) => sum + r.gapUsd, 0);
  const slippageLossUsd = results
    .filter((r) => r.gapType === "slippage")
    .reduce((sum, r) => sum + r.gapUsd, 0);

  const worstTx = results.reduce((max, r) =>
    r.gapUsd > (max?.gapUsd || 0) ? r : max
  );

  const avgDelayMs =
    results.length > 0
      ? Math.round(
          results.reduce((sum, r) => sum + (r.inclusionDelayMs || 0), 0) /
            results.length
        )
      : 0;

  return {
    totalLossUsd,
    sandwichLossUsd,
    delayLossUsd,
    slippageLossUsd,
    txsAnalyzed: results.length,
    txsSandwiched: results.filter((r) => r.isSandwiched).length,
    worstTxHash: worstTx?.txHash,
    worstTxLossUsd: worstTx?.gapUsd || 0,
    avgDelayMs,
  };
}
