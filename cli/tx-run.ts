#!/usr/bin/env tsx
/**
 * Single-transaction execution-gap analyzer.
 *
 * Given a tx hash, runs the canonical multi-token gap evaluation:
 *   1. Fetch tx (Etherscan eth_getTransactionByHash)
 *   2. Resolve mempool block (Dune dumpster, fallback inclusion-1)
 *   3. Earliest-valid expected sim — walk forward from the mempool block
 *      one block at a time (head of each), stop at the first non-revert.
 *   4. Actual sim at the inclusion block at the tx's real on-chain index.
 *   5. Diff per-token net flows: actual − expected.
 *   6. Price priceable tokens (DeFiLlama).
 *   7. Print + write JSON detail.
 *
 * Usage:
 *   tsx cli/tx-run.ts --tx-hash 0x... [--user 0x...] [--no-cache] [--debug]
 */

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { analyzeTransactionGap, fmtRaw, fmtUsd, fmtPct } from "./_core";
import type { TxGapResult } from "./_core";

interface CliArgs {
  txHash: string;
  user?: string;
  noCache: boolean;
  output?: string;
  debug: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { noCache: false, debug: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--tx-hash":
      case "--tx":
        args.txHash = next();
        break;
      case "--user":
        args.user = next();
        break;
      case "--no-cache":
        args.noCache = true;
        break;
      case "--output":
      case "-o":
        args.output = next();
        break;
      case "--debug":
      case "-d":
        args.debug = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.txHash) {
    printHelp();
    throw new Error("Missing required --tx-hash");
  }
  return args as CliArgs;
}

function printHelp() {
  console.log(`
tx-run — analyze a single Ethereum transaction's execution gap

Usage:
  tsx cli/tx-run.ts --tx-hash 0x... [options]

Options:
  --tx-hash, --tx <hash>   Required. The transaction hash to analyze.
  --user <address>         Override the user address whose token flows
                           we track. Defaults to tx.from.
  --no-cache               Skip Tenderly sim cache; force fresh sims.
  -o, --output <path>      Write JSON detail to this path. Default:
                           reports/tx-runs/<txHash>.json
  -d, --debug              Emit step-by-step [debug] logs at every stage.
  -h, --help               Show this help.

Required env vars:
  ETHERSCAN_API_KEY, DUNE_API_KEY,
  TENDERLY_ACCOUNT, TENDERLY_PROJECT, TENDERLY_API_KEY

Example:
  tsx cli/tx-run.ts --tx 0xb71da98f1882063ad9e077ac269a89215c58d569ac32afb108852d9fc010533f --debug
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startMs = Date.now();

  console.log(`[cli] analyzing tx ${args.txHash}`);
  if (args.user) console.log(`[cli] tracking flows for user override: ${args.user}`);

  const result = await analyzeTransactionGap(args.txHash, {
    user: args.user,
    noCache: args.noCache,
    debug: args.debug,
  });

  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);
  printResult(result, durationSec);

  const outPath =
    args.output ??
    join("reports", "tx-runs", `${args.txHash.toLowerCase()}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2));
  console.log("");
  console.log(`[cli] full detail written → ${outPath}`);
}

function printResult(r: TxGapResult, durationSec: string) {
  console.log("");
  console.log("─".repeat(72));
  console.log(" Single-tx execution-gap report");
  console.log("─".repeat(72));
  console.log(` tx                : ${r.txHash}`);
  console.log(` user              : ${r.sender}`);
  console.log(
    ` inclusion block   : ${r.inclusionBlockNumber}    mempool block: ${r.mempoolBlockNumber}${r.isEstimatedMempoolBlock ? " (estimated)" : ""}`
  );
  if (r.expectedSimBlock != null) {
    const walkSummary =
      r.expectedSimBlock === r.mempoolBlockNumber
        ? "valid at mempool entry"
        : `valid only at block ${r.expectedSimBlock} (after ${r.expectedWalkAttempts} walk attempt${r.expectedWalkAttempts === 1 ? "" : "s"})`;
    console.log(` expected sim      : block ${r.expectedSimBlock}#0  —  ${walkSummary}`);
  } else {
    console.log(
      ` expected sim      : NOT FOUND  —  walked ${r.expectedWalkAttempts} block(s) from mempool to inclusion, all reverted`
    );
  }
  console.log(` simulation status : ${r.simulationStatus}`);
  console.log(` tokens touched    : ${r.perToken.length}  (${r.unpricedTokens} unpriced)`);
  console.log(` net gap (USD)     : ${fmtUsd(r.totalGapUsd)}  (${r.totalGapUsd < 0 ? "user lost" : r.totalGapUsd > 0 ? "user gained" : "neutral"})`);
  console.log(` duration          : ${durationSec}s`);
  console.log("─".repeat(72));
  if (r.error) {
    console.log(` ERROR: ${r.error}`);
    return;
  }
  if (r.perToken.length === 0) return;

  console.log("");
  console.log(" Per-token breakdown:");
  console.log(
    "  symbol     expected (raw)        ($)         actual (raw)          ($)         diff (raw)            (%)        ($)"
  );
  for (const t of r.perToken) {
    const sym = (t.symbol ?? "?").padEnd(10);
    const expRaw = fmtRaw(t.expectedNetRaw, t.decimals).padStart(15);
    const expUsd = (t.expectedUsd != null ? fmtUsd(t.expectedUsd) : "—").padStart(10);
    const actRaw = fmtRaw(t.actualNetRaw, t.decimals).padStart(15);
    const actUsd = (t.actualUsd != null ? fmtUsd(t.actualUsd) : "—").padStart(10);
    const difRaw = fmtRaw(t.diffNetRaw, t.decimals).padStart(15);
    const pct = fmtPct(t.diffPercent).padStart(10);
    const difUsd = (t.diffUsd != null ? fmtUsd(t.diffUsd) : "unpriced").padStart(10);
    console.log(
      `  ${sym} ${expRaw}  ${expUsd}    ${actRaw}  ${actUsd}    ${difRaw}  ${pct}  ${difUsd}`
    );
  }
}

main().catch((err) => {
  console.error("[cli] fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
