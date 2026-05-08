# Blueprint 05: Database Schema

> Version: 1.0 | Last updated: 2026-04-11 | Source of truth for: `prisma/schema.prisma`, `lib/db.ts`

Cache tables, TTLs, keys, query patterns, and data persistence strategy. If the code differs from this document, this document wins until explicitly updated.

## Changelog

- 2026-04-11: Initial version — documented from actual codebase

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

TenderlySimulationRaw (standalone)
  - Keyed by (txHash, blockNumber)
  - No FK to WalletAnalysis
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

## Cache TTLs

**There are no application-level TTLs.** The database is a permanent store with no eviction.

| Data Type | TTL | Rationale |
|-----------|-----|-----------|
| WalletAnalysis | **None (permanent)** | Once analyzed, cached indefinitely. `analyzedAt` stored but not gated on. |
| TransactionAnalysis | **None (permanent)** | Derived data, immutable once computed |
| EtherscanTxRaw | **None (permanent)** | Historical data, immutable |
| DuneMempoolRaw | **None (permanent)** | Historical data, immutable |
| TenderlySimulationRaw | **None (permanent)** | Simulations at specific blocks are deterministic/immutable |
| AnalysisJob | **None (permanent)** | Job records accumulate; no cleanup |

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

### Writes

| Function | Operation | Idempotent? | Notes |
|----------|-----------|-------------|-------|
| `updateAnalysisJobStatus` | `update` by id | Yes | Called 7+ times per pipeline run |
| `createOrUpdateWalletAnalysis` | `upsert` by address | Yes | Safe to re-run |
| `storeTransactionAnalysis` | `upsert` by txHash via `Promise.all` | Yes | Parallel, safe to re-run |
| `storeEtherscanTransactions` | **`create`** via `Promise.all` | **No** | Will duplicate on re-analysis |
| `storeDuneMempoolData` | **`create`** via `Promise.all` | **No** | Will duplicate on re-analysis |
| `storeTenderlySimulation` | `upsert` by `(txHash, blockNumber)` | Yes | Safe to re-run |

### Known Issue: Non-Idempotent Raw Storage

`storeEtherscanTransactions` and `storeDuneMempoolData` use `create` instead of `upsert`. Re-analyzing a wallet will:
- Append duplicate `EtherscanTxRaw` rows
- Append duplicate `DuneMempoolRaw` rows
- Not crash (no unique constraint on these tables for txHash)

This is accepted technical debt. Fix: switch to `upsert` or add a `deleteMany` before `create`.

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
