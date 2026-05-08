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
  /**
   * Datetime of the mempool block. Only populated when the SQL query
   * joins `ethereum.blocks`. The 2026-05 rewrite of `queryMempoolData`
   * computes `mempool_block_number` via arithmetic on `inclusion_delay_ms`
   * instead and leaves this field undefined.
   */
  mempool_block_time?: string;
}

/**
 * Single entry in Tenderly's `transaction_info.asset_changes` array.
 *
 * Shape corrected on 2026-04-15 after inspecting real responses from the
 * `simulation_type: "full"` endpoint. Prior to this, the codebase assumed
 * a shape that didn't exist (`token_info.address`, `type === "ERC20"`),
 * which caused every asset change to collapse into the zero-address
 * "ETH" bucket with amount 0 — see EC-P3.7.
 */
export interface TenderlyAssetChange {
  /** Event-level classification — NOT a token standard. */
  type: "Mint" | "Transfer" | "Burn" | string;
  /** Absent on `Mint` events (minted from nothing). Lowercase hex on Transfers. */
  from?: string;
  /** Always present. Lowercase hex. */
  to: string;
  /** Human-readable decimal amount, e.g. `"0.1376"`. Use `raw_amount` for math. */
  amount: string;
  /** BigInt-parseable wei/base-unit string, e.g. `"137600000000000000"` — preferred for arithmetic. */
  raw_amount?: string;
  /** USD value at simulation time, if Tenderly knew a price. */
  dollar_value?: string;
  /**
   * Token metadata. Populated for BOTH ERC-20 and native ETH entries
   * (native ETH has `standard: "NativeCurrency"` and no `contract_address`).
   */
  token_info?: {
    /** `"ERC20"`, `"NativeCurrency"`, `"ERC721"`, `"ERC1155"`, etc. */
    standard: string;
    /** `"Fungible"`, `"Native"`, `"NonFungible"`, etc. */
    type?: string;
    /** Present for ERC-20 / NFT entries. Absent for native ETH. */
    contract_address?: string;
    symbol?: string;
    name?: string;
    decimals?: number;
  };
}

export interface SimulationResult {
  transaction_info: {
    asset_changes: TenderlyAssetChange[];
  };
  /**
   * Tenderly's `transaction.status` field, hoisted up here for caller
   * convenience. `true` = the simulated EVM execution succeeded.
   * `false` = it reverted (slippage check, missing approval, pool state
   * mismatch, etc.). When false, `asset_changes` is typically empty —
   * the canonical gap analysis must NOT treat that as "expected = 0";
   * see `analyzeTransactionGap`.
   */
  status: boolean;
  /** Reason from Tenderly when `status` is false. */
  errorMessage?: string;
}


// ─────────────────────────────────────────────────────────────────────────────
// Protocol Swap Pipeline (blueprint 02, "Protocol Swap Pipeline" section)
// ─────────────────────────────────────────────────────────────────────────────

/** Shared candidate-tx shape consumed by any AnalysisPath. */
export interface CandidateTx {
  txHash: string;
  sender: string;
  to: string;
  calldata: string;
  value: string;
  gasPrice: string;
  inclusionBlockNumber: number;
  inclusionBlockTime: string;
  mempoolTimestampMs: string | null;
  mempoolBlockNumber: number | null;
  inclusionDelayMs: number | null;
}

/** Module P1 output — one row per router tx, joined with mempool_dumpster. */
export type ProtocolTxRow = CandidateTx;

export type UniV2SwapMethod =
  | "swapExactTokensForTokens"
  | "swapTokensForExactTokens"
  | "swapExactETHForTokens"
  | "swapTokensForExactETH"
  | "swapExactTokensForETH"
  | "swapETHForExactTokens"
  | "swapExactTokensForTokensSupportingFeeOnTransferTokens"
  | "swapExactETHForTokensSupportingFeeOnTransferTokens"
  | "swapExactTokensForETHSupportingFeeOnTransferTokens";

/** Module P2 output — decoded UniV2 swap call. `deadline` is intentionally NOT present. */
export interface DecodedUniV2Swap {
  txHash: string;
  method: UniV2SwapMethod;
  selector: string;
  isExactIn: boolean;
  tokenInIsNative: boolean;
  tokenOutIsNative: boolean;
  tokenIn: string;
  tokenOut: string;
  path: string[];
  amountInParam: string;
  amountOutParam: string;
  recipient: string;
}

/** Module P3 output — per-tx analysis result for a protocol swap. */
export interface ProtocolSwapResult {
  txHash: string;
  sender: string;
  router: string;
  protocol: "uniswap-v2";

  method: UniV2SwapMethod;
  selector: string;
  isExactIn: boolean;
  tokenInIsNative: boolean;
  tokenOutIsNative: boolean;
  tokenIn: string;
  tokenOut: string;
  tokenInSymbol?: string;
  tokenOutSymbol?: string;
  tokenInDecimals?: number;
  tokenOutDecimals?: number;
  pathJson: string;
  amountInParam: string;
  amountOutParam: string;
  recipient: string;

  mempoolBlockNumber: number | null;
  inclusionBlockNumber: number;
  mempoolTimestampMs: string | null;
  inclusionBlockTime: string;
  inclusionDelayMs: number | null;
  isEstimated: boolean;

  expectedAmountInRaw: string;
  expectedAmountOutRaw: string;
  actualAmountInRaw: string;
  actualAmountOutRaw: string;

  amountInGapRaw: string;
  amountOutGapRaw: string;

  tokenInPriceUsd: number | null;
  tokenOutPriceUsd: number | null;
  amountInGapUsd: number;
  amountOutGapUsd: number;
  totalGapUsd: number;

  simulationStatus:
    | "ok"
    | "mempool_failed"
    | "inclusion_failed"
    | "both_failed"
    | "skipped";
  error?: string;

  rawCalldata: string;
}

export interface ProtocolAnalysisRunInput {
  protocol: "uniswap-v2";
  routerAddress: string;
  windowDays: number;
  /**
   * Precise window in minutes. When set (> 0), takes precedence over
   * `windowDays` in the Dune query (`INTERVAL 'N' MINUTE`). Also causes the
   * Dune result cache to be bypassed — sub-day smoke runs are ephemeral and
   * don't participate in the router-scoped cache.
   */
  windowMinutes?: number;
  limit: number;
}

export interface ProtocolAnalysisRunResult {
  runId: string;
  protocol: "uniswap-v2";
  routerAddress: string;
  windowDays: number;
  windowMinutes?: number;
  windowStartBlock: number;
  windowEndBlock: number;
  txsDiscovered: number;
  txsDecoded: number;
  txsSimulated: number;
  txsWithGap: number;
  totalGapUsd: number;
  topLossTxHash?: string;
  topLossUsd?: number;
  swaps: ProtocolSwapResult[];
  startedAt: string;
  completedAt: string;
}
