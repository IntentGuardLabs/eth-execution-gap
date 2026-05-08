/**
 * Shared CLI core — the canonical execution-gap evaluation primitive.
 *
 * Given a tx hash (+ a few optional details), this module:
 *   1. Resolves tx details (from/to/value/calldata/gasPrice/blockNumber)
 *   2. Resolves the mempool-arrival block (Dune dumpster, or `inclusion - 1`)
 *   3. Runs Tenderly twice — at the mempool block and at the inclusion block
 *   4. Computes net token flows per side (multi-token, no protocol decoding)
 *   5. Diffs the two flow sets per token (expected vs actual)
 *   6. Prices what DeFiLlama can; raw amounts kept for everything
 *   7. Returns a structured per-tx result plus a signed USD net gap
 *
 * No database — file caches in `.cache/` reduce upstream-API cost across
 * runs. Sign convention: negative = user lost, positive = user gained.
 *
 * This file is shared by `tx-run.ts`, `wallet-run.ts`, and (later)
 * `protocol-run.ts` if we unify it.
 */

import axios from "axios";
import {
  simulateTransaction,
  computeNetTokenFlows,
  SIMULATION_GAS_LIMIT,
} from "@/lib/data-sources/tenderly";
import {
  queryMempoolData,
  estimateMempoolBlockNumber,
} from "@/lib/data-sources/dune";
import { resolvePrices } from "@/lib/analysis/calculator";
import { rateLimiters } from "@/lib/rate-limiter";
import { retryWithBackoff } from "@/lib/utils";
import { getCachedSimulation, storeTenderlySimulation } from "@/lib/db";
import type { SimulationResult } from "@/lib/types";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TxFetchedDetails {
  txHash: string;
  from: string;       // sender (lowercase)
  to: string;         // recipient (lowercase). May be empty for contract creation.
  input: string;      // calldata (hex, 0x-prefixed)
  value: string;      // wei as decimal string
  gasPrice: string;   // wei as decimal string
  blockNumber: number;
  /**
   * The tx's actual position within `blockNumber` on-chain. Used as the
   * `transaction_index` for the inclusion-block sim so Tenderly reproduces
   * the same execution context the tx actually had.
   */
  transactionIndex: number;
}

export interface TokenGap {
  tokenAddress: string;     // lowercase. Zero address for native ETH.
  symbol: string;
  decimals: number;
  expectedNetRaw: string;   // BigInt as string. + = user expected to receive, − = expected to send
  actualNetRaw: string;     // BigInt as string. Same sign convention as expectedNetRaw
  diffNetRaw: string;       // BigInt as string. actual − expected. + = better than expected
  /**
   * `diffNet / expectedNet × 100`, sign-preserving. Negative = user got
   * less than expected on this token side; positive = better than expected.
   * Null when `expectedNet == 0` (division undefined — happens for the
   * intermediate-hop tokens whose expected and actual flows are both 0).
   */
  diffPercent: number | null;
  priceUsd: number | null;
  /** USD value of the expected net flow at `priceUsd`. null when unpriced. */
  expectedUsd: number | null;
  /** USD value of the actual net flow at `priceUsd`. null when unpriced. */
  actualUsd: number | null;
  diffUsd: number | null;   // null if unpriced
}

export interface TxGapResult {
  txHash: string;
  sender: string;
  inclusionBlockNumber: number;
  /**
   * Block where the tx was first seen in the mempool, ideally resolved
   * from `dune.flashbots.dataset_mempool_dumpster`. When the tx is not
   * in the dumpster, the CLI falls back to `inclusion - 1` and flags
   * the row with `isEstimatedMempoolBlock: true` plus a WARN log.
   */
  mempoolBlockNumber: number;
  isEstimatedMempoolBlock: boolean;
  /**
   * Block where the "expected" sim actually succeeded after the
   * earliest-valid walk (mempoolBlockNumber → inclusionBlockNumber, head
   * of each block). Equals `mempoolBlockNumber` for txs that were valid
   * at mempool entry; equals `inclusionBlockNumber` when the walk reached
   * the inclusion block without a successful intermediate. `null` when
   * the entire walk failed (we have no expected baseline).
   */
  expectedSimBlock: number | null;
  /** Number of intermediate blocks tried before a successful expected sim. */
  expectedWalkAttempts: number;
  simulationStatus:
    | "ok"
    | "mempool_failed"
    | "inclusion_failed"
    | "both_failed";
  perToken: TokenGap[];
  totalGapUsd: number;       // sum of priced diffs. Negative = user lost.
  unpricedTokens: number;    // count of tokens in perToken with priceUsd == null
  error?: string;
}

