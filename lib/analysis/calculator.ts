import { rateLimiters } from "@/lib/rate-limiter";
import { getCachedPrices, storePrices } from "@/lib/db";
import type { ProtocolSwapResult } from "@/lib/types";

// ETH pseudo-address used by DeFiLlama
const ETH_NULL_ADDRESS = "0x0000000000000000000000000000000000000000";
const ETH_LLAMA_KEY = "coingecko:ethereum";

/**
 * Batch-fetch current USD prices from DeFiLlama.
 *
 * DeFiLlama is free, needs no API key, supports CORS, and accepts
 * comma-separated token lists for batch pricing. Chunked at 80 tokens
 * per request (DeFiLlama accepts ~100 max).
 *
 * Returns a map of lowercase token address → USD price.
 */
async function batchGetTokenPrices(
  tokenAddresses: string[]
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (tokenAddresses.length === 0) return prices;

  const coinKeys = tokenAddresses.map((addr) => {
    if (addr.toLowerCase() === ETH_NULL_ADDRESS) return ETH_LLAMA_KEY;
    return `ethereum:${addr}`;
  });

  const CHUNK_SIZE = 80;
  for (let i = 0; i < coinKeys.length; i += CHUNK_SIZE) {
    const chunk = coinKeys.slice(i, i + CHUNK_SIZE);
    const chunkAddresses = tokenAddresses.slice(i, i + CHUNK_SIZE);

    try {
      await rateLimiters.defillama.execute(async () => {
        const url = `https://coins.llama.fi/prices/current/${chunk.join(",")}`;
        const response = await fetch(url);

        if (!response.ok) {
          console.warn(
            `[pricer] DeFiLlama returned ${response.status} for batch of ${chunk.length} tokens`
          );
          return;
        }

        const data = (await response.json()) as { coins?: Record<string, { price?: number }> };
        const coins = data.coins || {};

        for (let j = 0; j < chunk.length; j++) {
          const key = chunk[j];
          const addr = chunkAddresses[j];
          const coin = coins[key];
          if (coin && typeof coin.price === "number") {
            prices.set(addr.toLowerCase(), coin.price);
          }
        }
      });
    } catch (error) {
      console.error(
        `[pricer] Failed to fetch DeFiLlama prices for chunk:`,
        error
      );
    }
  }

  const missing = tokenAddresses.length - prices.size;
  if (missing > 0) {
    console.log(
      `[pricer] ${missing} of ${tokenAddresses.length} tokens have no DeFiLlama price`
    );
  }

  return prices;
}

/**
 * Resolve USD prices for a set of token addresses, hitting the local
 * file-based price cache first and falling back to DeFiLlama for the rest.
 */
export async function resolvePrices(
  tokenAddresses: string[]
): Promise<Map<string, number>> {
  const uniqueTokens = [
    ...new Set(tokenAddresses.map((t) => t.toLowerCase()).filter(Boolean)),
  ];
  if (uniqueTokens.length === 0) return new Map();

  const cached = await getCachedPrices(uniqueTokens);
  const uncached = uniqueTokens.filter((t) => !cached.has(t));
  console.log(
    `[pricer] resolvePrices: ${cached.size} cache hits, ${uncached.length} need DeFiLlama`
  );

  const fresh =
    uncached.length > 0
      ? await batchGetTokenPrices(uncached)
      : new Map<string, number>();

  if (fresh.size > 0) await storePrices(fresh);

  const merged = new Map<string, number>();
  for (const [a, p] of cached) merged.set(a, p);
  for (const [a, p] of fresh) merged.set(a, p);
  return merged;
}

/**
 * Price all protocol-mode swap results.
 *
 * v1.4 sign convention — NEGATIVE means the user lost USD on this swap.
 *   amountInGap  = expectedIn − actualIn   (negative ⇒ user paid more than predicted)
 *   amountOutGap = actualOut − expectedOut (negative ⇒ user received less than predicted)
 *   totalGapUsd  = amountInGapUsd + amountOutGapUsd  ≡  net_exec − net_sim
 *
 * Gap-computability gate: a row is only USD-priceable when
 * `simulationStatus == "ok"` AND both sims produced at least one real flow
 * on a target token. When the gate fails, the raw delta is the entire
 * trade size (HR-5 substitutes BigInt(0) for the missing side), not a
 * real gap, so we zero the USD fields. Raw amounts are preserved for audit.
 */
export async function priceProtocolSwaps(
  swaps: ProtocolSwapResult[]
): Promise<ProtocolSwapResult[]> {
  if (swaps.length === 0) return swaps;

  const allTokens = swaps.flatMap((s) => [s.tokenIn, s.tokenOut]);
  const priceMap = await resolvePrices(allTokens);

  let computable = 0;
  let nonComputable = 0;

  const out = swaps.map((s) => {
    const priceIn = priceMap.get(s.tokenIn.toLowerCase()) ?? null;
    const priceOut = priceMap.get(s.tokenOut.toLowerCase()) ?? null;

    const expectedHasFlow =
      s.expectedAmountInRaw !== "0" || s.expectedAmountOutRaw !== "0";
    const actualHasFlow =
      s.actualAmountInRaw !== "0" || s.actualAmountOutRaw !== "0";
    const gapComputable =
      s.simulationStatus === "ok" && expectedHasFlow && actualHasFlow;

    if (!gapComputable) {
      nonComputable++;
      return {
        ...s,
        tokenInPriceUsd: priceIn,
        tokenOutPriceUsd: priceOut,
        amountInGapUsd: 0,
        amountOutGapUsd: 0,
        totalGapUsd: 0,
      };
    }
    computable++;

    const amountInGapUsd =
      priceIn != null
        ? signedGapToUsd(s.amountInGapRaw, priceIn, s.tokenInDecimals ?? 18)
        : 0;
    const amountOutGapUsd =
      priceOut != null
        ? signedGapToUsd(s.amountOutGapRaw, priceOut, s.tokenOutDecimals ?? 18)
        : 0;

    return {
      ...s,
      tokenInPriceUsd: priceIn,
      tokenOutPriceUsd: priceOut,
      amountInGapUsd,
      amountOutGapUsd,
      totalGapUsd: amountInGapUsd + amountOutGapUsd,
    };
  });

  if (nonComputable > 0) {
    console.log(
      `[pricer] ${computable}/${swaps.length} swaps gap-computable; ${nonComputable} non-computable excluded from USD aggregate`
    );
  }

  return out;
}

/**
 * Sign-preserving raw → USD conversion. Uses HR-6 safe BigInt division on
 * the absolute value, then re-applies sign.
 */
function signedGapToUsd(
  gapRaw: string,
  price: number,
  decimals: number
): number {
  if (price === 0) return 0;
  try {
    const gap = BigInt(gapRaw);
    if (gap === BigInt(0)) return 0;

    const negative = gap < BigInt(0);
    const abs = negative ? -gap : gap;

    const divisor = BigInt(10 ** Math.min(decimals, 18));
    const whole = abs / divisor;
    const frac = abs % divisor;
    const tokens = Number(whole) + Number(frac) / Number(divisor);
    const usd = tokens * price;
    return negative ? -usd : usd;
  } catch (err) {
    console.error(`[pricer] signedGapToUsd error:`, err);
    return 0;
  }
}
