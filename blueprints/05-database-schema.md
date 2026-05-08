# Blueprint 05: Database Schema

> Version: 1.2 | Last updated: 2026-04-14 | Source of truth for: `prisma/schema.prisma`, `lib/db.ts`

Cache tables, TTLs, keys, query patterns, and data persistence strategy. If the code differs from this document, this document wins until explicitly updated.

## Changelog

- 2026-04-11: Initial version — documented from actual codebase
- 2026-04-14: Added `ProtocolAnalysisRun` and `ProtocolSwapAnalysis` models for the protocol-level swap pipeline (see blueprint 02, Protocol Swap Pipeline section).
- 2026-04-14 (v1.2): Added incremental persistence for the protocol pipeline — three new models: `DuneProtocolTxCache`, `DuneProtocolFetch`, `ProtocolRunTokenPrice`. Rationale: re-running the same protocol should not pay full Dune cost; a crash mid-run should leave recoverable partial state; every swap's USD gap must be traceable to the exact token price used to score it.

---

## Technology

- **Database**: SQLite (file-based)
- **ORM**: Prisma
- **Connection string**: `DATABASE_URL` env var (default: `file:./data/dev.db`)
- **Client**: Singleton `PrismaClient` in `lib/db.ts`

---

## Entity Relationship Diagram

```
AnalysisJob (standalone)
  - Tracks job lifecycle
  - No FK to WalletAnalysis

WalletAnalysis (1)
  ├── (many) TransactionAnalysis    [onDelete: Cascade]
  ├── (many) EtherscanTxRaw         [onDelete: Cascade]
  └── (many) DuneMempoolRaw         [onDelete: Cascade]

ProtocolAnalysisRun (1)
  ├── (many) ProtocolSwapAnalysis   [onDelete: Cascade]
  └── (many) ProtocolRunTokenPrice  [onDelete: Cascade]

DuneProtocolTxCache (standalone)
  - Keyed by (routerAddress, txHash)
  - Shared across protocol runs for Dune cost avoidance

DuneProtocolFetch (standalone)
  - Completion marker gating cache hits
  - One row per successfully-completed Dune fetch

TenderlySimulationRaw (standalone)
  - Keyed by (txHash, blockNumber)
  - Shared by wallet and protocol pipelines (simulation cache)
```

---

## Models

### AnalysisJob

Tracks the lifecycle of an analysis pipeline run. Not linked to `WalletAnalysis`.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | String | PK, `@default(cuid())` | Job identifier |
| `address` | String | indexed | Wallet address (lowercase) |
| `status` | String | — | One of 8 status values (see below) |
| `progress` | Int | — | 0-100 percentage |
| `totalTxs` | Int? | — | Total transactions to process |
| `processedTxs` | Int? | — | Transactions processed so far |
| `error` | String? | — | Error message if status = "error" |
| `createdAt` | DateTime | `@default(now())` | Job creation time |
| `updatedAt` | DateTime | `@updatedAt` | Last status update |

**Valid status values**: `pending`, `fetching_txs`, `filtering`, `querying_mempool`, `simulating`, `calculating`, `complete`, `error`

**Indexes**: `address`

---

### WalletAnalysis

Aggregated analysis result per wallet. One row per analyzed address.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | String | PK, `@default(cuid())` | Record ID |
| `address` | String | `@unique` | Wallet address (lowercase) |
| `totalLossUsd` | Float | indexed | Total USD lost across all gap types |
| `sandwichLossUsd` | Float | — | USD lost to sandwich attacks |
| `delayLossUsd` | Float | — | USD lost to execution delay |
| `slippageLossUsd` | Float | — | USD lost to slippage |
| `txsAnalyzed` | Int | — | Count of transactions analyzed |
| `txsSandwiched` | Int | — | Count of sandwiched transactions |
| `worstTxHash` | String? | — | Hash of highest-loss transaction |
| `worstTxLossUsd` | Float? | — | USD loss of worst transaction |
| `avgDelayMs` | Int? | — | Average inclusion delay in ms |
| `rank` | Int? | — | Not actively written; computed on demand |
| `lastFetchedBlock` | Int? | — | Task 6: highest block number fetched from Etherscan |
| `analyzedAt` | DateTime | `@default(now())` | When analysis completed |
| `updatedAt` | DateTime | `@updatedAt` | Last update time |

**Relations**: `transactions` (TransactionAnalysis[]), `etherscanTxs` (EtherscanTxRaw[]), `duneMempools` (DuneMempoolRaw[])

