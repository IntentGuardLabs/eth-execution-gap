#!/usr/bin/env tsx
/**
 * Protocol execution-gap analyzer — command-line entrypoint.
 *
 * Orchestrates the canonical primitives (Dune query, UniV2 decode,
 * Tenderly ×2 sim, DeFiLlama pricing, gap math) and prints results.
 * No database — caches are JSON files under `.cache/`. Re-runs of
 * the same window are cheap because Tenderly sims and Dune rows
 * persist across CLI invocations. Pass `--no-cache` to bypass the
 * Tenderly sim cache for a full fresh run.
 *
 * Output:
 *   - pretty-printed summary on stdout
 *   - full per-swap detail at reports/protocol-runs/<timestamp>.json
 */

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { queryProtocolTxsWithMempool } from "@/lib/data-sources/dune";
import { simulateTransaction, SIMULATION_GAS_LIMIT } from "@/lib/data-sources/tenderly";
import { decodeUniV2Swap } from "@/lib/analysis/univ2-decoder";
import { evaluateSwap } from "@/lib/analysis/protocol-pipeline";
import { priceProtocolSwaps } from "@/lib/analysis/calculator";
import { getCachedSimulation, storeTenderlySimulation } from "@/lib/db";
import { UNISWAP_V2_ROUTER_ADDRESS } from "@/lib/constants";
import type {
  DecodedUniV2Swap,
  ProtocolSwapResult,
  ProtocolTxRow,
  SimulationResult,
} from "@/lib/types";

// ─── CLI args ──────────────────────────────────────────────────────────────

