# Blueprint 02: Data Contracts

> Version: 1.3 | Last updated: 2026-04-14 | Source of truth for: `lib/types.ts`

Every module's input and output schema. If the code differs from this document, this document wins until explicitly updated.

## Changelog

- 2026-04-11: Initial version — documented from actual codebase
- 2026-04-14: Added Protocol Swap Pipeline (v1: Uniswap V2) — new batch entrypoint, data types, and storage models. See "Protocol Swap Pipeline" section at the bottom.
- 2026-04-14 (v1.2): Post-review fixes. (1) `ProtocolTxRow` is a type alias of the generic `CandidateTx` — field is `to`, not `router`. `router` survives only as the denormalized field on `ProtocolSwapResult`. (2) Module P2 decoder is hand-rolled (no `viem` dep in this project) — layout-table driven, see `lib/analysis/univ2-decoder.ts`.
- 2026-04-14 (v1.3): Incremental persistence added to the protocol pipeline. Four persistence checkpoints (Dune → sim → price → swap), all batched at `PROTOCOL_PERSIST_BATCH = 10`. Dune results are cached in `DuneProtocolTxCache` (router-scoped, 30min TTL). Tenderly sims reuse the existing `TenderlySimulationRaw` cache via `getCachedSimulation`/`storeTenderlySimulation` (same helpers as the wallet pipeline). DeFiLlama prices continue to flow through `resolvePrices()` / `PriceCache`; a new `ProtocolRunTokenPrice` table records which price was applied to which token in which run (audit log, not a cache). Crash-recovery skip-path via `getPersistedSwapHashes(runId)`.

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
| EOA recipient | `to` has no contract code (Etherscan `getCode` = `0x`) |
| Excluded method sig | First 4 bytes match blacklist (see HR-3) |
| Excluded contract | `to` matches known no-gap protocol address |
| Safe inner call excluded | Outer selector `0x6a761202` → decode inner call → apply blacklist to inner selector and inner `to` |

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
0x56781388  — castVote(uint256,uint8)
0x7b3c71d3  — castVoteWithReason(uint256,uint8,string)
0x3bccf4fd  — castVoteBySig(uint256,uint8,uint8,bytes32,bytes32)
0x7d5e81e2  — propose(address[],uint256[],bytes[],string) — OpenZeppelin Governor
0xda95691a  — propose(address[],uint256[],string[],bytes[],string) — Compound Governor
0xb61d27f6  — execute (multisig)
0x049878f3  — join(uint256) — staking pool join
0xa694fc3a  — stake(uint256)
0x2e17de78  — unstake(uint256)
```

**Safe `execTransaction` decoding** (`0x6a761202`):

NOT in the blacklist. Instead, decoded using the known ABI layout (no API call):
```
execTransaction(address to, uint256 value, bytes data, uint8 operation, ...)
```
- Extract inner `to` and `data` from calldata via raw ABI offset decoding
- If inner `data` is empty → pure ETH transfer via Safe → skip
- Otherwise, extract inner selector (`data[0:4]`) and apply same blacklist + contract exclusion
- If inner call passes filters → simulate the outer tx as-is

**EIP-7702 delegate handling** (Task 16):

EOA recipients with calldata that matches a known DEX selector bypass the EOA filter. EIP-7702 allows EOAs to delegate to contract code, so a tx sending swap calldata to an EOA may be a valid DEX interaction. The filter checks: if `knownContracts` says the `to` is an EOA but the calldata starts with a DEX swap selector, simulate anyway.

**SCW flow extraction** (Task 17):

For Safe `execTransaction` txs, `getTokenOutputFromChanges()` receives the Safe address (`tx.to`) as the user, not the tx submitter (`tx.from`). This is because Tenderly's simulation shows tokens flowing to/from the Safe contract, not the EOA that submitted the multisig tx. The pipeline uses `getEffectiveWallet(tx)` to determine the correct address.

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
  windowDays: number;           // ANALYSIS_WINDOW_DAYS (10)
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

---

# Protocol Swap Pipeline (v1: Uniswap V2)

Parallel pipeline analyzing **all** swaps sent to a DEX router within a time window, aggregated at the **protocol** level (not per-wallet). Entry point: `scripts/analyze-protocol-univ2.ts` (CLI batch job, not an API route).

Signing-time proxy = first-seen timestamp in `flashbots.dataset_mempool_dumpster`. Inclusion block = from same Dune join (tx.block_number). **`deadline` from calldata is explicitly NOT used** — it is a user-set upper bound, not a signing timestamp.

## Protocol Pipeline Data Flow

```
[Dune: tx + mempool_dumpster JOIN] → ProtocolTxRow[]
  ↓
