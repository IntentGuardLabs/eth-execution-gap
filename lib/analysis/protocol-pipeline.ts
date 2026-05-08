/**
 * Protocol swap evaluator (blueprint 02, Module P3).
 *
 * `evaluateSwap` is the per-tx primitive: simulate ×2, compute one-sided
 * raw deltas under the v1.4 sign convention, return a `ProtocolSwapResult`.
 * The CLI orchestrators in `cli/` compose this with the data sources.
 *
 * All HR rules are satisfied via reused primitives:
 *   HR-1/2: simulateTransaction() (tenderly.ts)
 *   HR-4/9: computeNetTokenFlows() (tenderly.ts)
 *   HR-5:   one-sided deltas treated as 0, not skipped
 *   HR-6/8: priceProtocolSwaps() (calculator.ts)
 *   HR-7:   DeFiLlama via resolvePrices() (calculator.ts)
 */

import {
  simulateTransaction,
  computeNetTokenFlows,
  SIMULATION_GAS_LIMIT,
} from "@/lib/data-sources/tenderly";
import { NATIVE_ETH_ADDRESS } from "@/lib/constants";
import type {
  DecodedUniV2Swap,
  ProtocolSwapResult,
  ProtocolTxRow,
  SimulationResult,
} from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// evaluateSwap: single-tx gap analysis via ×2 Tenderly simulation
// ─────────────────────────────────────────────────────────────────────────────

interface TokenFlow {
  amount: bigint;          // non-negative magnitude
  decimals: number;
  symbol: string;
  isPlaceholder: boolean;  // true when the target token was not present in the sim
}

/**
 * Extract the outflow of `tokenAddr` (tokens leaving the user) from a sim.
 * Returns null if the sim itself failed (caller decides how to handle HR-5).
 * Returns a placeholder (amount=0, isPlaceholder=true) if the sim succeeded
 * but the target token was never touched.
 */
function extractOutflow(
  sim: SimulationResult | null,
  user: string,
  tokenAddr: string
): TokenFlow | null {
  if (!sim) return null;
  const flows = computeNetTokenFlows(sim.transaction_info.asset_changes, user);
  const entry = flows.find((f) => f.tokenAddress === tokenAddr.toLowerCase());
  if (!entry) {
    return placeholderFlow(tokenAddr);
  }
  // net < 0 → user sent tokens → outflow = |net|. net >= 0 → user didn't spend → 0
  const amount = entry.net < BigInt(0) ? -entry.net : BigInt(0);
  return {
    amount,
    decimals: entry.decimals,
    symbol: entry.symbol,
    isPlaceholder: false,
  };
}

/**
 * Extract the inflow of `tokenAddr` (tokens received by the user) from a sim.
 */
function extractInflow(
  sim: SimulationResult | null,
  user: string,
  tokenAddr: string
): TokenFlow | null {
  if (!sim) return null;
  const flows = computeNetTokenFlows(sim.transaction_info.asset_changes, user);
  const entry = flows.find((f) => f.tokenAddress === tokenAddr.toLowerCase());
  if (!entry) {
    return placeholderFlow(tokenAddr);
  }
  const amount = entry.net > BigInt(0) ? entry.net : BigInt(0);
  return {
    amount,
    decimals: entry.decimals,
    symbol: entry.symbol,
    isPlaceholder: false,
  };
}

/**
 * Build a zero-valued placeholder flow for a token the sim never touched.
 * Decimals default to 18 — if a later sim side has a real flow, `firstTouched`
 * will surface the correct decimals. See EC-P3.4 for the residual risk when
 * neither side produces a real flow for the target token.
 */
function placeholderFlow(tokenAddr: string): TokenFlow {
  const isEth = tokenAddr.toLowerCase() === NATIVE_ETH_ADDRESS;
  return {
    amount: BigInt(0),
    decimals: 18,
    symbol: isEth ? "ETH" : "?",
    isPlaceholder: true,
  };
}

/**
 * Sim runner type — injected by `runProtocolAnalysis()`. Abstracts the
 * cache-check + Tenderly-call + batched-persist steps so `evaluateSwap`
 * stays focused on gap math.
 */
type SimRunner = (
  txData: {
    from: string;
    to: string;
    input: string;
    value: string;
    gas: string;
    gasPrice: string;
  },
  blockNumber: number,
  txHash: string
) => Promise<SimulationResult | null>;

/**
 * Fallback sim runner for standalone callers of `evaluateSwap` (e.g. tests,
 * one-off scripts) that don't want cache + batching. Just calls Tenderly
 * directly. Production flow through `runProtocolAnalysis()` always injects
 * a caching runner instead.
 */
const defaultSimRunner: SimRunner = (txData, blockNumber, _txHash) =>
  simulateTransaction(txData, blockNumber);

/**
 * Evaluate one decoded UniV2 swap: simulate at mempool + inclusion blocks,
 * compute tokenIn outflow and tokenOut inflow per side, and return the gap.
 *
 * HR-5: if ONE sim returns null, treat the missing side as zero. Only returns
 * `both_failed` when both sims are null.
 */
