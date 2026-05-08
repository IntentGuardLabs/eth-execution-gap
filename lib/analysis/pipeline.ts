import { fetchWalletTransactions } from "@/lib/data-sources/etherscan";
import { queryMempoolData, estimateMempoolBlockNumber } from "@/lib/data-sources/dune";
import { simulateTransaction, extractAssetChanges, getTokenOutputFromChanges } from "@/lib/data-sources/tenderly";
import { filterTransactionsForSimulation } from "@/lib/analysis/filter";
import { detectSandwiches } from "@/lib/analysis/sandwich";
import { calculateGaps } from "@/lib/analysis/calculator";
import { updateAnalysisJobStatus, createOrUpdateWalletAnalysis, storeTransactionAnalysis, getWalletRank, storeEtherscanTransactions, storeDuneMempoolData, storeTenderlySimulation } from "@/lib/db";
import { normalizeAddress } from "@/lib/utils";
import { ANALYSIS_WINDOW_DAYS, BLOCK_TIME_SECONDS } from "@/lib/constants";
import type { MempoolData, TransactionAnalysisResult, WalletAnalysisResult } from "@/lib/types";

/**
 * Execute the full MEV analysis pipeline for a wallet
 */
export async function analyzeWallet(
  jobId: string,
  address: string
): Promise<WalletAnalysisResult> {
  const normalizedAddress = normalizeAddress(address);

  try {
    // Step 1: Fetch transaction history
    console.log(`[pipeline:${jobId}] Step 1/6: Fetching transactions for ${normalizedAddress}`);
    await updateAnalysisJobStatus(jobId, "fetching_txs", 10);
    const allTxs = await fetchWalletTransactions(normalizedAddress);
    console.log(`[pipeline:${jobId}] Fetched ${allTxs.length} transactions`);

    // Step 2: Filter transactions that need simulation
    console.log(`[pipeline:${jobId}] Step 2/6: Filtering transactions (excluding no-gap txs: transfers, approvals, lending, staking, bridges, etc.)`);
    await updateAnalysisJobStatus(jobId, "filtering", 20);
    const swapTxs = filterTransactionsForSimulation(allTxs);
    console.log(`[pipeline:${jobId}] ${swapTxs.length} of ${allTxs.length} transactions need simulation`);

    if (swapTxs.length === 0) {
      console.log(`[pipeline:${jobId}] No transactions require simulation — all ${allTxs.length} txs were filtered out (transfers, approvals, lending, etc.)`);
      const emptyResult: WalletAnalysisResult = {
        address: normalizedAddress,
        windowDays: ANALYSIS_WINDOW_DAYS,
        totalLossUsd: 0,
        sandwichLossUsd: 0,
        delayLossUsd: 0,
        slippageLossUsd: 0,
        annualizedLossUsd: 0,
        txsAnalyzed: 0,
        txsSandwiched: 0,
        transactions: [],
        analyzedAt: new Date().toISOString(),
      };

      const walletAnalysis = await createOrUpdateWalletAnalysis(normalizedAddress, {
        totalLossUsd: 0,
        sandwichLossUsd: 0,
        delayLossUsd: 0,
        slippageLossUsd: 0,
        txsAnalyzed: 0,
        txsSandwiched: 0,
      });

      // Store raw Etherscan transactions even for empty analysis
      if (allTxs.length > 0) {
        console.log(`[pipeline:${jobId}] Storing ${allTxs.length} raw Etherscan transactions`);
        await storeEtherscanTransactions(walletAnalysis.id, allTxs);
      }

      // Mark job as complete
      await updateAnalysisJobStatus(jobId, "complete", 100);
      console.log(`[pipeline:${jobId}] Step 6/6: Completed (no DEX swaps to analyze)`);

      return emptyResult;
    }

    // Step 3: Query mempool data
    console.log(`[pipeline:${jobId}] Step 3/6: Querying mempool data for ${swapTxs.length} txs`);
    await updateAnalysisJobStatus(jobId, "querying_mempool", 30, {
      totalTxs: swapTxs.length,
    });

    const txHashes = swapTxs.map((tx) => tx.hash);
    let mempoolDataMap: Map<string, MempoolData>;
    try {
      mempoolDataMap = await queryMempoolData(txHashes);
      console.log(`[pipeline:${jobId}] Got mempool data for ${mempoolDataMap.size} txs`);
    } catch (duneError) {
      const errMsg = duneError instanceof Error ? duneError.message : String(duneError);
      console.warn(`[pipeline:${jobId}] Dune query failed: ${errMsg} — falling back to block N-1 for all txs`);
      mempoolDataMap = new Map();
    }

    // Step 4: Simulate transactions and get actual outputs
    console.log(`[pipeline:${jobId}] Step 4/6: Simulating ${swapTxs.length} transactions`);
    await updateAnalysisJobStatus(jobId, "simulating", 50, {
      totalTxs: swapTxs.length,
    });

    const analysisResults: TransactionAnalysisResult[] = [];

    for (let i = 0; i < swapTxs.length; i++) {
      const tx = swapTxs[i];
      const mempoolData = mempoolDataMap.get(tx.hash.toLowerCase());

      // Determine the block at which the user's wallet submitted the tx (mempool entry).
      // Dune's mempool dumpster gives us the real timestamp; we find the block active at that time.
      // If Dune has no data for this tx, we fall back to inclusion_block - 1 (conservative estimate).
      const mempoolBlockNumber = mempoolData?.mempool_block_number ||
        estimateMempoolBlockNumber(tx.blockNumber);
      const isEstimated = !mempoolData;

      const blockDelta = tx.blockNumber - mempoolBlockNumber;
      const estimatedDelaySeconds = blockDelta * BLOCK_TIME_SECONDS;

      console.log(
        `[pipeline:${jobId}] [${i + 1}/${swapTxs.length}] Simulating tx ${tx.hash}` +
        `\n  ├─ included in block ${tx.blockNumber} (index ${tx.transactionIndex})` +
        `\n  ├─ mempool block: ${mempoolBlockNumber} (${isEstimated ? "ESTIMATED: no Dune data, using inclusion_block - 1" : `from Dune mempool dumpster, delay ${mempoolData!.inclusion_delay_ms}ms`})` +
        `\n  ├─ block delta: ${blockDelta} blocks (~${estimatedDelaySeconds}s)` +
        `\n  ├─ to: ${tx.to} (contract)` +
        `\n  └─ method: ${tx.input.slice(0, 10)}`
      );

      // Simulate at mempool block — this is what the user's wallet "expected" to get
      const expectedSimulation = await simulateTransaction(
        {
          from: tx.from,
          to: tx.to,
          input: tx.input,
          value: tx.value,
          gas: tx.gas,
          gasPrice: tx.gasPrice,
        },
        mempoolBlockNumber
      );

      // Store raw Tenderly simulation result for mempool block
      if (expectedSimulation) {
        await storeTenderlySimulation(tx.hash, mempoolBlockNumber, {
          from: tx.from,
          to: tx.to,
          input: tx.input,
          value: tx.value,
          gas: tx.gas,
          gasPrice: tx.gasPrice,
          simulationResult: expectedSimulation,
        });
      }

      // Simulate at actual inclusion block
      const actualSimulation = await simulateTransaction(
        {
          from: tx.from,
          to: tx.to,
          input: tx.input,
          value: tx.value,
          gas: tx.gas,
          gasPrice: tx.gasPrice,
        },
        tx.blockNumber
      );

      // Store raw Tenderly simulation result for actual block
      if (actualSimulation) {
        await storeTenderlySimulation(tx.hash, tx.blockNumber, {
          from: tx.from,
          to: tx.to,
          input: tx.input,
          value: tx.value,
          gas: tx.gas,
          gasPrice: tx.gasPrice,
          simulationResult: actualSimulation,
        });
      }

      const expectedChanges = extractAssetChanges(expectedSimulation);
      const actualChanges = extractAssetChanges(actualSimulation);

      const expectedOutput = getTokenOutputFromChanges(expectedChanges, tx.from);
      const actualOutput = getTokenOutputFromChanges(actualChanges, tx.from);

      // At least one side must have a token output to compute a gap.
      // If expected exists but actual is missing (or vice versa), treat missing side as 0.
      // Only skip if BOTH are null (neither simulation produced token output).
      if (!expectedOutput && !actualOutput) {
        console.log(
          `[pipeline:${jobId}]   ✗ tx ${tx.hash.slice(0, 14)}... — ` +
          `no token output in either simulation — skipping`
        );
      } else {
        const expectedAmt = expectedOutput ? BigInt(expectedOutput.amount) : BigInt(0);
        const actualAmt = actualOutput ? BigInt(actualOutput.amount) : BigInt(0);
        const gapRaw = expectedAmt - actualAmt;

        // Use whichever side has token info (prefer expected)
        const tokenInfo = expectedOutput || actualOutput!;

        console.log(
          `[pipeline:${jobId}]   ✓ tx ${tx.hash.slice(0, 14)}... — ` +
          `expected ${expectedAmt.toString()} ${tokenInfo.symbol || "?"} (block ${mempoolBlockNumber}) → ` +
          `actual ${actualAmt.toString()} ${tokenInfo.symbol || "?"} (block ${tx.blockNumber}) — ` +
          `gap: ${gapRaw.toString()} raw` +
          (!expectedOutput ? " [no expected output — treated as 0]" : "") +
          (!actualOutput ? " [no actual output — treated as 0]" : "")
        );

        const result: TransactionAnalysisResult = {
          txHash: tx.hash,
          blockNumber: tx.blockNumber,
          mempoolBlockNumber,
          inclusionDelayMs: mempoolData?.inclusion_delay_ms,
          expectedOutputRaw: expectedAmt.toString(),
          actualOutputRaw: actualAmt.toString(),
          tokenAddress: tokenInfo.tokenAddress,
          tokenSymbol: tokenInfo.symbol,
          tokenDecimals: tokenInfo.decimals, // HR-8: propagate actual decimals
          gapRaw: gapRaw.toString(),
          gapUsd: 0, // Will be calculated in next step
          gapType: "slippage",
          isSandwiched: false,
          isEstimated,
          contractAddress: tx.to,
        };

        analysisResults.push(result);
      }

      // Update progress
      const progress = 50 + Math.floor((i / swapTxs.length) * 40);
      await updateAnalysisJobStatus(jobId, "simulating", progress, {
        totalTxs: swapTxs.length,
        processedTxs: i + 1,
      });
    }

    // Step 5: Detect sandwiches and calculate gaps
    console.log(`[pipeline:${jobId}] Step 5/6: Calculating gaps for ${analysisResults.length} results`);
    await updateAnalysisJobStatus(jobId, "calculating", 90, {
      totalTxs: analysisResults.length,
    });

    const finalResults = await calculateGaps(analysisResults, normalizedAddress);
    console.log(`[pipeline:${jobId}] Calculated ${finalResults.length} gap results`);

    // Step 6: Store results
    const totalLossUsd = finalResults.reduce((sum, r) => sum + r.gapUsd, 0);
    const annualizationFactor = 365 / ANALYSIS_WINDOW_DAYS;
    const annualizedLossUsd = totalLossUsd * annualizationFactor;

    const summary = {
      totalLossUsd,
      sandwichLossUsd: finalResults
        .filter((r) => r.gapType === "sandwich")
        .reduce((sum, r) => sum + r.gapUsd, 0),
      delayLossUsd: finalResults
        .filter((r) => r.gapType === "delay")
        .reduce((sum, r) => sum + r.gapUsd, 0),
      slippageLossUsd: finalResults
        .filter((r) => r.gapType === "slippage")
        .reduce((sum, r) => sum + r.gapUsd, 0),
      txsAnalyzed: finalResults.length,
      txsSandwiched: finalResults.filter((r) => r.isSandwiched).length,
      worstTxHash: finalResults.length > 0
        ? finalResults.reduce((max, r) => r.gapUsd > max.gapUsd ? r : max).txHash
        : undefined,
      worstTxLossUsd: finalResults.length > 0
        ? Math.max(...finalResults.map((r) => r.gapUsd))
        : 0,
      avgDelayMs: finalResults.length > 0
        ? Math.round(
            finalResults.reduce((sum, r) => sum + (r.inclusionDelayMs || 0), 0) /
              finalResults.length
          )
        : undefined,
    };

    console.log(
      `[pipeline:${jobId}] Summary: $${totalLossUsd.toFixed(2)} loss over ${ANALYSIS_WINDOW_DAYS} days` +
      ` → $${annualizedLossUsd.toFixed(2)}/year annualized` +
      ` (${summary.txsAnalyzed} txs, ${summary.txsSandwiched} sandwiched)`
    );

    const walletAnalysis = await createOrUpdateWalletAnalysis(
      normalizedAddress,
      summary
    );

    // Store raw Etherscan transactions
    if (allTxs.length > 0) {
      console.log(`[pipeline:${jobId}] Storing ${allTxs.length} raw Etherscan transactions`);
      await storeEtherscanTransactions(walletAnalysis.id, allTxs);
    }

    // Store raw Dune mempool data
    if (mempoolDataMap.size > 0) {
      const duneMempoolArray = Array.from(mempoolDataMap.entries()).map(([txHash, data]) => ({
        txHash,
        blockNumber: swapTxs.find((tx) => tx.hash.toLowerCase() === txHash)?.blockNumber || 0,
        mempoolBlockNumber: data.mempool_block_number,
        inclusionDelayMs: data.inclusion_delay_ms,
        queryResult: data,
      }));
      console.log(`[pipeline:${jobId}] Storing ${duneMempoolArray.length} raw Dune mempool results`);
      await storeDuneMempoolData(walletAnalysis.id, duneMempoolArray);
    }

    // Store transaction details
    if (finalResults.length > 0) {
      await storeTransactionAnalysis(walletAnalysis.id, finalResults);
    }

    // Get wallet rank
    const rank = await getWalletRank(normalizedAddress);

    console.log(`[pipeline:${jobId}] Step 6/6: Storing results — total loss: $${summary.totalLossUsd.toFixed(2)}`);
    await updateAnalysisJobStatus(jobId, "complete", 100);

    return {
      address: normalizedAddress,
      windowDays: ANALYSIS_WINDOW_DAYS,
      ...summary,
      annualizedLossUsd,
      rank: rank || undefined,
      transactions: finalResults,
      analyzedAt: new Date().toISOString(),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[pipeline:${jobId}] FAILED: ${errorMessage}`);
    await updateAnalysisJobStatus(jobId, "error", 0, {
      error: errorMessage,
    });
    throw error;
  }
}