**Indexes**: `address` (unique), `totalLossUsd` (for leaderboard ORDER BY)

---

### TransactionAnalysis

Per-transaction analysis result. Derived/computed data from the pipeline.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | String | PK, `@default(cuid())` | Record ID |
| `walletAnalysisId` | String | FK → WalletAnalysis | Parent wallet |
| `txHash` | String | `@unique` | Transaction hash |
| `blockNumber` | Int | — | Inclusion block |
| `mempoolBlockNumber` | Int? | — | Block when tx entered mempool |
| `inclusionDelayMs` | Int? | — | Delay from mempool to inclusion |
| `expectedOutputRaw` | String | — | BigInt as string (simulated at mempool block) |
| `actualOutputRaw` | String | — | BigInt as string (simulated at inclusion block) |
| `tokenAddress` | String | — | Output token contract address |
| `tokenSymbol` | String? | — | e.g. "USDC" |
| `tokenDecimals` | Int? | — | Token decimals from Tenderly (HR-8), e.g. 6 for USDC |
| `gapRaw` | String | — | BigInt as string (expected - actual) |
| `gapUsd` | Float | — | USD value of gap |
| `gapType` | String | — | `"sandwich"`, `"delay"`, or `"slippage"` |
| `isSandwiched` | Boolean | `@default(false)` | Whether sandwich attack detected |
| `sandwichBotAddress` | String? | — | Bot address if sandwiched |
| `frontrunTxHash` | String? | — | Frontrun tx hash |
| `backrunTxHash` | String? | — | Backrun tx hash |
| `isEstimated` | Boolean | `@default(false)` | True if mempool block was fallback |
| `contractAddress` | String? | — | tx.to — DEX router/aggregator |
| `createdAt` | DateTime | `@default(now())` | Record creation time |

**Indexes**: `walletAnalysisId`, `txHash` (unique), `contractAddress`

---

### EtherscanTxRaw

Raw Etherscan API response rows. Fully normalized into typed columns (no blob).

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | String | PK, `@default(cuid())` | Record ID |
| `walletAnalysisId` | String | FK → WalletAnalysis | Parent wallet |
| `txHash` | String | — | Transaction hash |
| `from` | String | — | Sender address |
| `to` | String | — | Recipient address |
| `value` | String | — | Wei value as decimal string |
| `input` | String | — | Full calldata |
| `gas` | String | — | Gas limit |
| `gasPrice` | String | — | Gas price in wei |
| `gasUsed` | String? | — | Actual gas consumed |
| `blockNumber` | Int | — | Block number |
| `blockHash` | String? | — | Block hash |
| `transactionIndex` | Int | — | Position in block |
| `isError` | String | — | "0" or "1" |
| `txreceipt_status` | String? | — | "0" or "1" |
| `timeStamp` | String | — | Unix seconds as string |
| `fetchedAt` | DateTime | `@default(now())` | When fetched |

**Composite unique**: `@@unique([walletAnalysisId, txHash])` — enables upsert on re-analysis (Task 10)

**Indexes**: `walletAnalysisId`, `txHash`, `blockNumber`

---

### DuneMempoolRaw

Raw Dune Analytics query results. Hybrid: typed columns + JSON blob.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | String | PK, `@default(cuid())` | Record ID |
| `walletAnalysisId` | String | FK → WalletAnalysis | Parent wallet |
| `txHash` | String | — | Transaction hash |
| `blockNumber` | Int | — | Inclusion block number |
| `mempoolBlockNumber` | Int? | — | Estimated mempool block |
| `inclusionDelayMs` | Int? | — | Delay in milliseconds |
| `queryResult` | String | — | `JSON.stringify()` of full Dune row |
| `queriedAt` | DateTime | `@default(now())` | When queried |

**Composite unique**: `@@unique([walletAnalysisId, txHash])` — enables upsert on re-analysis (Task 10)

**Indexes**: `walletAnalysisId`, `txHash`, `blockNumber`

---

### TenderlySimulationRaw

Raw Tenderly simulation results. Two rows per analyzed tx (mempool block + inclusion block).

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | String | PK, `@default(cuid())` | Record ID |
| `txHash` | String | — | Transaction hash |
| `blockNumber` | Int | — | Block simulated at |
| `from` | String | — | Tx sender |
| `to` | String | — | Tx recipient |
| `input` | String | — | Full calldata |
| `value` | String | — | Tx value |
| `gas` | String | — | Gas used for simulation |
| `gasPrice` | String | — | Gas price |
| `simulationResult` | String | — | `JSON.stringify()` of full Tenderly response |
| `simulatedAt` | DateTime | `@default(now())` | When simulated |