interface CliArgs {
  protocol: "uniswap-v2";
  windowMinutes?: number;
  windowDays: number;
  limit: number;
  output?: string;
  noCache: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    protocol: "uniswap-v2",
    windowDays: 1,
    limit: 200,
    noCache: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--protocol":
        args.protocol = next() as "uniswap-v2";
        if (args.protocol !== "uniswap-v2") {
          throw new Error(`Unsupported protocol: ${args.protocol} (only uniswap-v2 today)`);
        }
        break;
      case "--window-minutes":
        args.windowMinutes = Number(next());
        break;
      case "--window-days":
        args.windowDays = Number(next());
        break;
      case "--limit":
        args.limit = Number(next());
        break;
      case "--output":
      case "-o":
        args.output = next();
        break;
      case "--no-cache":
        args.noCache = true;
        break;
      case "--verbose":
      case "-v":
        args.verbose = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
protocol-run — analyze a protocol's recent execution gap

Usage:
  tsx cli/protocol-run.ts [options]

Options:
  --protocol <id>        Protocol id. Only "uniswap-v2" today. Default: uniswap-v2
  --window-minutes <n>   Recent-window length in minutes. Takes precedence
                         over --window-days when present.
  --window-days <n>      Recent-window length in days. Default: 1
  --limit <n>            Max router txs pulled from Dune. Default: 200
  -o, --output <path>    Write JSON detail to this path. Default:
                         reports/protocol-runs/<timestamp>.json
  --no-cache             Skip Tenderly sim cache reads/writes (full fresh run).
                         Dune + DeFiLlama caches are still consulted.
  -v, --verbose          Print every per-swap line as it's evaluated.
  -h, --help             Show this help.

Required env vars:
  DUNE_API_KEY, TENDERLY_ACCOUNT, TENDERLY_PROJECT, TENDERLY_API_KEY
  (file caches live under .cache/ — no database is required)

Example:
  tsx cli/protocol-run.ts --protocol uniswap-v2 --window-minutes 10 --limit 50
`);
}

// ─── Sim runner: cache-check then Tenderly ─────────────────────────────────

function makeSimRunner(noCache: boolean) {
  return async (
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
  ): Promise<SimulationResult | null> => {
    // Protocol mode doesn't track per-tx `transactionIndex` (Dune query
    // returns one row per router tx without it), so both the mempool and
    // inclusion sims run at the HEAD of their respective blocks. This is
    // less precise than the tx/wallet modes (which use the real on-chain
    // index for the inclusion sim), but consistent across the batch.
    const transactionIndex = 0;
    if (!noCache) {
      const cached = await getCachedSimulation(txHash, blockNumber, transactionIndex);
      if (cached) return cached;
    }
    const sim = await simulateTransaction(txData, blockNumber, transactionIndex);
    if (sim && !noCache) {
      try {
        await storeTenderlySimulation(txHash, blockNumber, transactionIndex, {
          ...txData,
          simulationResult: sim as unknown as Record<string, unknown>,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[cli] Failed to cache sim for ${txHash}@${blockNumber}: ${msg}`);
      }
    }
    return sim;
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const router = UNISWAP_V2_ROUTER_ADDRESS;
  const startedAt = new Date();
  const startMs = Date.now();

  console.log(`[cli] protocol=${args.protocol} router=${router.slice(0, 10)}...`);
  console.log(
    `[cli] window=${args.windowMinutes ? `${args.windowMinutes}m` : `${args.windowDays}d`} limit=${args.limit} cache=${args.noCache ? "off" : "on"}`
  );

  // 1) Dune fetch
  console.log(`[cli] Step 1/4: querying Dune for router txs`);
  const rows: ProtocolTxRow[] = await queryProtocolTxsWithMempool({
    routerAddress: router,
    windowDays: args.windowDays,
    windowMinutes: args.windowMinutes,
    limit: args.limit,
  });
  console.log(`[cli] Dune returned ${rows.length} rows`);

  // 2) Decode
  console.log(`[cli] Step 2/4: decoding calldata`);
  const decoded: Array<{ decoded: DecodedUniV2Swap; row: ProtocolTxRow }> = [];
  for (const row of rows) {
    const d = decodeUniV2Swap(row);
    if (d) decoded.push({ decoded: d, row });
  }
  console.log(`[cli] decoded ${decoded.length}/${rows.length} as UniV2 swaps`);

  // 3) Simulate + evaluate
  console.log(`[cli] Step 3/4: simulating ${decoded.length} swaps (×2 sims each)`);
  const simRunner = makeSimRunner(args.noCache);
  const evaluated: ProtocolSwapResult[] = [];
  let i = 0;
  for (const { decoded: d, row } of decoded) {
    i++;
    try {
      const result = await evaluateSwap(d, row, simRunner);
      evaluated.push(result);
      if (args.verbose) {
        console.log(
          `[cli]   ${i}/${decoded.length} ${row.txHash.slice(0, 10)}…  ${result.tokenInSymbol ?? "?"} → ${result.tokenOutSymbol ?? "?"}  status=${result.simulationStatus}`
        );
      } else if (i % 10 === 0) {
        console.log(`[cli]   progress ${i}/${decoded.length}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[cli]   evaluate failed for ${row.txHash}: ${msg}`);
    }
  }

  // 4) Price (no runId → no ProtocolRunTokenPrice audit write)
  console.log(`[cli] Step 4/4: pricing via DeFiLlama`);
  const priced = await priceProtocolSwaps(evaluated);

  const completedAt = new Date();
  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const computable = priced.filter((s) => s.totalGapUsd !== 0);
  const losers = computable.filter((s) => s.totalGapUsd < 0);
  const winners = computable.filter((s) => s.totalGapUsd > 0);
  const totalGapUsd = priced.reduce((sum, s) => sum + s.totalGapUsd, 0);
  const sortedByLoss = [...priced].sort((a, b) => a.totalGapUsd - b.totalGapUsd);
  const top = sortedByLoss[0];

  // ── Stdout summary ────────────────────────────────────────────────────────
  console.log("");
  console.log("─".repeat(72));
  console.log(` Protocol execution-gap report`);
  console.log("─".repeat(72));
  console.log(` protocol         : ${args.protocol}`);
  console.log(` router           : ${router}`);
  console.log(
    ` window           : ${args.windowMinutes ? `${args.windowMinutes} minutes` : `${args.windowDays} days`}`
  );
  console.log(` duration         : ${durationSec}s`);
  console.log(` txs discovered   : ${rows.length}`);
  console.log(` txs decoded      : ${decoded.length}`);
  console.log(` txs evaluated    : ${evaluated.length}`);
  console.log(` swaps with gap   : ${computable.length} (${losers.length} loss, ${winners.length} gain)`);
  console.log(` net total (USD)  : ${fmt(totalGapUsd)}  (${totalGapUsd < 0 ? "user net loss" : "user net gain"})`);
  if (top && top.totalGapUsd < 0) {
    console.log(` worst single tx  : ${top.txHash}`);
    console.log(`                    ${fmt(top.totalGapUsd)} (${top.tokenInSymbol ?? "?"} → ${top.tokenOutSymbol ?? "?"})`);
  }
  console.log("─".repeat(72));

  // Top-5 losses table
  const top5 = sortedByLoss.filter((s) => s.totalGapUsd < 0).slice(0, 5);
  if (top5.length > 0) {
    console.log("");
    console.log(" Top 5 losses:");
    console.log(
      "  #  tx              pair                 gap (USD)"
    );
    top5.forEach((s, idx) => {
      console.log(
        `  ${idx + 1}  ${s.txHash.slice(0, 12)}…  ${(s.tokenInSymbol ?? "?").padEnd(6)} → ${(s.tokenOutSymbol ?? "?").padEnd(6).slice(0, 6)}  ${fmt(s.totalGapUsd).padStart(12)}`
      );
    });
  }

  // ── Write JSON detail ────────────────────────────────────────────────────
  const outPath =
    args.output ??
    join(
      "reports",
      "protocol-runs",
      `${startedAt.toISOString().replace(/[:.]/g, "-")}_${args.protocol}.json`
    );
  await mkdir(dirname(outPath), { recursive: true });
  const report = {
    schema: "protocol-run-cli@1.0",
    protocol: args.protocol,
    routerAddress: router,
    windowDays: args.windowDays,
    windowMinutes: args.windowMinutes,
    limit: args.limit,
    cache: args.noCache ? "off" : "on",
    txsDiscovered: rows.length,
    txsDecoded: decoded.length,
    txsEvaluated: evaluated.length,
    swapsWithGap: computable.length,
    losers: losers.length,
    winners: winners.length,
    totalGapUsd,
    topLossTxHash: top?.txHash,
    topLossUsd: top?.totalGapUsd,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationSec: Number(durationSec),
    swaps: priced,
  };
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log("");
  console.log(`[cli] full detail written → ${outPath}`);
  // Silence unused-import warning while keeping the import handy for users
  // who copy this file to build their own variants (e.g. raising the gas).
  void SIMULATION_GAS_LIMIT;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "−" : n > 0 ? "+" : " ";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

main().catch((err) => {
  console.error("[cli] fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