[UniV2 Calldata Decoder] → DecodedUniV2Swap[]    (non-swap selectors dropped)
  ↓
[Tenderly simulate ×2: mempool_block, inclusion_block]
  ↓
[Net flow extraction (reused Module 4b)] → per-token raw in/out amounts
  ↓
[Delta + DeFiLlama pricing (reused HR-6/7/8)] → ProtocolSwapResult[]
  ↓
[Storage: ProtocolAnalysisRun + ProtocolSwapAnalysis]
```

All hardened rules HR-1..HR-9 apply unchanged — this pipeline reuses `simulateTransaction()`, `computeNetTokenFlows()`, and DeFiLlama pricing from the per-wallet flow.

---

## Module P1: Dune Protocol Tx Source

**File**: `lib/data-sources/dune.ts` — `queryProtocolTxsWithMempool()` (new)

**Input**:
```typescript
interface ProtocolTxQueryInput {
  routerAddress: string;  // lowercase, e.g. "0x7a250d5630b4cf539739df2c5dacb4c659f2488d"
  windowDays: number;     // e.g. 1
  limit: number;          // safety cap on rows, e.g. 5000
}
```

**Output**: `ProtocolTxRow[]` — a type alias of the shared `CandidateTx` superset used by every `AnalysisPath`.

```typescript
// Shared generic superset consumed by any AnalysisPath. The field is named
// `to` rather than `router` because the same shape is reused by wallet-level
// candidate txs where "to" is not necessarily a router. The protocol path
// re-exposes this field as `router` on the per-tx result (ProtocolSwapResult)
// for caller ergonomics.
interface CandidateTx {
  txHash: string;                    // lowercase
  sender: string;                    // lowercase — tx.from (the EOA)
  to: string;                        // lowercase — tx.to (for protocol path: the router address)
  calldata: string;                  // "0x..." full input data
  value: string;                     // wei as decimal string (non-zero for ETH-in variants)
  gasPrice: string;                  // wei as decimal string
  inclusionBlockNumber: number;
  inclusionBlockTime: string;        // ISO datetime from Dune
  mempoolTimestampMs: string | null; // BigInt as string; null if tx not in dumpster
  mempoolBlockNumber: number | null; // block active when tx entered mempool; null if not in dumpster
  inclusionDelayMs: number | null;   // null if not in dumpster
}

type ProtocolTxRow = CandidateTx;
```

**Cache layer** (v1.3):

Before executing the Dune query, `queryProtocolTxsWithMempool()` consults `getCachedDuneProtocolTxs(router, windowDays)` in `lib/db.ts`. The cache-hit rule:

```
SELECT most recent DuneProtocolFetch
WHERE routerAddress = :router
  AND windowDays    >= :requestedWindowDays
  AND completedAt   >  now() - PROTOCOL_DUNE_CACHE_TTL_MS   // 30 min

If found → return DuneProtocolTxCache rows where
  routerAddress        = :router
  AND inclusionBlockTime >= now() - :requestedWindowDays
```

On a miss, the function executes the Dune query, streams rows through a batch buffer of size `PROTOCOL_PERSIST_BATCH` (10), upserting each batch into `DuneProtocolTxCache` via `saveDuneProtocolTxsBatch()`. After all rows are persisted, a single `DuneProtocolFetch` marker is written via `markDuneProtocolFetchComplete()`. **The marker is deliberately written last** — a mid-stream crash leaves partial data in `DuneProtocolTxCache` but no marker, so subsequent cache-checks return null and the caller re-fetches (idempotent upsert makes this safe).

**Stale-is-OK contract**: within the 30-minute TTL, a run reflects what was observable up to 30 minutes ago, not right now. Explicit tradeoff — avoids re-paying Dune cost on rapid re-runs.

**Query shape** (one round-trip):

```sql
SELECT
  tx.hash               AS tx_hash,
  tx."from"             AS sender,
  tx.to                 AS router,
  tx.data               AS calldata,
  tx.value              AS value,
  tx.gas_price          AS gas_price,
  tx.block_number       AS inclusion_block_number,
  tx.block_time         AS inclusion_block_time,
  mp.timestamp_ms       AS mempool_timestamp_ms,
  mp.inclusion_delay_ms AS inclusion_delay_ms,
  b.number              AS mempool_block_number
