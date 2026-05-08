# Blueprint 02: Data Contracts

> Version: 1.0 | Last updated: 2026-04-11 | Source of truth for: `lib/types.ts`

Every module's input and output schema. If the code differs from this document, this document wins until explicitly updated.

## Changelog

- 2026-04-11: Initial version — documented from actual codebase

---

## Pipeline Data Flow

```
[Etherscan] → Transaction[] → [Filter] → Transaction[] → [Dune] → MempoolData[]
                                                                         ↓
[Tenderly] ← Transaction[] + MempoolData[] → SimulationResult[] → [Delta] → TransactionAnalysisResult[]
                                                                                      ↓
                                                                              [DeFiLlama Pricer]
                                                                                      ↓
                                                                           WalletAnalysisResult
```

---

## Module 1: Etherscan Transaction Fetcher

**File**: `lib/data-sources/etherscan.ts` — `fetchWalletTransactions()`

**Input**:
```typescript
address: string  // lowercase, validated 0x + 40 hex
```

**Output**: `Transaction[]`
```typescript
interface Transaction {
  hash: string;              // "0xabc..." — tx hash
  from: string;              // "0x..." — sender, lowercase
  to: string;                // "0x..." — recipient/contract, lowercase
  value: string;             // decimal string in wei, e.g. "1000000000000000000"
  input: string;             // calldata hex, e.g. "0x38ed1739..."
  gas: string;               // decimal string, e.g. "200000"
  gasPrice: string;          // decimal string in wei, e.g. "30000000000"
  gasUsed?: string;          // decimal string, may be undefined
  blockNumber: number;       // integer block number
  blockHash?: string;        // "0x..." — may be undefined
  transactionIndex: number;  // integer position in block
  isError: string;           // "0" = success, "1" = failed
  txreceipt_status?: string; // "1" = success, "0" = failed, may be undefined
  timeStamp: string;         // unix seconds as decimal string, e.g. "1712345678"
}
```

**Key notes**:
- All numeric values are **decimal strings** (Etherscan format). Never hex.
- `value`, `gas`, `gasPrice` must be converted to hex before sending to Tenderly (HR-1).
- `blockNumber` and `transactionIndex` are already parsed to `number` by the fetcher.

---

## Module 2: Transaction Filter

**File**: `lib/analysis/filter.ts` — `filterTransactionsForSimulation()`

**Input**: `Transaction[]` (from Module 1)

**Output**: `Transaction[]` (subset — only txs that need simulation)

**Filter logic** (blacklist approach — `needsSimulation()`):

Excluded if ANY of these are true:
| Condition | Check |
|-----------|-------|
| Failed tx | `isError === "1"` or `txreceipt_status === "0"` |
| Contract deployment | `to` is null/undefined |
| Simple ETH transfer | `input === "0x"` or `input === ""` |
| Excluded method sig | First 4 bytes match blacklist (see HR-3) |
| Excluded contract | `to` matches known no-gap protocol address |

**Blacklisted method signatures** (HR-3):
```
0xa9059cbb  — ERC-20 transfer
0x095ea7b3  — ERC-20 approve
0x23b872dd  — ERC-721 transferFrom
0x42842e0e  — ERC-721 safeTransferFrom (no data)
0xb88d4fde  — ERC-721 safeTransferFrom (with data)
0xf242432a  — ERC-1155 safeTransferFrom
0x2eb2c2d6  — ERC-1155 safeBatchTransferFrom
0xa22cb465  — setApprovalForAll
0x2e1a7d4d  — WETH withdraw
0xd0e30db0  — WETH deposit
0x3659cfe6  — upgradeTo (proxy)
0x5c19a95c  — delegate (governance)
0x56781388  — castVote
0xb61d27f6  — execute (multisig)
0x6a761202  — execTransaction (Gnosis Safe)
```

Everything else passes through to simulation.

---

## Module 3: Mempool Resolver

**File**: `lib/data-sources/dune.ts` — `queryMempoolData()`

**Input**: `txHashes: string[]` (hashes of filtered transactions)

