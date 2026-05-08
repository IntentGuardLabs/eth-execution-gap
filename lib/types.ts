// Execution Gap Analysis Types

export interface Transaction {
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
}

export interface MempoolData {
  hash: string;
  timestamp_ms: number;
  inclusion_delay_ms: number;
  included_at_block_height: number;
  mempool_block_number: number;
  mempool_block_time: string;
}

export interface SimulationResult {
  transaction_info: {
    asset_changes: Array<{
      type: string;
      from: string;
      to: string;
      token_info?: {
        address: string;
        symbol: string;
        decimals: number;
      };
      amount: string;
    }>;
  };
}

export interface TransactionAnalysisResult {
  txHash: string;
  blockNumber: number;
  mempoolBlockNumber?: number;
  inclusionDelayMs?: number;
  expectedOutputRaw: string;
  actualOutputRaw: string;
  tokenAddress: string;
  tokenSymbol?: string;
  tokenDecimals?: number; // HR-8: actual decimals from Tenderly token_info
  gapRaw: string;
  gapUsd: number;
  gapType: "sandwich" | "delay" | "slippage";
  isSandwiched: boolean;
  sandwichBotAddress?: string;
  frontrunTxHash?: string;
  backrunTxHash?: string;
  isEstimated: boolean;
  contractAddress?: string; // For protocol-level aggregation
}

export interface WalletAnalysisResult {
  address: string;
  /** Analysis window in days (e.g. 30) */
  windowDays: number;
  totalLossUsd: number;
  sandwichLossUsd: number;
  delayLossUsd: number;
  slippageLossUsd: number;
  /** Annualized total loss (totalLossUsd * 365 / windowDays) */
  annualizedLossUsd: number;
  txsAnalyzed: number;
  txsSandwiched: number;
  avgDelayMs?: number;
  rank?: number;
  worstTx?: {
    hash: string;
    lossUsd: number;
    type: string;
  };
  transactions: TransactionAnalysisResult[];
  analyzedAt: string;
}

export interface AnalysisJobStatus {
  jobId: string;
  status: "pending" | "fetching_txs" | "filtering" | "querying_mempool" | "simulating" | "calculating" | "complete" | "error";
  progress: number;
  totalTxs?: number;
  processedTxs?: number;
  currentStep?: string;
  error?: string;
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  addressTruncated: string;
  totalLossUsd: number;
  txsSandwiched: number;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  totalWallets: number;
  page: number;
  limit: number;
  totalPages: number;
}