FROM ethereum.transactions tx
LEFT JOIN flashbots.dataset_mempool_dumpster mp
  ON mp.hash = tx.hash
LEFT JOIN ethereum.blocks b
  ON b.time <= from_unixtime(mp.timestamp_ms / 1000)
 AND b.time >  from_unixtime(mp.timestamp_ms / 1000 - 13)
WHERE tx.to = {routerAddress}
  AND tx.block_time >= CURRENT_TIMESTAMP - INTERVAL '{windowDays}' DAY
ORDER BY tx.block_time DESC
LIMIT {limit}
```

**Key notes**:
- `LEFT JOIN` on the mempool dumpster means private-relay / Flashbots txs still appear with null mempool fields — caller decides how to handle them (flag `isEstimated: true` and fall back to `inclusion_block - 1`).
- The `ethereum.blocks` sub-join resolves mempool timestamp → block number, mirroring the logic in `queryMempoolData()` (per-wallet flow).

---

## Module P2: UniV2 Calldata Decoder

**File**: `lib/analysis/univ2-decoder.ts` (new)

**Input**: `ProtocolTxRow`

**Output**: `DecodedUniV2Swap | null` — `null` means selector not recognized, caller drops the tx.

```typescript
type UniV2SwapMethod =
  | "swapExactTokensForTokens"                                // 0x38ed1739
  | "swapTokensForExactTokens"                                // 0x8803dbee
  | "swapExactETHForTokens"                                   // 0x7ff36ab5
  | "swapTokensForExactETH"                                   // 0x4a25d94a
  | "swapExactTokensForETH"                                   // 0x18cbafe5
  | "swapETHForExactTokens"                                   // 0xfb3bdb41
  | "swapExactTokensForTokensSupportingFeeOnTransferTokens"   // 0x5c11d795
  | "swapExactETHForTokensSupportingFeeOnTransferTokens"      // 0xb6f9de95
  | "swapExactTokensForETHSupportingFeeOnTransferTokens";     // 0x791ac947

interface DecodedUniV2Swap {
  txHash: string;
  method: UniV2SwapMethod;
  selector: string;             // "0x38ed1739"
  isExactIn: boolean;           // true for swapExact*, false for swapTokens/ETHForExact*
  tokenInIsNative: boolean;     // true for swapExactETHForTokens / swapETHForExactTokens
  tokenOutIsNative: boolean;    // true for swapExactTokensForETH / swapTokensForExactETH
  tokenIn: string;              // lowercase; = path[0] (WETH for native-in variants)
  tokenOut: string;             // lowercase; = path[path.length-1] (WETH for native-out variants)
  path: string[];               // full path, lowercase
  amountInParam: string;        // BigInt as string; exactIn → amountIn, exactOut → amountInMax
  amountOutParam: string;       // BigInt as string; exactIn → amountOutMin, exactOut → amountOut
  recipient: string;            // lowercase — "to" parameter of the swap call
}
```

**Decoder implementation — hand-rolled, layout-table driven**:

The project does not depend on `viem` or `ethers`. The decoder (`lib/analysis/univ2-decoder.ts`) performs raw 32-byte slot slicing driven by a per-method `MethodLayout` table. The 9 supported methods fall into two structural families:

```
Family A (5 static slots): methods with explicit amountIn / amountOut
  Layout: [amt0:32][amt1:32][path_offset:32][to:32][deadline:32] ... [path_data]
  Members: swapExactTokensForTokens, swapTokensForExactTokens,
           swapTokensForExactETH,    swapExactTokensForETH,
           + fee-on-transfer variants that share the same ABI

Family B (4 static slots): payable methods where amountIn is msg.value
  Layout: [amt:32][path_offset:32][to:32][deadline:32] ... [path_data]
  Members: swapExactETHForTokens, swapETHForExactTokens,
           + swapExactETHForTokensSupportingFeeOnTransferTokens