// ─── 1) Tx fetch ───────────────────────────────────────────────────────────

const ETHERSCAN_API_URL = "https://api.etherscan.io/v2/api";
const CHAIN_ID = 1;

/**
 * Fetch tx details by hash via Etherscan's `eth_getTransactionByHash` proxy.
 * Returns null if Etherscan can't find the tx.
 */
export async function fetchTransactionByHash(
  txHash: string
): Promise<TxFetchedDetails | null> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) throw new Error("ETHERSCAN_API_KEY not configured");

  const result = await retryWithBackoff(
    async () => {
      return await rateLimiters.etherscan.execute(async () => {
        const { data } = await axios.get(ETHERSCAN_API_URL, {
          params: {
            chainid: CHAIN_ID,
            module: "proxy",
            action: "eth_getTransactionByHash",
            txhash: txHash,
            apikey: apiKey,
          },
          timeout: 10000,
        });
        return data.result;
      });
    },
    3,
    1000
  );

  if (!result || !result.hash) return null;

  return {
    txHash: result.hash.toLowerCase(),
    from: (result.from ?? "").toLowerCase(),
    to: (result.to ?? "").toLowerCase(),
    input: result.input ?? "0x",
    value: BigInt(result.value ?? "0x0").toString(),
    gasPrice: BigInt(result.gasPrice ?? "0x0").toString(),
    blockNumber: parseInt(result.blockNumber, 16),
    transactionIndex: parseInt(result.transactionIndex ?? "0x0", 16),
  };
}

// ─── 2) Mempool block resolution ───────────────────────────────────────────

interface MempoolResolution {
  mempoolBlockNumber: number;
  isEstimated: boolean;
}