export async function evaluateSwap(
  decoded: DecodedUniV2Swap,
  row: ProtocolTxRow,
  runSim: SimRunner = defaultSimRunner
): Promise<ProtocolSwapResult> {
  const user = row.sender;

  // Resolve simulation blocks. Fallback: mempool block = inclusion - 1.
  const mempoolBlock =
    row.mempoolBlockNumber ?? row.inclusionBlockNumber - 1;
  const isEstimated = row.mempoolBlockNumber == null;

  const txData = {
    from: row.sender,
    to: row.to,
    input: row.calldata,
    value: row.value,
    // HR-2 is enforced inside simulateTransaction, which hardcodes 8M for all
    // sims. This field is part of the txData type contract; we pass the same
    // shared constant so any future HR-2 change propagates automatically.
    gas: String(SIMULATION_GAS_LIMIT),
    gasPrice: row.gasPrice,
  };

  // Run both sims in parallel — the injected runSim handles cache + batching.
  // Rate limiting happens inside simulateTransaction (cache-miss path only).
  const [simMempool, simInclusion] = await Promise.all([
    runSim(txData, mempoolBlock, row.txHash),
    runSim(txData, row.inclusionBlockNumber, row.txHash),
  ]);

  // Determine simulation status
  let simulationStatus: ProtocolSwapResult["simulationStatus"];
  if (!simMempool && !simInclusion) {
    simulationStatus = "both_failed";
  } else if (!simMempool) {
    simulationStatus = "mempool_failed";
  } else if (!simInclusion) {
    simulationStatus = "inclusion_failed";
  } else {
    simulationStatus = "ok";
  }

  // HR-5: even if one side failed, extract what we can. Missing side → 0.
  const expectedIn = extractOutflow(simMempool, user, decoded.tokenIn);
  const expectedOut = extractInflow(simMempool, user, decoded.tokenOut);
  const actualIn = extractOutflow(simInclusion, user, decoded.tokenIn);
  const actualOut = extractInflow(simInclusion, user, decoded.tokenOut);

  // When a whole sim failed (null), substitute a placeholder so the math stays
  // well-defined (HR-5). Placeholders from a null sim are still flagged so
  // `firstTouched` can prefer real-flow metadata for decimals/symbol.
  const eIn = expectedIn ?? placeholderFlow(decoded.tokenIn);
  const eOut = expectedOut ?? placeholderFlow(decoded.tokenOut);
  const aIn = actualIn ?? placeholderFlow(decoded.tokenIn);
  const aOut = actualOut ?? placeholderFlow(decoded.tokenOut);

  // Token metadata (HR-8): prefer whichever flow actually touched the token.
  // Falls back to the placeholder's default (18, "?") only when neither side
  // produced a real flow for the target token — see EC-P3.4.
  const inMeta = firstTouched([expectedIn, actualIn]);
  const outMeta = firstTouched([expectedOut, actualOut]);
  const tokenInDecimals = inMeta?.decimals ?? 18;
  const tokenOutDecimals = outMeta?.decimals ?? 18;
  const tokenInSymbol = inMeta?.symbol;
  const tokenOutSymbol = outMeta?.symbol;

  // Gaps (v1.4 sign convention — NEGATIVE = user lost that side)
  //   amountInGap  = expectedIn - actualIn    (negative = user PAID more than predicted)
  //   amountOutGap = actualOut - expectedOut  (negative = user RECEIVED less than predicted)
  // These raw deltas are only meaningful when both sims produced real flows for
  // the target tokens — the calculator's gap-computability gate (EC-P4.3) is
  // what prevents their USD projections from being trusted otherwise.
  const amountInGap = eIn.amount - aIn.amount;
  const amountOutGap = aOut.amount - eOut.amount;

  return {
    txHash: row.txHash,
    sender: row.sender,
    router: row.to,
    protocol: "uniswap-v2",

    method: decoded.method,
    selector: decoded.selector,
    isExactIn: decoded.isExactIn,
    tokenInIsNative: decoded.tokenInIsNative,
    tokenOutIsNative: decoded.tokenOutIsNative,
    tokenIn: decoded.tokenIn,
    tokenOut: decoded.tokenOut,
    tokenInSymbol,
    tokenOutSymbol,
    tokenInDecimals,
    tokenOutDecimals,
    pathJson: JSON.stringify(decoded.path),
    amountInParam: decoded.amountInParam,
    amountOutParam: decoded.amountOutParam,
    recipient: decoded.recipient,

    mempoolBlockNumber: row.mempoolBlockNumber,
    inclusionBlockNumber: row.inclusionBlockNumber,
    mempoolTimestampMs: row.mempoolTimestampMs,
    inclusionBlockTime: row.inclusionBlockTime,
    inclusionDelayMs: row.inclusionDelayMs,
    isEstimated,

    expectedAmountInRaw: eIn.amount.toString(),
    expectedAmountOutRaw: eOut.amount.toString(),
    actualAmountInRaw: aIn.amount.toString(),
    actualAmountOutRaw: aOut.amount.toString(),

    amountInGapRaw: amountInGap.toString(),
    amountOutGapRaw: amountOutGap.toString(),

    // P4 fills these
    tokenInPriceUsd: null,
    tokenOutPriceUsd: null,
    amountInGapUsd: 0,
    amountOutGapUsd: 0,
    totalGapUsd: 0,

    simulationStatus,
    error: simulationStatus === "both_failed" ? "both simulations failed" : undefined,
    rawCalldata: row.calldata,
  };
}

/**
 * Pick the first real (non-placeholder) flow among candidates so that
 * decimals/symbol come from Tenderly's `token_info`. If no real flow exists,
 * return the first placeholder so that callers still have a fallback (decimals
 * default to 18 — see EC-P3.4). Native ETH flows are counted as "real" when
 * they came from a non-placeholder sim entry.
 */
function firstTouched(
  candidates: Array<TokenFlow | null>
): TokenFlow | undefined {
  for (const c of candidates) {
    if (c && !c.isPlaceholder) return c;
  }
  for (const c of candidates) {
    if (c) return c;
  }
  return undefined;
}