```

Each method's `MethodLayout` records:

- `staticArgs` — count of 32-byte slots before the dynamic `path` data.
- `pathArgIndex` — which slot holds the offset to the `address[] path`.
- `amountSlotIn` — slot index of the "amount-in" uint256, or `null` for payable methods where amount-in comes from `tx.value`.
- `amountSlotOut` — slot index of the "amount-out" uint256.
- `recipientSlot` — slot index of the `address to` param.
- `isExactIn`, `ethIn`, `ethOut` — classification flags.

**Decoding steps**:

1. Strip `0x` prefix from calldata; first 4 bytes (8 hex chars) = selector.
2. Look up selector in `SELECTOR_TO_METHOD`; return `null` on miss.
3. Read `staticArgs` × 32-byte slots into `staticSlots[]`.
4. Parse `pathOffset` from the slot at `pathArgIndex`, advance to `args + pathOffset × 2` hex chars.
5. Read path length (first 32 bytes at that offset); sanity-check `2 ≤ length ≤ 10` — reject malformed calldata.
6. Read `length` × 32-byte slots, taking the last 20 bytes of each as an address.
7. For `ethIn`/`ethOut` variants, collapse the user-facing side to the zero-address pseudo-token (HR-9); otherwise use `path[0]` and `path[last]`.
8. Extract `amountInParam` (from slot or `tx.value`) and `amountOutParam` (from slot) as BigInt-as-string.
9. Extract `recipient` from `recipientSlot` (last 20 bytes).

**Rationale for hand-rolling**: adding `viem` (~2 MB) just to decode 9 static-shape function calls is disproportionate. The calldata layouts are compiler-stable across all deployed Router02 instances and have not changed since 2020. The layout table doubles as a written specification of which argument goes where per method, which the review explicitly flagged as valuable.

**Key notes**:
- `deadline` is NOT in the decoded output — it is intentionally discarded. See `04-edge-cases.md` EC-P2.4.
- `value` (native ETH sent) comes from `ProtocolTxRow.value`, not from calldata.
- Multi-hop supported: `tokenIn = path[0]`, `tokenOut = path[last]`. Intermediate hops are recorded in `path` for audit but don't affect gap math (we only care about user's net token-in and token-out flows).
- Unknown selector → return null, caller drops tx (counts toward `txsDiscovered` but not `txsDecoded`). See EC-P2.1.
- Malformed calldata (bad offset, path length 0 or > 10, truncated slot) → return null. See EC-P2.2.
- `ethIn`/`ethOut` method whose `path[0]`/`path[last]` is not WETH → warn-only (decode still succeeds with the zero-address collapse). See EC-P2.3.

---

## Module P3: Swap Gap Evaluator

**File**: `lib/analysis/protocol-pipeline.ts` — `evaluateSwap()` (new)

**Input**: `DecodedUniV2Swap` + `ProtocolTxRow`

**Logic**:

1. Effective wallet = `ProtocolTxRow.sender` (the EOA).
2. Determine simulation blocks:
   - `mempoolBlockNumber` if present, else `inclusionBlockNumber - 1` with `isEstimated = true`.
   - `inclusionBlockNumber` from the Dune row.
3. Simulate the tx at both blocks via a **run-scoped `simulateWithCache(txData, blockNumber, txHash)` closure** (new in v1.3) that wraps `simulateTransaction()`:
   - Before the Tenderly call, check `getCachedSimulation(txHash, blockNumber)` — same helper as the wallet pipeline.
   - On hit, return the cached `SimulationResult` immediately. **The rate limiter is not touched on a cache hit** — no Tenderly budget spent.
   - On miss, call `simulateTransaction()` (HR-1, HR-2), buffer the result into a run-scoped sim buffer, and flush to `TenderlySimulationRaw` via the existing `storeTenderlySimulation()` helper once the buffer reaches `PROTOCOL_PERSIST_BATCH` entries (10). Sims count individually, not per swap — a 200-swap run with zero cache hits writes ~40 flush batches of 10 sims each.
   - Final flush at the end of the run guarantees no sim is left unpersisted.
4. For each simulation, run `computeNetTokenFlows(asset_changes, sender)` (HR-4, HR-9).
5. For the decoded `tokenIn`:
   - **ERC-20 side**: look up net flow at `tokenIn` address. User's outflow = `-net` if `net < 0`, else `0`.
   - **Native ETH side**: look up zero address (HR-9).
6. For the decoded `tokenOut`:
   - User's inflow = `net` if `net > 0`, else `0`.
   - Native ETH variant → zero address.
7. **HR-5** — one-sided: if mempool sim returns output but inclusion sim returns null, treat missing side as `BigInt(0)`. Only skip when BOTH sims return null.
8. **Gap-computability gate (v1.4)** — HR-5 alone is not enough. A sim that entirely failed (`simulationStatus != "ok"`) or an `ok` sim whose `asset_changes` never touched the decoded target tokens produces `expected*Raw = "0"` on both sides. Feeding that through the gap math gives `actual − 0 = full notional`, i.e. the entire trade size reported as the gap. **The gap USD is only computable when BOTH `simulationStatus == "ok"` AND the mempool sim produced at least one real flow for a target token AND the inclusion sim produced at least one real flow for a target token.** When the gate fails, raw amounts are preserved (useful for audit) but `amountInGapUsd / amountOutGapUsd / totalGapUsd` are all set to `0` and the row is excluded from run-level aggregates. See EC-P4.3.

**Output**: `ProtocolSwapResult`

```typescript
interface ProtocolSwapResult {
  txHash: string;
  sender: string;                  // lowercase
  router: string;                  // lowercase
  protocol: "uniswap-v2";