**Composite unique**: `@@unique([txHash, blockNumber])`

**Indexes**: `txHash`, `blockNumber`

---

### ProtocolAnalysisRun

Run metadata for the protocol-level swap pipeline (blueprint 02, Protocol Swap Pipeline). One row per CLI or API invocation.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | String | PK, `@default(cuid())` | Run identifier (also `runId` on child rows) |
| `protocol` | String | indexed | `"uniswap-v2"` (free-form to allow future protocols) |
| `routerAddress` | String | — | Lowercase router address scanned |
| `windowDays` | Int | — | Analysis window in days |
| `windowStartBlock` | Int? | — | First block in the window (inclusive) |
| `windowEndBlock` | Int? | — | Last block in the window (inclusive) |
| `windowStartTime` | DateTime? | — | First block's time |
| `windowEndTime` | DateTime? | — | Last block's time |
| `status` | String | indexed, `@default("running")` | `running` \| `complete` \| `error` |
| `txsDiscovered` | Int? | — | Rows returned by Dune (pre-decode) |
| `txsDecoded` | Int? | — | Txs successfully decoded as known swap methods |
| `txsSimulated` | Int? | — | Txs with at least one non-null Tenderly sim |
| `txsWithGap` | Int? | — | Txs with `totalGapUsd > 0` |
| `totalGapUsd` | Float? | — | Sum of all `totalGapUsd` |
| `topLossTxHash` | String? | — | Highest-loss tx in the run |
| `topLossUsd` | Float? | — | USD loss of the worst tx |
| `error` | String? | — | Error message if status = `error` |
| `startedAt` | DateTime | `@default(now())` | Run start |
| `completedAt` | DateTime? | — | Run finish (null while running) |

**Relations**: `swaps` (ProtocolSwapAnalysis[], cascade on delete)

**Indexes**: `protocol`, `status`, `startedAt`

---

### ProtocolSwapAnalysis

Per-swap analysis result from a protocol run. Mirrors `ProtocolSwapResult` from blueprint 02.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | String | PK, `@default(cuid())` | Record ID |
| `runId` | String | FK → ProtocolAnalysisRun | Parent run |
| `protocol` | String | indexed | Denormalized from run for cross-run queries |
| `txHash` | String | — | Transaction hash, lowercase |
| `sender` | String | indexed | EOA address, lowercase |
| `router` | String | — | Router address, lowercase |
| `method` | String | — | `UniV2SwapMethod` value (e.g. `swapExactTokensForTokens`) |
| `selector` | String | — | 4-byte selector, e.g. `0x38ed1739` |
| `isExactIn` | Boolean | — | True for `swapExact*`, false for `swap*ForExact*` |
| `tokenInIsNative` | Boolean | `@default(false)` | Native ETH on the input side |
| `tokenOutIsNative` | Boolean | `@default(false)` | Native ETH on the output side |
| `tokenIn` | String | — | Lowercase; zero address when native ETH |
| `tokenOut` | String | — | Lowercase; zero address when native ETH |
| `tokenInSymbol` | String? | — | From Tenderly `token_info.symbol` |
| `tokenOutSymbol` | String? | — | From Tenderly `token_info.symbol` |
| `tokenInDecimals` | Int? | — | HR-8: actual decimals, fallback 18 |
| `tokenOutDecimals` | Int? | — | HR-8: actual decimals, fallback 18 |
| `pathJson` | String | — | `JSON.stringify(path)` — full UniV2 path |
| `amountInParam` | String | — | BigInt as string (calldata param) |
| `amountOutParam` | String | — | BigInt as string (calldata param) |
| `recipient` | String | — | Lowercase — `to` parameter of the swap call |
| `mempoolBlockNumber` | Int? | — | Null if tx not in mempool dumpster |
| `inclusionBlockNumber` | Int | — | From Dune `tx.block_number` |
| `mempoolTimestampMs` | String? | — | BigInt as string; null if not in dumpster |
| `inclusionBlockTime` | DateTime | — | From Dune `tx.block_time` |
| `inclusionDelayMs` | Int? | — | From Dune `mp.inclusion_delay_ms` |
| `isEstimated` | Boolean | `@default(false)` | True if mempool block was fallback (`inclusion - 1`) |
| `expectedAmountInRaw` | String | — | BigInt as string — token-in outflow at mempool sim |
| `expectedAmountOutRaw` | String | — | BigInt as string — token-out inflow at mempool sim |
| `actualAmountInRaw` | String | — | BigInt as string — token-in outflow at inclusion sim |
| `actualAmountOutRaw` | String | — | BigInt as string — token-out inflow at inclusion sim |
| `amountInGapRaw` | String | — | BigInt as string; `actualIn - expectedIn` (signed) |
| `amountOutGapRaw` | String | — | BigInt as string; `expectedOut - actualOut` (signed) |
| `tokenInPriceUsd` | Float? | — | From DeFiLlama |
| `tokenOutPriceUsd` | Float? | — | From DeFiLlama |
| `amountInGapUsd` | Float | `@default(0)` | USD value of input-side gap |
| `amountOutGapUsd` | Float | `@default(0)` | USD value of output-side gap |
| `totalGapUsd` | Float | indexed, `@default(0)` | `amountInGapUsd + amountOutGapUsd` |
| `simulationStatus` | String | — | `ok` \| `mempool_failed` \| `inclusion_failed` \| `both_failed` \| `skipped` |
| `error` | String? | — | Diagnostic message on skip/failure |
| `rawCalldata` | String | — | Original hex calldata — audit / re-decode without Dune |
| `createdAt` | DateTime | `@default(now())` | Record creation time |

