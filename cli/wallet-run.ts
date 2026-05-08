#!/usr/bin/env tsx
/**
 * Wallet execution-gap analyzer.
 *
 * Given a wallet address, fetches recent transactions from Etherscan,
 * filters out the no-gap ones (transfers, approvals, etc.), and runs
 * the canonical multi-token gap evaluation for each remaining tx.
 * Aggregates per-tx and prints a wallet-level summary.
 *
 * Usage:
 *   tsx cli/wallet-run.ts --address 0x... [--limit 50] [--no-cache] [--debug]
 */

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fetchWalletTransactions } from "@/lib/data-sources/etherscan";
import { filterTransactionsForSimulation } from "@/lib/analysis/filter";
import { isValidEthereumAddress, normalizeAddress } from "@/lib/utils";
import { analyzeTransactionGap, fmtUsd } from "./_core";
import type { TxFetchedDetails, TxGapResult } from "./_core";

interface CliArgs {
  address: string;
  limit: number;
  noCache: boolean;
  output?: string;
  debug: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { limit: 50, noCache: false, debug: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--address":
      case "-a":
        args.address = next();
        break;
      case "--limit":
        args.limit = Number(next());
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
  if (!args.address) {
    printHelp();
    throw new Error("Missing required --address");
  }
  if (!isValidEthereumAddress(args.address)) {
    throw new Error(`Invalid Ethereum address: ${args.address}`);
  }
  return args as CliArgs;
}

function printHelp() {
  console.log(`
wallet-run — analyze a wallet's recent execution gap

Usage:
  tsx cli/wallet-run.ts --address 0x... [options]

Options:
  --address, -a <addr>     Required. The wallet address to analyze.
  --limit <n>              Max number of simulatable txs to evaluate.
                           Default: 50. Etherscan returns recent txs first.
  --no-cache               Skip Tenderly sim cache; force fresh sims.
  -o, --output <path>      Write JSON detail to this path. Default:
                           reports/wallet-runs/<address>.json
  -d, --debug              Emit step-by-step [debug] logs at every stage.
  -h, --help               Show this help.

Required env vars:
  ETHERSCAN_API_KEY, DUNE_API_KEY,
  TENDERLY_ACCOUNT, TENDERLY_PROJECT, TENDERLY_API_KEY

Example:
  tsx cli/wallet-run.ts -a 0xb86d0701... --limit 20 --debug
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startMs = Date.now();
  const address = normalizeAddress(args.address);

  console.log(`[cli] wallet=${address} limit=${args.limit} cache=${args.noCache ? "off" : "on"}`);

  // 1) Fetch the wallet's recent txs
  console.log(`[cli] Step 1/3: fetching wallet txs from Etherscan`);
  const { transactions, latestBlock } = await fetchWalletTransactions(address);
  console.log(
    `[cli]   ${transactions.length} txs returned (latest block ${latestBlock})`
  );

  // 2) Filter out the no-gap txs (transfers, approvals, contract creations,
  //    failed txs). We skip the contract-vs-EOA check the web pipeline does
  //    so the CLI runs without an extra Etherscan round-trip per tx.
  console.log(`[cli] Step 2/3: filtering txs that need simulation`);
  const filtered = filterTransactionsForSimulation(transactions);
  const targets = filtered.slice(0, args.limit);
  console.log(
    `[cli]   ${filtered.length} simulatable; analyzing top ${targets.length}`
  );
  if (targets.length === 0) {
    console.log("[cli] nothing to analyze; exiting");
    return;
  }

  // 3) Run the canonical core for each tx
  console.log(`[cli] Step 3/3: running per-tx gap evaluation`);
  const results: TxGapResult[] = [];
  let i = 0;
  for (const tx of targets) {
    i++;
    const txDetails: TxFetchedDetails = {
      txHash: tx.hash.toLowerCase(),
      from: tx.from.toLowerCase(),
      to: (tx.to ?? "").toLowerCase(),
      input: tx.input,
      value: tx.value,
      gasPrice: tx.gasPrice,
      blockNumber: tx.blockNumber,
      transactionIndex: tx.transactionIndex,
    };
    if (args.debug) {
      console.log(
        `[debug:wallet] (${i}/${targets.length}) ${tx.hash.slice(0, 10)}…  to=${(tx.to ?? "").slice(0, 10)}…`
      );
    }
    try {
      const r = await analyzeTransactionGap(tx.hash, {
        tx: txDetails,
        user: address,
        noCache: args.noCache,
        debug: args.debug,
      });
      results.push(r);
      if (!args.debug) {
        console.log(
          `[cli]   ${i}/${targets.length} ${tx.hash.slice(0, 10)}…  ${fmtUsd(r.totalGapUsd).padStart(10)}  status=${r.simulationStatus}`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[cli]   ${tx.hash}: ${msg}`);
    }
  }

  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);
  const fullyOk = results.filter((r) => r.simulationStatus === "ok");
  const totalGapUsd = fullyOk.reduce((s, r) => s + r.totalGapUsd, 0);
  const losers = fullyOk.filter((r) => r.totalGapUsd < 0);
  const winners = fullyOk.filter((r) => r.totalGapUsd > 0);

  // ── stdout summary ──
  console.log("");
  console.log("─".repeat(72));
  console.log(" Wallet execution-gap report");
  console.log("─".repeat(72));
  console.log(` wallet         : ${address}`);
  console.log(` duration       : ${durationSec}s`);
  console.log(` txs scanned    : ${transactions.length}`);
  console.log(` simulatable    : ${filtered.length}  (analyzed ${targets.length})`);
  console.log(` ok status      : ${fullyOk.length}`);
  console.log(
    ` swaps with gap : ${fullyOk.filter((r) => r.totalGapUsd !== 0).length}  (${losers.length} loss, ${winners.length} gain)`
  );
  console.log(
    ` net total      : ${fmtUsd(totalGapUsd)}  (${totalGapUsd < 0 ? "user net loss" : "user net gain"})`
  );
  console.log("─".repeat(72));

  const sortedByLoss = [...fullyOk].sort((a, b) => a.totalGapUsd - b.totalGapUsd);
  const top5Losses = sortedByLoss.filter((r) => r.totalGapUsd < 0).slice(0, 5);
  if (top5Losses.length > 0) {
    console.log("");
    console.log(" Top 5 losses:");
    console.log("  #  tx              tokens  USD diff");
    top5Losses.forEach((r, idx) => {
      console.log(
        `  ${idx + 1}  ${r.txHash.slice(0, 12)}…  ${String(r.perToken.length).padStart(6)}  ${fmtUsd(r.totalGapUsd).padStart(10)}`
      );
    });
  }

  // ── JSON detail ──
  const outPath =
    args.output ?? join("reports", "wallet-runs", `${address}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  const payload = {
    schema: "wallet-run-cli@1.0",
    address,
    txsScanned: transactions.length,
    simulatable: filtered.length,
    analyzed: targets.length,
    okCount: fullyOk.length,
    losers: losers.length,
    winners: winners.length,
    totalGapUsd,
    durationSec: Number(durationSec),
    results,
  };
  await writeFile(outPath, JSON.stringify(payload, null, 2));
  console.log("");
  console.log(`[cli] full detail written → ${outPath}`);
}

main().catch((err) => {
  console.error("[cli] fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