  // Decoded from calldata
  method: UniV2SwapMethod;
  selector: string;
  isExactIn: boolean;
  tokenInIsNative: boolean;
  tokenOutIsNative: boolean;
  tokenIn: string;                 // lowercase; zero address for native ETH
  tokenOut: string;                // lowercase; zero address for native ETH
  tokenInSymbol?: string;
  tokenOutSymbol?: string;
  tokenInDecimals?: number;        // HR-8 — from Tenderly token_info, fallback 18
  tokenOutDecimals?: number;       // HR-8
  pathJson: string;                // JSON.stringify(path)
  amountInParam: string;           // BigInt as string
  amountOutParam: string;          // BigInt as string
  recipient: string;

  // Timing
  mempoolBlockNumber: number | null;
  inclusionBlockNumber: number;
  mempoolTimestampMs: string | null;   // BigInt as string
  inclusionBlockTime: string;          // ISO datetime
  inclusionDelayMs: number | null;
  isEstimated: boolean;                // true if mempool block was fallback (inclusion - 1)

  // Simulated flows (BigInt as string, non-negative; direction implied by field name)
  expectedAmountInRaw: string;     // token-in outflow at mempool-block sim
  expectedAmountOutRaw: string;    // token-out inflow at mempool-block sim
  actualAmountInRaw: string;       // token-in outflow at inclusion-block sim
  actualAmountOutRaw: string;      // token-out inflow at inclusion-block sim

  // Gaps (signed BigInt as string; v1.4 sign convention — NEGATIVE = USER LOST)
  amountInGapRaw: string;          // expectedAmountIn - actualAmountIn  (negative = user PAID more than predicted)
  amountOutGapRaw: string;         // actualAmountOut - expectedAmountOut (negative = user RECEIVED less than predicted)

  // Pricing (filled by P4)
  tokenInPriceUsd: number | null;
  tokenOutPriceUsd: number | null;
  amountInGapUsd: number;          // negative = loss on the sent-token side
  amountOutGapUsd: number;         // negative = loss on the received-token side
  totalGapUsd: number;             // net_exec − net_sim; negative = user lost USD on this swap overall

  // Status
  simulationStatus: "ok" | "mempool_failed" | "inclusion_failed" | "both_failed" | "skipped";
  error?: string;