**Composite unique**: `@@unique([runId, txHash])` — same tx can appear in multiple runs (different windows/limits) but only once per run.

**Indexes**: `runId`, `txHash`, `protocol`, `totalGapUsd` (for "worst losses" queries), `sender`

---

### DuneProtocolTxCache

Raw Dune protocol-tx query results cached across protocol runs. Re-running the same router within the TTL window avoids paying full Dune cost. Written in batches of `PROTOCOL_PERSIST_BATCH` (10) as Dune result pages are hydrated.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | String | PK, `@default(cuid())` | Record ID |
| `routerAddress` | String | indexed | Lowercase router address, e.g. `0x7a25…488d` |
| `txHash` | String | — | Lowercase tx hash |
| `sender` | String | — | Lowercase EOA (tx.from) |
| `calldata` | String | — | `"0x..."` full input data |
| `value` | String | — | BigInt as string (wei) |
| `gasPrice` | String | — | BigInt as string (wei) |
| `inclusionBlockNumber` | Int | — | From `tx.block_number` |
| `inclusionBlockTime` | DateTime | — | From `tx.block_time` |
| `mempoolTimestampMs` | String? | — | BigInt as string; null if tx not in dumpster |
| `mempoolBlockNumber` | Int? | — | Derived: `inclusionBlockNumber - ceil(inclusionDelayMs / 12000)` |
| `inclusionDelayMs` | Int? | — | From `mp.inclusion_delay_ms` |
| `fetchedAt` | DateTime | `@default(now())` | When this row was cached |

**Composite unique**: `@@unique([routerAddress, txHash])` — upsert-safe across re-fetches.

**Indexes**: `(routerAddress, fetchedAt)` for TTL scans, `(routerAddress, inclusionBlockTime)` for window filtering.

---

### DuneProtocolFetch

Completion marker for successful Dune fetches. **Written only after all cached rows have been persisted.** This gates cache hits — a partially-written fetch (crash mid-stream) is invisible to the cache-check path until the marker lands.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | String | PK, `@default(cuid())` | Record ID |
| `routerAddress` | String | — | Lowercase router address |
| `windowDays` | Int | — | The `windowDays` value under which this fetch was executed |
| `rowCount` | Int | — | Number of rows persisted by this fetch |
| `completedAt` | DateTime | `@default(now())` | When the fetch finished and the marker landed |

**Indexes**: `(routerAddress, completedAt)` — supports the "most recent fetch" cache-check query.

**Cache-hit rule** (in `getCachedDuneProtocolTxs`):

```
SELECT most recent DuneProtocolFetch
WHERE routerAddress = :router
  AND windowDays    >= :requestedWindowDays
  AND completedAt   >  now() - PROTOCOL_DUNE_CACHE_TTL_MS

If found:
  return DuneProtocolTxCache rows WHERE
    routerAddress        = :router
    AND inclusionBlockTime >= now() - :requestedWindowDays
Else:
  return null  (caller must fetch from Dune)
```

The cache-hit path is purely a DB read — it does not go through `rateLimiters.tenderly` or any external-API budget.