**Output**: `Map<string, MempoolData>` (keyed by lowercase tx hash)
```typescript
interface MempoolData {
  hash: string;                    // tx hash
  timestamp_ms: number;            // when tx entered mempool (unix ms)
  inclusion_delay_ms: number;      // time from mempool to inclusion
  included_at_block_height: number; // block where tx was included
  mempool_block_number: number;    // block active when tx entered mempool
  mempool_block_time: string;      // datetime string of that block (e.g. "2025-04-05 12:34:56")
}
```

**Fallback**: `estimateMempoolBlockNumber(inclusionBlock)` returns `inclusionBlock - 1` when Dune has no data. Flagged as `isEstimated: true` downstream.

**Key notes**:
- Map may have fewer entries than input hashes (not all txs are in mempool dumpster)
- Private/Flashbots txs won't appear in Dune data — always use the fallback

---

## Module 4: Transaction Simulator

**File**: `lib/data-sources/tenderly.ts` — `simulateTransaction()`

**Input**:
```typescript
txData: {
  from: string;      // lowercase address
  to: string;        // lowercase address
  input: string;     // hex calldata
  value: string;     // decimal string in wei (converted to hex internally)
  gas: string;       // decimal string (ignored — uses 8M constant, HR-2)
  gasPrice: string;  // decimal string in wei (converted to hex internally)
}
blockNumber: number  // block to simulate at
```

**Output**: `SimulationResult | null`
```typescript
interface SimulationResult {
  transaction_info: {
    asset_changes: Array<{
      type: string;         // "ERC20", "ERC721", "NATIVE", etc.
      from: string;         // address that sent tokens
      to: string;           // address that received tokens
      token_info?: {
        address: string;    // token contract address
        symbol: string;     // e.g. "USDC"
        decimals: number;   // e.g. 6
      };
      amount: string;       // raw amount as decimal string
    }>;
  };
}
```

Returns `null` if simulation fails (Tenderly error, timeout, etc.). Never throws.

---

## Module 4b: Net Flow Extraction

**File**: `lib/data-sources/tenderly.ts` — `computeNetTokenFlows()`, `getTokenOutputFromChanges()`

**Input**: `asset_changes[]` from SimulationResult + `userAddress: string`

**`computeNetTokenFlows()` output**:
```typescript
Array<{
  tokenAddress: string;  // lowercase
  symbol: string;        // from token_info
  decimals: number;      // from token_info
  net: bigint;           // positive = wallet received, negative = wallet sent
}>
```

**`getTokenOutputFromChanges()` output** (picks largest net-positive):
```typescript
{
  amount: string;        // net amount as decimal string (BigInt.toString())
  tokenAddress: string;  // lowercase
  decimals: number;      // from token_info (HR-8) — 18 for ETH, actual for ERC-20
  symbol?: string;
} | null
```

**Key notes (HR-4, HR-9)**:
- Computes net per token: `sum(inflows to wallet) - sum(outflows from wallet)`
- Considers `type === "ERC20"` changes AND native ETH changes (no `token_info`) (HR-9)
- Native ETH uses address `0x0000000000000000000000000000000000000000`, symbol `"ETH"`, decimals `18`
- Skips non-fungible types (ERC721, ERC1155) that have `token_info` but are not priced
- Returns the token with the largest positive net flow (the swap output)
- Returns `null` if no token has positive net flow

---

## Module 5: Delta Calculator (in pipeline)

**File**: `lib/analysis/pipeline.ts` — inline in the simulation loop

**Input**: Two calls to `getTokenOutputFromChanges()` — one for mempool block, one for inclusion block