  // Audit
  rawCalldata: string;             // original hex calldata, for re-decoding without re-querying Dune
}
```

**Gap semantics (v1.4 — negative = loss)**:
- All USD gap fields follow the convention **negative = user lost funds, positive = user gained funds (positive slippage)**.
- `amountInGapRaw < 0` → user paid more tokens at inclusion than at mempool simulation. Material for **exactOut** paths (amount-in is the variable side).
- `amountOutGapRaw < 0` → user received fewer tokens at inclusion than at mempool simulation. Material for **exactIn** paths (amount-out is the variable side).
- `totalGapUsd = net_exec − net_sim` where `net_x = in_usd_x − out_usd_x`. Algebraically identical to `amountInGapUsd + amountOutGapUsd` under the v1.4 sign convention. One signed number captures the full damage (or gain) regardless of exactIn / exactOut.
- Rows that fail the gap-computability gate (step 8 above) report `amountInGapUsd = amountOutGapUsd = totalGapUsd = 0` even if raw amounts are non-zero. Those rows are present for audit but excluded from `txsWithGap` and from `totalGapUsd` aggregation on the run.

---

## Module P4: Protocol Pricer

**File**: `lib/analysis/calculator.ts` — `priceProtocolSwaps(swaps, runId)` (new signature in v1.3)

Reuses `resolvePrices()` which in turn reuses the existing `PriceCache` Prisma model via `getCachedPrices()` + `storePrices()` (HR-7). Cache checks are free — no DeFiLlama round-trip on a hit. Batches all unique `tokenIn` / `tokenOut` addresses across the run (chunk size 80 — same as wallet flow). Converts raw gaps to USD with `tokenInDecimals` / `tokenOutDecimals` (HR-8) using the safe BigInt division pattern (HR-6). Zero address → `coingecko:ethereum`.

A missing price marks the token as "unpriced" — its side of the gap is recorded as raw and `*GapUsd = 0` for that side. The per-swap `totalGapUsd` still includes whichever side is priced.

**Per-run audit snapshot** (v1.3): after resolving prices, the function persists one `ProtocolRunTokenPrice` row per unique token address via `saveRunTokenPricesBatch(runId, prices)` in batches of `PROTOCOL_PERSIST_BATCH`. Rows are keyed `(runId, tokenAddress)`, record the exact USD price applied, and cascade on run deletion. This is an **audit log** — separate from the shared `PriceCache` which is overwritten by later fetches.

The audit snapshot records unpriced tokens too (`priceUsd = null`). Purpose: later debugging can answer both "what price did we use?" and "why was this token unpriced?" from a single query.

---

## Module P5: Protocol Run Aggregator

**File**: `lib/analysis/protocol-pipeline.ts` — `runProtocolAnalysis(input, existingRunId?)` (new top-level)

**Crash recovery** (v1.3): if `existingRunId` is provided and `ProtocolAnalysisRun` already exists in `running` or `error` state, `runProtocolAnalysis()` calls `getPersistedSwapHashes(runId)` which returns the Set of `txHash` values that are already persisted on that run **with a non-error simulation status** (i.e. already fully evaluated and priced). The evaluate loop consults this Set and skips any decoded tx whose hash is already present, resuming from where the previous run crashed.

**Incremental swap persistence** (v1.3): the end-of-run `saveProtocolSwaps()` call is replaced with per-batch flushes. As swaps are evaluated and priced, results accumulate in a run-scoped buffer; once the buffer reaches `PROTOCOL_PERSIST_BATCH` entries (10), the batch is priced in-place and flushed via `saveProtocolSwaps()`. A final unconditional flush at end-of-run handles the residual. A mid-run crash leaves all fully-evaluated swaps queryable via `/api/protocol/[runId]` — the UI already renders partial state.


**Input**:
```typescript
interface ProtocolAnalysisRunInput {
  protocol: "uniswap-v2";
  routerAddress: string;
  windowDays: number;
  limit: number;
}
```

**Output**: `ProtocolAnalysisRunResult`
```typescript
interface ProtocolAnalysisRunResult {
  runId: string;
  protocol: "uniswap-v2";
  routerAddress: string;
  windowDays: number;
  windowStartBlock: number;
  windowEndBlock: number;
  txsDiscovered: number;       // rows returned by Dune
  txsDecoded: number;          // successfully decoded as one of the 9 swap methods
  txsSimulated: number;        // ≥1 of (mempool, inclusion) sim returned non-null
  txsWithGap: number;          // rows where totalGapUsd != 0 AND the gap-computability gate passed (v1.4)
  totalGapUsd: number;          // v1.4 sign: negative = net loss across the run, positive = net gain
  topLossTxHash?: string;
  topLossUsd?: number;
  swaps: ProtocolSwapResult[];
  startedAt: string;           // ISO 8601
  completedAt: string;         // ISO 8601
}
```

---

## Storage

| Blueprint table | Prisma model | Purpose |
|-----------------|--------------|---------|
| `ProtocolAnalysisRun` | `ProtocolAnalysisRun` | One row per CLI invocation — run metadata + aggregates |
| `ProtocolSwapAnalysis` | `ProtocolSwapAnalysis` | One row per analyzed swap tx — full result + audit calldata |

Tenderly sims are cached in the existing `TenderlySimulationRaw` table (standalone, keyed by `(txHash, blockNumber)`). DeFiLlama prices reuse `PriceCache`. No new raw tables for v1 — `rawCalldata` is stored inline on `ProtocolSwapAnalysis` for re-decoding. See `05-database-schema.md` for full column definitions.