---

### ProtocolRunTokenPrice

Per-run snapshot of the DeFiLlama prices applied by Module P4 for each token involved in a run's swaps. Purpose: later explain any gap number — "which price did we use for token Y in run X?" — without re-hitting DeFiLlama or interpreting "current" price after it has drifted.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | String | PK, `@default(cuid())` | Record ID |
| `runId` | String | FK → ProtocolAnalysisRun (cascade) | Parent run |
| `tokenAddress` | String | — | Lowercase; `"0x000...000"` for native ETH |
| `priceUsd` | Float? | — | DeFiLlama price at run time; null when the token is unpriced |
| `source` | String | `@default("defillama")` | Price provider (HR-7 — only ever "defillama") |
| `fetchedAt` | DateTime | `@default(now())` | When this price was captured |

**Composite unique**: `@@unique([runId, tokenAddress])` — one snapshot row per (run, token) pair.

**Indexes**: `runId`, `tokenAddress`.

**Relationship**: `prices ProtocolRunTokenPrice[]` back-relation on `ProtocolAnalysisRun`. Cascades on run deletion.

**Why this key, not `(tokenAddress, timestamp)` or `(tokenAddress, blockNumber)`**:

- `(tokenAddress, timestamp)` — accumulates near-identical rows across runs with no easy way to correlate a snapshot to a specific run's gap math. Fails the debugging question "why is run X's USDC gap wrong?"
- `(tokenAddress, blockNumber)` — DeFiLlama's free endpoint returns *current* price, not historical-by-block. A `blockNumber` key would lie about provenance.
- `(runId, tokenAddress)` — directly answers "for run X, which price scored token Y?" and cascades on run deletion.

**Relationship to `PriceCache`**: `ProtocolRunTokenPrice` is an **audit log**, not a cache. `PriceCache` remains the single source of truth for the DeFiLlama fetching + caching path (shared by wallet and protocol pipelines via `resolvePrices()` in `lib/analysis/calculator.ts`). The price snapshot is written in parallel with the existing `storePrices()` path so future callers can reconstruct which price produced a given gap number, even after `PriceCache` has been overwritten by a later run.

---

### PriceCache

Token price cache for DeFiLlama results. One row per token address.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | String | PK, `@default(cuid())` | Record ID |
| `tokenAddress` | String | `@unique` | Lowercase token address, `"0x000...000"` for ETH |
| `price` | Float | — | USD price |
| `fetchedAt` | DateTime | `@default(now())` | When price was fetched |

---

## Cache TTLs