export async function resolveMempoolBlock(
  txHash: string,
  inclusionBlockNumber: number
): Promise<MempoolResolution> {
  // Best-effort lookup against the Flashbots dumpster. On a miss (tx not
  // in the dumpster, or the Dune query itself failed), fall back to
  // `inclusion - 1` and emit a WARN so the user knows the row's mempool
  // block is approximate, not authoritative.
  //
  // Pass `toBlock = inclusionBlockNumber` so Dune partition-prunes the
  // dumpster scan to a 10-block window (~120s of mempool history) rather
  // than scanning every partition. This is the difference between a
  // 5-second cold lookup and a 120-second one.
  try {
    const map = await queryMempoolData([txHash], {
      toBlock: inclusionBlockNumber,
    });
    const data = map.get(txHash.toLowerCase());
    if (data && typeof data.mempool_block_number === "number") {
      console.log(
        `[cli] mempool block found in Flashbots dumpster: tx=${txHash} block=${data.mempool_block_number} (delay=${data.inclusion_delay_ms}ms)`
      );
      return {
        mempoolBlockNumber: data.mempool_block_number,
        isEstimated: false,
      };
    }
    const fallback = estimateMempoolBlockNumber(inclusionBlockNumber);
    console.warn(
      `[cli] WARN: tx=${txHash} not in Flashbots mempool dumpster — simulating at block-1 from inclusion (block=${fallback})`
    );
    return { mempoolBlockNumber: fallback, isEstimated: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const fallback = estimateMempoolBlockNumber(inclusionBlockNumber);
    console.warn(
      `[cli] WARN: Dune mempool lookup failed for tx=${txHash} (${msg}) — simulating at block-1 from inclusion (block=${fallback})`
    );
    return { mempoolBlockNumber: fallback, isEstimated: true };
  }
}

// ─── 3) Cached Tenderly sim ────────────────────────────────────────────────

interface SimRunnerOptions {
  noCache?: boolean;
}

export function makeSimRunner(opts: SimRunnerOptions = {}) {
  const noCache = !!opts.noCache;
  return async (
    txData: TxFetchedDetails,
    blockNumber: number,
    transactionIndex: number,
    /** Either "mempool" or "inclusion" — used in failure logs only. */
    label: "mempool" | "inclusion" = "mempool"
  ): Promise<SimulationResult | null> => {
    if (!noCache) {
      const cached = await getCachedSimulation(
        txData.txHash,
        blockNumber,
        transactionIndex
      );
      if (cached) return cached;
    }
    const sim = await simulateTransaction(
      {
        from: txData.from,
        to: txData.to,
        input: txData.input,
        value: txData.value,
        gas: String(SIMULATION_GAS_LIMIT),
        gasPrice: txData.gasPrice,
      },
      blockNumber,
      transactionIndex
    );
    if (!sim) {
      console.warn(
        `[cli] WARN: ${label} simulation FAILED for tx=${txData.txHash} at block=${blockNumber} index=${transactionIndex}`
      );
    }
    if (sim && !noCache) {
      try {
        await storeTenderlySimulation(
          txData.txHash,
          blockNumber,
          transactionIndex,
          {
            from: txData.from,
            to: txData.to,
            input: txData.input,
            value: txData.value,
            gas: String(SIMULATION_GAS_LIMIT),
            gasPrice: txData.gasPrice,
            simulationResult: sim as unknown as Record<string, unknown>,
          }
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[cli] failed to cache sim ${txData.txHash}@${blockNumber}#${transactionIndex}: ${msg}`
        );
      }
    }
    return sim;
  };
}

// ─── 4-7) Per-token gap evaluation ─────────────────────────────────────────

interface AnalyzeOptions {
  noCache?: boolean;
  /** Override the user address whose flows we analyze. Defaults to tx.from. */
  user?: string;
  /** Skip pricing (faster — useful when batching many txs and pricing later). */
  skipPricing?: boolean;
  /** Emit step-by-step `[debug]` logs to stdout. */
  debug?: boolean;
}

function dbg(enabled: boolean | undefined, label: string, msg: string) {
  if (enabled) console.log(`[debug:${label}] ${msg}`);
}

/**
 * Analyze a single transaction's execution gap.
 *
 * Pass `tx` if you already have it (saves an Etherscan fetch). Otherwise
 * the tx is fetched by hash. The user address (whose token flows we track)
 * defaults to `tx.from` but can be overridden.
 */
export async function analyzeTransactionGap(
  txHash: string,
  opts: AnalyzeOptions & { tx?: TxFetchedDetails } = {}
): Promise<TxGapResult> {
  const debug = opts.debug;
  dbg(debug, "1.fetch", `txHash=${txHash}${opts.tx ? " (provided)" : " (etherscan lookup)"}`);

  const tx = opts.tx ?? (await fetchTransactionByHash(txHash));
  if (!tx) {
    dbg(debug, "1.fetch", `RESULT: tx not found via Etherscan`);
    return errorResult(txHash, opts.user ?? "", "tx not found via Etherscan");
  }
  dbg(
    debug,
    "1.fetch",
    `from=${tx.from} to=${tx.to} value=${tx.value} blockNumber=${tx.blockNumber} input=${tx.input.length > 12 ? `${tx.input.slice(0, 10)}…(${tx.input.length} chars)` : tx.input}`
  );

  const user = (opts.user ?? tx.from).toLowerCase();
  dbg(debug, "1.fetch", `user (whose flows we track) = ${user}`);

  dbg(debug, "2.mempool", `resolving mempool block for inclusion=${tx.blockNumber}`);
  const { mempoolBlockNumber, isEstimated } = await resolveMempoolBlock(
    txHash,
    tx.blockNumber
  );
  dbg(
    debug,
    "2.mempool",
    `mempoolBlock=${mempoolBlockNumber} ${isEstimated ? "(ESTIMATED — inclusion-1, no Dune dumpster row)" : "(from Dune dumpster)"}`
  );

  // Earliest-valid walk: start at the mempool block (from Dune dumpster)
  // and step forward one block at a time, simulating at the head of each.
  // The first block where Tenderly returns status=true is the earliest
  // moment the tx would have been valid — that's our "expected" baseline.
  // Reverts at intermediate blocks tell us the user's setup wasn't ready
  // yet (approval, balance, pool init, etc.); we don't need the reason,
  // just keep walking. Walk stops at `tx.blockNumber` inclusive.
  //
  // The actual sim runs on the inclusion block at the tx's real on-chain
  // position so we reproduce the exact execution context.
  const runSim = makeSimRunner({ noCache: opts.noCache });

  let simMempool: SimulationResult | null = null;
  let expectedSimBlock: number | null = null;
  let expectedWalkAttempts = 0;
  const walkUpper = tx.blockNumber;
  const walkLower = Math.min(mempoolBlockNumber, walkUpper);
  dbg(
    debug,
    "3.sim",
    `expected-sim walk: blocks ${walkLower}..${walkUpper} (head of each); actual sim at ${tx.blockNumber}#${tx.transactionIndex}; cache=${opts.noCache ? "off" : "on"}`
  );

  for (let b = walkLower; b <= walkUpper; b++) {
    expectedWalkAttempts++;
    const candidate = await runSim(tx, b, 0, "mempool");
    if (candidate && candidate.status === true) {
      simMempool = candidate;
      expectedSimBlock = b;
      dbg(
        debug,
        "3.sim",
        `expected-sim walk found a valid block: ${b} (after ${expectedWalkAttempts} attempt${expectedWalkAttempts === 1 ? "" : "s"})`
      );
      break;
    }
    dbg(
      debug,
      "3.sim",
      `expected-sim walk: block ${b} reverted${candidate?.errorMessage ? ` (${candidate.errorMessage})` : candidate ? "" : " (sim returned null)"}, advancing`
    );
  }
  if (expectedSimBlock == null) {
    console.warn(
      `[cli] WARN: expected-sim walk found no valid block from ${walkLower} to ${walkUpper} for tx=${txHash}; gap is not computable`
    );
  }

  // Actual sim — always at the tx's real on-chain position.
  const simInclusion = await runSim(
    tx,
    tx.blockNumber,
    tx.transactionIndex,
    "inclusion"
  );
  dbg(
    debug,
    "3.sim",
    `mempool sim: ${simMempool ? `${simMempool.transaction_info.asset_changes.length} asset_changes` : "FAILED (null)"}`
  );
  dbg(
    debug,
    "3.sim",
    `inclusion sim: ${simInclusion ? `${simInclusion.transaction_info.asset_changes.length} asset_changes` : "FAILED (null)"}`
  );

  // A "failed" sim from our perspective = either Tenderly couldn't simulate
  // at all (returned null) OR the simulated EVM call reverted. Treating
  // reverts as failures is required: a reverted mempool sim has no
  // meaningful "expected" baseline, and computing the diff against it
  // would surface the entire trade as a fake gap.
  const mempoolOk = !!simMempool && simMempool.status !== false;
  const inclusionOk = !!simInclusion && simInclusion.status !== false;

  let simulationStatus: TxGapResult["simulationStatus"];
  if (!mempoolOk && !inclusionOk) simulationStatus = "both_failed";
  else if (!mempoolOk) simulationStatus = "mempool_failed";
  else if (!inclusionOk) simulationStatus = "inclusion_failed";
  else simulationStatus = "ok";
  dbg(
    debug,
    "3.sim",
    `simulationStatus=${simulationStatus}` +
      (simMempool && !simMempool.status
        ? ` (mempool sim REVERTED: ${simMempool.errorMessage ?? "no reason"})`
        : "") +
      (simInclusion && !simInclusion.status
        ? ` (inclusion sim REVERTED: ${simInclusion.errorMessage ?? "no reason"})`
        : "")
  );

  // Only treat a sim's flows as a usable baseline when the sim ACTUALLY
  // ran to success. A reverted sim's empty asset_changes is not "the user
  // received nothing" — it's "the EVM check failed before any transfers
  // happened" and there is no meaningful comparison to make.
  const expectedFlows = mempoolOk
    ? computeNetTokenFlows(simMempool!.transaction_info.asset_changes, user)
    : [];
  const actualFlows = inclusionOk
    ? computeNetTokenFlows(simInclusion!.transaction_info.asset_changes, user)
    : [];
  dbg(
    debug,
    "4.flows",
    `expected (mempool): ${expectedFlows.length} non-zero token flows for user`
  );
  for (const f of expectedFlows) {
    dbg(
      debug,
      "4.flows",
      `  expected ${f.symbol} (${f.tokenAddress.slice(0, 10)}…) net=${f.net.toString()} (decimals=${f.decimals})`
    );
  }
  dbg(
    debug,
    "4.flows",
    `actual (inclusion): ${actualFlows.length} non-zero token flows for user`
  );
  for (const f of actualFlows) {
    dbg(
      debug,
      "4.flows",
      `  actual   ${f.symbol} (${f.tokenAddress.slice(0, 10)}…) net=${f.net.toString()} (decimals=${f.decimals})`
    );
  }

  // Union of token addresses across both sims; for each, compute diffs.
  const tokenSet = new Set<string>([
    ...expectedFlows.map((f) => f.tokenAddress),
    ...actualFlows.map((f) => f.tokenAddress),
  ]);
  dbg(debug, "5.diff", `union of touched tokens: ${tokenSet.size}`);

  const perToken: TokenGap[] = [];
  for (const addr of tokenSet) {
    const e = expectedFlows.find((f) => f.tokenAddress === addr);
    const a = actualFlows.find((f) => f.tokenAddress === addr);
    const expectedNet = e?.net ?? BigInt(0);
    const actualNet = a?.net ?? BigInt(0);
    const diffNet = actualNet - expectedNet;
    const meta = e ?? a!;
    perToken.push({
      tokenAddress: addr,
      symbol: meta.symbol,
      decimals: meta.decimals,
      expectedNetRaw: expectedNet.toString(),
      actualNetRaw: actualNet.toString(),
      diffNetRaw: diffNet.toString(),
      diffPercent: bigintRatioPercent(diffNet, expectedNet),
      priceUsd: null,
      expectedUsd: null,
      actualUsd: null,
      diffUsd: null,
    });
    dbg(
      debug,
      "5.diff",
      `  ${meta.symbol} (${addr.slice(0, 10)}…) expected=${expectedNet.toString()} actual=${actualNet.toString()} diff=${diffNet.toString()}`
    );
  }

  // Pricing
  if (!opts.skipPricing && perToken.length > 0) {
    dbg(
      debug,
      "6.price",
      `requesting prices for ${perToken.length} unique tokens via DeFiLlama`
    );
    const priceMap = await resolvePrices(perToken.map((t) => t.tokenAddress));
    let priced = 0;
    for (const t of perToken) {
      const price = priceMap.get(t.tokenAddress.toLowerCase()) ?? null;
      t.priceUsd = price;
      if (price != null) {
        t.expectedUsd = rawToUsd(t.expectedNetRaw, price, t.decimals);
        t.actualUsd = rawToUsd(t.actualNetRaw, price, t.decimals);
        t.diffUsd = rawToUsd(t.diffNetRaw, price, t.decimals);
        priced++;
        dbg(
          debug,
          "6.price",
          `  ${t.symbol} priced at $${price.toFixed(6)} → expected $${t.expectedUsd.toFixed(2)}, actual $${t.actualUsd.toFixed(2)}, diff ${t.diffUsd.toFixed(2)}`
        );
      } else {
        dbg(debug, "6.price", `  ${t.symbol} (${t.tokenAddress.slice(0, 10)}…) UNPRICED`);
      }
    }
    dbg(
      debug,
      "6.price",
      `priced ${priced}/${perToken.length}, ${perToken.length - priced} unpriced`
    );
  } else if (opts.skipPricing) {
    dbg(debug, "6.price", `skipped (skipPricing=true)`);
  }

  const unpricedTokens = perToken.filter((t) => t.priceUsd == null).length;

  // Gap is only meaningful when BOTH sims succeeded. If either reverted,
  // we have no reliable baseline, and the per-token diff is the trade
  // notional, not the execution gap. Zero the USD aggregate and let the
  // caller surface the simulationStatus to the user.
  let totalGapUsd: number;
  if (simulationStatus !== "ok") {
    totalGapUsd = 0;
    dbg(
      debug,
      "7.aggregate",
      `totalGapUsd=0 — gap not computable (simulationStatus=${simulationStatus}). Per-token diffs preserved for audit but the USD total is not meaningful.`
    );
  } else {
    totalGapUsd = perToken.reduce((sum, t) => sum + (t.diffUsd ?? 0), 0);
    dbg(
      debug,
      "7.aggregate",
      `totalGapUsd=${totalGapUsd.toFixed(6)} (${totalGapUsd < 0 ? "user lost" : totalGapUsd > 0 ? "user gained" : "neutral"}); unpricedTokens=${unpricedTokens}`
    );
  }

  return {
    txHash,
    sender: user,
    inclusionBlockNumber: tx.blockNumber,
    mempoolBlockNumber,
    isEstimatedMempoolBlock: isEstimated,
    expectedSimBlock,
    expectedWalkAttempts,
    simulationStatus,
    perToken,
    totalGapUsd,
    unpricedTokens,
  };
}

function errorResult(
  txHash: string,
  sender: string,
  error: string
): TxGapResult {
  return {
    txHash,
    sender,
    inclusionBlockNumber: 0,
    mempoolBlockNumber: 0,
    isEstimatedMempoolBlock: false,
    expectedSimBlock: null,
    expectedWalkAttempts: 0,
    simulationStatus: "both_failed",
    perToken: [],
    totalGapUsd: 0,
    unpricedTokens: 0,
    error,
  };
}

/**
 * Sign-preserving percentage `numer / denom × 100` on signed BigInts.
 * Uses 4-decimal-precision integer arithmetic so we don't lose precision
 * on small ratios. Returns null when `denom == 0` (undefined ratio).
 */
function bigintRatioPercent(numer: bigint, denom: bigint): number | null {
  if (denom === BigInt(0)) return null;
  const negative = (numer < BigInt(0)) !== (denom < BigInt(0));
  const numAbs = numer < BigInt(0) ? -numer : numer;
  const denAbs = denom < BigInt(0) ? -denom : denom;
  // 4 decimals of precision: scale by 1_000_000, divide, then divide by 10_000
  // to get a percent with 2 decimals of fractional precision in `Number`.
  const scaled = (numAbs * BigInt(1_000_000)) / denAbs;
  const pct = Number(scaled) / 10_000;
  return negative ? -pct : pct;
}

/**
 * HR-6 safe BigInt → USD conversion. Sign-preserving.
 */
function rawToUsd(rawStr: string, price: number, decimals: number): number {
  if (price === 0) return 0;
  try {
    const raw = BigInt(rawStr);
    if (raw === BigInt(0)) return 0;
    const negative = raw < BigInt(0);
    const abs = negative ? -raw : raw;
    const divisor = BigInt(10 ** Math.min(decimals, 18));
    const whole = abs / divisor;
    const frac = abs % divisor;
    const tokens = Number(whole) + Number(frac) / Number(divisor);
    const usd = tokens * price;
    return negative ? -usd : usd;
  } catch {
    return 0;
  }
}

// ─── stdout formatting helpers (shared by tx-run / wallet-run) ─────────────

export function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "0.00%";
  const sign = n < 0 ? "−" : "+";
  return `${sign}${Math.abs(n).toFixed(2)}%`;
}

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "−" : n > 0 ? "+" : " ";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export function fmtRaw(rawStr: string, decimals: number): string {
  try {
    const raw = BigInt(rawStr);
    if (raw === BigInt(0)) return "0";
    const negative = raw < BigInt(0);
    const abs = negative ? -raw : raw;
    const divisor = BigInt(10 ** Math.min(decimals, 18));
    const whole = abs / divisor;
    const frac = abs % divisor;
    const fracNum = Number(frac) / Number(divisor);
    const tokens = Number(whole) + fracNum;
    const sign = negative ? "−" : "";
    if (tokens >= 1) return `${sign}${tokens.toFixed(4)}`;
    if (tokens >= 0.0001) return `${sign}${tokens.toFixed(6)}`;
    return `${sign}${tokens.toExponential(2)}`;
  } catch {
    return rawStr;
  }
}