**Output**: `TransactionAnalysisResult`
```typescript
interface TransactionAnalysisResult {
  txHash: string;                    // original tx hash
  blockNumber: number;               // inclusion block
  mempoolBlockNumber?: number;       // block where tx entered mempool
  inclusionDelayMs?: number;         // from Dune, if available
  expectedOutputRaw: string;         // BigInt as string — simulated output at mempool block
  actualOutputRaw: string;           // BigInt as string — simulated output at inclusion block
  tokenAddress: string;              // output token address, lowercase
  tokenSymbol?: string;              // e.g. "USDC"
  tokenDecimals?: number;            // from Tenderly token_info (HR-8) — e.g. 6 for USDC
  gapRaw: string;                    // BigInt as string — expectedOutputRaw - actualOutputRaw
  gapUsd: number;                    // 0 at this stage, filled by pricer
  gapType: "sandwich" | "delay" | "slippage";  // filled by categorizer
  isSandwiched: boolean;             // false at this stage, filled by sandwich detector
  sandwichBotAddress?: string;
  frontrunTxHash?: string;
  backrunTxHash?: string;
  isEstimated: boolean;              // true if mempool block was fallback (block N-1)
  contractAddress?: string;          // tx.to — for protocol-level aggregation
}
```

**Key rule (HR-5)**: If one side has output but the other doesn't, the missing side is `BigInt(0)`. Only skip when BOTH sides return `null`.

---

## Module 6: Price Resolver

**File**: `lib/analysis/calculator.ts` — `calculateGaps()`

**Input**: `TransactionAnalysisResult[]` (with `gapUsd: 0`)

**Output**: `TransactionAnalysisResult[]` (with `gapUsd` filled and `gapType` categorized)

**Pricing** (HR-7): DeFiLlama batch API. Chunks at 80 tokens per request.

**Gap categorization**:
| Condition | Type |
|-----------|------|
| `isSandwiched === true` | `"sandwich"` |
| `inclusionDelayMs > EXECUTION_DELAY_THRESHOLD_MS` (12000ms) | `"delay"` |
| Everything else | `"slippage"` |

**USD conversion (HR-6, HR-8)**:
```typescript
const decimals = result.tokenDecimals || 18;  // HR-8: use actual decimals, fallback 18
const whole = gap / divisor;
const frac = gap % divisor;
const gapInTokens = Number(whole) + Number(frac) / Number(divisor);
const gapUsd = gapInTokens * priceUsd;
```

---

## Module 7: Final Result

**File**: `lib/analysis/pipeline.ts` — return value of `analyzeWallet()`

**Output**: `WalletAnalysisResult`
```typescript
interface WalletAnalysisResult {
  address: string;              // lowercase
  windowDays: number;           // ANALYSIS_WINDOW_DAYS (30)
  totalLossUsd: number;         // sum of all gapUsd
  sandwichLossUsd: number;      // sum where gapType === "sandwich"
  delayLossUsd: number;         // sum where gapType === "delay"
  slippageLossUsd: number;      // sum where gapType === "slippage"
  annualizedLossUsd: number;    // totalLossUsd * (365 / windowDays)
  txsAnalyzed: number;          // count of TransactionAnalysisResult[]
  txsSandwiched: number;        // count where isSandwiched === true
  avgDelayMs?: number;          // average inclusionDelayMs across all txs
  rank?: number;                // wallet's rank by totalLossUsd (from DB)
  worstTx?: { hash: string; lossUsd: number; type: string; };
  transactions: TransactionAnalysisResult[];
  analyzedAt: string;           // ISO 8601 timestamp
}
```

---

## API Response Types

### `GET /api/results/[address]`

Returns `WalletAnalysisResult` shape with `annualizedLossUsd` computed on the fly from stored `totalLossUsd` and `ANALYSIS_WINDOW_DAYS` from `lib/constants.ts`.

### `GET /api/leaderboard`

```typescript
interface LeaderboardResponse {
  entries: Array<{
    rank: number;
    address: string;
    addressTruncated: string;   // "0x1234...abcd"
    totalLossUsd: number;
    txsSandwiched: number;
  }>;
  totalWallets: number;
  page: number;
  limit: number;
  totalPages: number;
}
```

### `GET /api/status/[jobId]`

```typescript
interface AnalysisJobStatus {
  jobId: string;
  status: "pending" | "fetching_txs" | "filtering" | "querying_mempool"
        | "simulating" | "calculating" | "complete" | "error";
  progress: number;        // 0-100
  totalTxs?: number;
  processedTxs?: number;
  currentStep?: string;
  error?: string;
}
```