Prices are cached permanently (current prices don't change retroactively for our analysis window). Re-analysis triggers the pipeline which checks the cache before calling DeFiLlama.

| Data Type | TTL | Rationale |
|-----------|-----|-----------|
| WalletAnalysis | **ANALYSIS_WINDOW_DAYS** | Re-analysis allowed when older than the analysis window (incremental fetch) |
| TransactionAnalysis | **None (permanent)** | Derived data, immutable once computed |
| EtherscanTxRaw | **None (permanent)** | Historical data, immutable |
| DuneMempoolRaw | **None (permanent)** | Historical data, immutable |
| TenderlySimulationRaw | **None (permanent)** | Simulations at specific blocks are deterministic/immutable |
| AnalysisJob | **None (permanent)** | Job records accumulate; no cleanup |
| ProtocolAnalysisRun | **None (permanent)** | Run records accumulate; queryable by protocol + date |
| ProtocolSwapAnalysis | **None (permanent)** | Derived data, immutable once computed |
| DuneProtocolTxCache | **`PROTOCOL_DUNE_CACHE_TTL_MS` (30 min)** | Gated by `DuneProtocolFetch.completedAt`; rows older than TTL are ignored by the cache-check but not garbage-collected |
| DuneProtocolFetch | **None (permanent)** | Marker table; markers older than TTL are simply not considered by cache-check |
| ProtocolRunTokenPrice | **None (permanent)** | Immutable audit log; cascades on parent run deletion |

**Only HTTP-level caching**: The share card SVG (`/api/share/[address]`) returns `Cache-Control: public, max-age=3600` (1 hour). This is a browser/CDN cache, not a database TTL.

### Planned TTLs (not yet implemented)

| Data Type | Target TTL | Rationale |
|-----------|-----------|-----------|
| WalletAnalysis | 24 hours | Re-fetch picks up new activity |
| AnalysisJob (error) | 1 hour | Allow retry of failed analyses |
| EtherscanTxRaw | 24 hours | Short-lived; re-fetch for fresh data |

---

## Query Patterns

### Reads

| Function | Query Pattern | Purpose |
|----------|--------------|---------|
| `getOrCreateAnalysisJob(address)` | `findFirst` by address, `orderBy createdAt desc`, status != "error" | Resume or create job |
| `getAnalysisJob(jobId)` | `findUnique` by id | Poll job status |
| `getWalletAnalysis(address)` | `findUnique` by address, `include: { transactions: { orderBy: createdAt desc } }` | Load full results with tx list |
| `getLeaderboard(page, limit)` | `findMany` orderBy `totalLossUsd desc`, `skip`/`take` pagination + parallel `count()` | Leaderboard page |
| `getWalletRank(address)` | `findUnique` by address, then `count` where `totalLossUsd > wallet.totalLossUsd` | Compute rank (2 queries) |
| `isTransactionAnalyzed(txHash)` | `findUnique` by txHash | Cache check (defined but not called in pipeline) |
| `getCachedSimulation(txHash, block)` | `findUnique` by `(txHash, blockNumber)` | Task 7: check before calling Tenderly |
| `getCachedMempoolData(txHashes)` | `findMany` by txHash IN | Task 8: check before querying Dune |
| `getCachedPrices(tokenAddresses)` | `findMany` by tokenAddress IN | Task 9: check before calling DeFiLlama |
| `getLastFetchedBlock(address)` | `findUnique` by address, select lastFetchedBlock | Task 6: incremental start block |

### Writes

| Function | Operation | Idempotent? | Notes |
|----------|-----------|-------------|-------|
| `updateAnalysisJobStatus` | `update` by id | Yes | Called 7+ times per pipeline run |
| `createOrUpdateWalletAnalysis` | `upsert` by address | Yes | Safe to re-run |
| `storeTransactionAnalysis` | `upsert` by txHash via `Promise.all` | Yes | Parallel, safe to re-run |
| `storeEtherscanTransactions` | `upsert` by `(walletAnalysisId, txHash)` via `Promise.all` | Yes | Task 10: idempotent |
| `storeDuneMempoolData` | `upsert` by `(walletAnalysisId, txHash)` via `Promise.all` | Yes | Task 10: idempotent |
| `storeTenderlySimulation` | `upsert` by `(txHash, blockNumber)` | Yes | Safe to re-run |
| `storePrices(map)` | `upsert` by tokenAddress | Yes | Task 9: cache DeFiLlama results |
| `updateLastFetchedBlock(address, block)` | `update` by address | Yes | Task 6: track fetch progress |
| `saveDuneProtocolTxsBatch(rows)` | `upsert` by `(routerAddress, txHash)` via `Promise.all` | Yes | Protocol: Dune cache batched at `PROTOCOL_PERSIST_BATCH` |
| `markDuneProtocolFetchComplete(router, windowDays, rowCount)` | `create` on `DuneProtocolFetch` | No | Protocol: written only after all rows flushed; gates cache hits |
| `saveRunTokenPricesBatch(runId, prices)` | `upsert` by `(runId, tokenAddress)` via `Promise.all` | Yes | Protocol: per-run audit of DeFiLlama prices |
| `getPersistedSwapHashes(runId)` | `findMany` by `runId`, non-error rows only | N/A (read) | Protocol: crash-recovery skip-set for `evaluateSwap` loop |

---

## Data Lifecycle

```
1. POST /api/analyze
     → AnalysisJob created (status: pending)

2. Pipeline runs (Steps 1-5)
     → AnalysisJob updated at each step

3. Step 6: Storage
     → WalletAnalysis upserted
     → TransactionAnalysis[] upserted
     → EtherscanTxRaw[] created
     → DuneMempoolRaw[] created
     → TenderlySimulationRaw[] upserted (during Step 4)
     → AnalysisJob updated to complete

4. GET /api/results/[address]
     → Reads WalletAnalysis + TransactionAnalysis[]
     → Computes annualizedLossUsd and worstTx on the fly

5. GET /api/leaderboard
     → Reads WalletAnalysis ordered by totalLossUsd desc
```

---

## Cascade Behavior

Deleting a `WalletAnalysis` record cascades to:
- All related `TransactionAnalysis` records
- All related `EtherscanTxRaw` records
- All related `DuneMempoolRaw` records

`TenderlySimulationRaw` and `AnalysisJob` are **not** cascade-deleted (standalone tables).
