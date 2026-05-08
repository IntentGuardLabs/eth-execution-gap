import { PrismaClient } from "@prisma/client";

// Avoid instantiating multiple PrismaClient instances in development
const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Get or create an analysis job
 */
export async function getOrCreateAnalysisJob(address: string) {
  const existing = await prisma.analysisJob.findFirst({
    where: { address },
    orderBy: { createdAt: "desc" },
  });

  if (existing && existing.status !== "error") {
    return existing;
  }

  return prisma.analysisJob.create({
    data: {
      address,
      status: "pending",
      progress: 0,
    },
  });
}

/**
 * Update analysis job status
 */
export async function updateAnalysisJobStatus(
  jobId: string,
  status: string,
  progress: number,
  data?: {
    totalTxs?: number;
    processedTxs?: number;
    error?: string;
  }
) {
  return prisma.analysisJob.update({
    where: { id: jobId },
    data: {
      status,
      progress,
      totalTxs: data?.totalTxs,
      processedTxs: data?.processedTxs,
      error: data?.error,
      updatedAt: new Date(),
    },
  });
}

/**
 * Get analysis job by ID
 */
export async function getAnalysisJob(jobId: string) {
  return prisma.analysisJob.findUnique({
    where: { id: jobId },
  });
}

/**
 * Get wallet analysis with transactions
 */
export async function getWalletAnalysis(address: string) {
  return prisma.walletAnalysis.findUnique({
    where: { address },
    include: {
      transactions: {
        orderBy: { createdAt: "desc" },
      },
    },
  });
}

/**
 * Create or update wallet analysis
 */
export async function createOrUpdateWalletAnalysis(
  address: string,
  data: {
    totalLossUsd: number;
    sandwichLossUsd: number;
    delayLossUsd: number;
    slippageLossUsd: number;
    txsAnalyzed: number;
    txsSandwiched: number;
    worstTxHash?: string;
    worstTxLossUsd?: number;
    avgDelayMs?: number;
  }
) {
  return prisma.walletAnalysis.upsert({
    where: { address },
    create: {
      address,
      ...data,
    },
    update: data,
  });
}

/**
 * Get leaderboard with pagination
 */
export async function getLeaderboard(page: number, limit: number) {
  const skip = (page - 1) * limit;

  const [entries, total] = await Promise.all([
    prisma.walletAnalysis.findMany({
      orderBy: { totalLossUsd: "desc" },
      skip,
      take: limit,
      select: {
        address: true,
        totalLossUsd: true,
        txsSandwiched: true,
      },
    }),
    prisma.walletAnalysis.count(),
  ]);

  return {
    entries: entries.map((entry, index) => ({
      rank: skip + index + 1,
      address: entry.address,
      totalLossUsd: entry.totalLossUsd,
      txsSandwiched: entry.txsSandwiched,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Get wallet rank
 */
export async function getWalletRank(address: string): Promise<number | null> {
  const wallet = await prisma.walletAnalysis.findUnique({
    where: { address },
  });

  if (!wallet) {
    return null;
  }

  const rank = await prisma.walletAnalysis.count({
    where: {
      totalLossUsd: {
        gt: wallet.totalLossUsd,
      },
    },
  });

  return rank + 1;
}

/**
 * Store transaction analysis results
 */
export async function storeTransactionAnalysis(
  walletAnalysisId: string,
  transactions: Array<{
    txHash: string;
    blockNumber: number;
    mempoolBlockNumber?: number;
    inclusionDelayMs?: number;
    expectedOutputRaw: string;
    actualOutputRaw: string;
    tokenAddress: string;
    tokenSymbol?: string;
    gapRaw: string;
    gapUsd: number;
    gapType: string;
    isSandwiched: boolean;
    sandwichBotAddress?: string;
    frontrunTxHash?: string;
    backrunTxHash?: string;
    isEstimated: boolean;
  }>
) {
  return Promise.all(
    transactions.map((tx) =>
      prisma.transactionAnalysis.upsert({
        where: { txHash: tx.txHash },
        create: {
          ...tx,
          walletAnalysisId,
        },
        update: tx,
      })
    )
  );
}

/**
 * Check if transaction is already analyzed
 */
export async function isTransactionAnalyzed(txHash: string): Promise<boolean> {
  const tx = await prisma.transactionAnalysis.findUnique({
    where: { txHash },
  });
  return !!tx;
}

/**
 * Store raw Etherscan transactions for a wallet analysis
 */
export async function storeEtherscanTransactions(
  walletAnalysisId: string,
  transactions: Array<{
    hash: string;
    from: string;
    to: string;
    value: string;
    input: string;
    gas: string;
    gasPrice: string;
    gasUsed?: string;
    blockNumber: number;
    blockHash?: string;
    transactionIndex: number;
    isError: string;
    txreceipt_status?: string;
    timeStamp: string;
  }>
) {
  console.log(`[db] Storing ${transactions.length} raw Etherscan transactions for wallet analysis ${walletAnalysisId}`);
  return Promise.all(
    transactions.map((tx) =>
      prisma.etherscanTxRaw.create({
        data: {
          walletAnalysisId,
          txHash: tx.hash,
          from: tx.from,
          to: tx.to,
          value: tx.value,
          input: tx.input,
          gas: tx.gas,
          gasPrice: tx.gasPrice,
          gasUsed: tx.gasUsed,
          blockNumber: tx.blockNumber,
          blockHash: tx.blockHash,
          transactionIndex: tx.transactionIndex,
          isError: tx.isError,
          txreceipt_status: tx.txreceipt_status,
          timeStamp: tx.timeStamp,
        },
      })
    )
  );
}

/**
 * Store raw Dune mempool query results
 */
export async function storeDuneMempoolData(
  walletAnalysisId: string,
  mempoolData: Array<{
    txHash: string;
    blockNumber: number;
    mempoolBlockNumber?: number;
    inclusionDelayMs?: number;
    queryResult: Record<string, any>;
  }>
) {
  console.log(`[db] Storing ${mempoolData.length} raw Dune mempool results for wallet analysis ${walletAnalysisId}`);
  return Promise.all(
    mempoolData.map((data) =>
      prisma.duneMempoolRaw.create({
        data: {
          walletAnalysisId,
          txHash: data.txHash,
          blockNumber: data.blockNumber,
          mempoolBlockNumber: data.mempoolBlockNumber,
          inclusionDelayMs: data.inclusionDelayMs,
          queryResult: JSON.stringify(data.queryResult),
        },
      })
    )
  );
}

/**
 * Store raw Tenderly simulation results
 */
export async function storeTenderlySimulation(
  txHash: string,
  blockNumber: number,
  simulationData: {
    from: string;
    to: string;
    input: string;
    value: string;
    gas: string;
    gasPrice: string;
    simulationResult: Record<string, any>;
  }
) {
  return prisma.tenderlySimulationRaw.upsert({
    where: { txHash_blockNumber: { txHash, blockNumber } },
    create: {
      txHash,
      blockNumber,
      from: simulationData.from,
      to: simulationData.to,
      input: simulationData.input,
      value: simulationData.value,
      gas: simulationData.gas,
      gasPrice: simulationData.gasPrice,
      simulationResult: JSON.stringify(simulationData.simulationResult),
    },
    update: {
      simulationResult: JSON.stringify(simulationData.simulationResult),
      simulatedAt: new Date(),
    },
  });
}
