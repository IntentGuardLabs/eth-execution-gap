import { NextRequest, NextResponse } from "next/server";
import { getWalletAnalysis, getWalletRank } from "@/lib/db";
import { isValidEthereumAddress, normalizeAddress } from "@/lib/utils";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  try {
    const { address } = await params;

    // Validate address format
    if (!isValidEthereumAddress(address)) {
      return NextResponse.json(
        { error: "Invalid Ethereum address format" },
        { status: 400 }
      );
    }

    const normalizedAddress = normalizeAddress(address);
    const analysis = await getWalletAnalysis(normalizedAddress);

    if (!analysis) {
      return NextResponse.json(
        { error: "No analysis found for this address" },
        { status: 404 }
      );
    }

    // Get wallet rank
    const rank = await getWalletRank(normalizedAddress);

    // Find worst transaction
    const worstTx = analysis.transactions.length > 0
      ? analysis.transactions.reduce((max: any, tx: any) =>
          tx.gapUsd > max.gapUsd ? tx : max
        )
      : null;
    console.log(`[results] Serving results for ${normalizedAddress}: ${analysis.txsAnalyzed} txs, $${analysis.totalLossUsd.toFixed(2)} loss, worst=$${worstTx?.gapUsd?.toFixed(2) ?? "N/A"}`);

    // Compute annualized figures on the fly — no DB change needed
    const windowDays = 180; // matches ANALYSIS_WINDOW_DAYS
    const annualizedLossUsd = analysis.totalLossUsd * (365 / windowDays);

    return NextResponse.json({
      address: analysis.address,
      windowDays,
      totalLossUsd: analysis.totalLossUsd,
      annualizedLossUsd,
      sandwichLossUsd: analysis.sandwichLossUsd,
      delayLossUsd: analysis.delayLossUsd,
      slippageLossUsd: analysis.slippageLossUsd,
      txsAnalyzed: analysis.txsAnalyzed,
      txsSandwiched: analysis.txsSandwiched,
      rank,
      worstTx: worstTx
        ? {
            hash: worstTx.txHash,
            lossUsd: worstTx.gapUsd,
            type: worstTx.gapType,
          }
        : null,
      transactions: analysis.transactions.map((tx: any) => ({
        txHash: tx.txHash,
        blockNumber: tx.blockNumber,
        mempoolBlockNumber: tx.mempoolBlockNumber,
        inclusionDelayMs: tx.inclusionDelayMs,
        expectedOutputRaw: tx.expectedOutputRaw,
        actualOutputRaw: tx.actualOutputRaw,
        tokenAddress: tx.tokenAddress,
        tokenSymbol: tx.tokenSymbol,
        gapRaw: tx.gapRaw,
        gapUsd: tx.gapUsd,
        gapType: tx.gapType,
        isSandwiched: tx.isSandwiched,
        sandwichBotAddress: tx.sandwichBotAddress,
        frontrunTxHash: tx.frontrunTxHash,
        backrunTxHash: tx.backrunTxHash,
        isEstimated: tx.isEstimated,
        createdAt: tx.createdAt,
      })),
      analyzedAt: analysis.analyzedAt,
    });
  } catch (error) {
    console.error("Error in results API:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
