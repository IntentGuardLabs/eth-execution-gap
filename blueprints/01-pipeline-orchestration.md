# Blueprint 01: Pipeline Orchestration

> Version: 1.0 | Last updated: 2026-04-11 | Source of truth for: `lib/analysis/pipeline.ts`, `lib/job-queue.ts`, `lib/rate-limiter.ts`

Execution order, concurrency model, retry strategy, and progress reporting for the analysis pipeline. If the code differs from this document, this document wins until explicitly updated.

## Changelog

- 2026-04-11: Initial version — documented from actual codebase

---

## Pipeline Overview

The pipeline is a strictly sequential, 6-step process orchestrated by `analyzeWallet(jobId, address)` in `lib/analysis/pipeline.ts`. Each step updates the job status in the database before executing.

```
POST /api/analyze
      |
      v
  [JobQueue] ── single concurrency, FIFO ── dedup by jobId
      |
      v
  analyzeWallet(jobId, address)
      |
      v
  Step 1: Fetch transactions (Etherscan)
      |
      v
  Step 2: Filter (blacklist, synchronous)
      |
      v
  Step 3: Query mempool (Dune, single batch SQL)
      |
      v
  Step 4: Simulate (Tenderly, 2 sims per tx, sequential loop)
      |
      v
  Step 5: Calculate (DeFiLlama pricing + gap categorization)
      |
      v
  Step 6: Store (Prisma upserts) + return WalletAnalysisResult
```

---

## Step-by-Step Execution

### Step 0: Job Creation (`POST /api/analyze`)

1. Validate address (Zod + regex `/^0x[a-fA-F0-9]{40}$/`)
2. Normalize to lowercase
3. Check DB for existing `WalletAnalysis` — if found, return `complete` immediately (no re-analysis)
4. Check for existing non-error `AnalysisJob` — reuse if found
5. Check if job already queued in `jobQueue` — return current status if so
6. Create/reset job status to `pending`, progress 0
7. Enqueue `analyzeWallet(jobId, address)` into `jobQueue`
8. Return `{ jobId, status: "pending", progress: 0 }`

### Step 1: Fetch Transactions — `fetching_txs` (progress: 10%)

- **Function**: `fetchWalletTransactions(address)` in `lib/data-sources/etherscan.ts`
- **I/O**: Etherscan API — up to 10 pages x 1000 txs (max 10,000)
- **Block window**: `latestBlock - (7200 * ANALYSIS_WINDOW_DAYS)` to `latestBlock`
- **Rate limited**: `rateLimiters.etherscan` (3 req/s, 1 concurrent)
- **Retried**: 3 total attempts, 1s initial backoff
- **Timeouts**: `getLatestBlockNumber` 10s, `fetchWalletTransactions` 15s

### Step 2: Filter — `filtering` (progress: 20%)

- **Function**: `filterTransactionsForSimulation(allTxs)` in `lib/analysis/filter.ts`
- **I/O**: None — synchronous, CPU-only
- **Logic**: Blacklist approach. See `02-data-contracts.md` Module 2.
- **Early exit**: If `swapTxs.length === 0`, skip to Step 6 with zero-value results

### Step 3: Query Mempool — `querying_mempool` (progress: 30%)

- **Function**: `queryMempoolData(txHashes)` in `lib/data-sources/dune.ts`
- **I/O**: Single Dune SQL query for all tx hashes
- **Polling**: 2s intervals, max 60 attempts (120s timeout)
- **Retried**: 2 retries on submission, 2s initial backoff
- **Side effect**: Updates job with `totalTxs: swapTxs.length`
- **Fallback**: Missing hashes use `estimateMempoolBlockNumber(inclusionBlock)` = `inclusionBlock - 1`

### Step 4: Simulate — `simulating` (progress: 50% to 90%)

- **Loop**: Sequential `for` loop over each swap transaction
- **Per transaction**:
  1. Determine `mempoolBlockNumber` (from Dune map, or fallback)
  2. `simulateTransaction(txData, mempoolBlockNumber)` — expected output
  3. `simulateTransaction(txData, tx.blockNumber)` — actual output
  4. `extractAssetChanges()` + `getTokenOutputFromChanges()` on both
  5. Compute delta: `expectedAmount - actualAmount` (BigInt)
  6. Store raw Tenderly simulations in DB
  7. Update job progress: `50 + floor((i / total) * 40)`
- **Rate limited**: `rateLimiters.tenderly` (6 req/s, 3 concurrent)
- **Retried**: 2 total attempts per simulation, 2s initial backoff
- **Skip condition**: Both sides return null → skip tx (HR-5: one-sided is kept)

### Step 5: Calculate — `calculating` (progress: 90%)

- **Function**: `calculateGaps(analysisResults, address)` in `lib/analysis/calculator.ts`
- **I/O**: DeFiLlama batch price API, chunked at 80 tokens per request
- **Rate limited**: `rateLimiters.defillama` (5 req/s, 2 concurrent)
- **Logic**: Apply USD price to each gap, categorize as sandwich/delay/slippage
- **Side effect**: Updates job with `totalTxs: analysisResults.length`

### Step 6: Store + Return — `complete` (progress: 100%)

- **Functions** (in `lib/db.ts`):
  1. `createOrUpdateWalletAnalysis(address, summary)` — upsert
  2. `storeEtherscanTransactions(walletAnalysis.id, allTxs)` — create (not upsert)
  3. `storeDuneMempoolData(walletAnalysis.id, mempoolArray)` — create (not upsert)
  4. `storeTransactionAnalysis(walletAnalysis.id, finalResults)` — upsert via `Promise.all`
  5. `getWalletRank(address)` — compute rank
- **Returns**: `WalletAnalysisResult` to the job handler

---

## Concurrency Model

### Job Queue (`lib/job-queue.ts`)

| Property | Value |
|----------|-------|
| Concurrency | **1** (single job at a time) |
| Storage | In-memory `Map<string, QueuedJob>` |
| Order | FIFO (Map insertion order) |
| Deduplication | `isJobQueued(jobId)` check before enqueue |
| Persistence | None — jobs lost on server restart |

```typescript
interface QueuedJob {
  id: string;
  address: string;
  handler: (jobId: string) => Promise<void>;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: Error;
}
```

The `startedAt`, `completedAt`, and `error` fields are written to the in-memory object but never exposed via any API. The status API reads from Prisma, not from `jobQueue`.

### Rate Limiters (`lib/rate-limiter.ts`)

| Service | Requests/sec | Max Concurrent |
|---------|-------------|----------------|
| Etherscan | 3 | 1 |
| Tenderly | 6 | 3 |
| DeFiLlama | 5 | 2 |

Implementation: `RateLimiter.execute<T>(fn)` uses a sliding-window timestamp array for per-second limiting and an `activeRequests` counter for concurrency limiting. Busy-polls at 10ms intervals when slots are full.

**Note**: Dune has no `RateLimiter` instance. Throttling is implicit via the 2s polling interval and `retryWithBackoff` on submission.

**Note**: The `queue` array inside `RateLimiter` is dead code — nothing pushes to it.

### Within-Pipeline Concurrency

| Stage | Concurrency |
|-------|------------|
| Step 1 (Etherscan) | Sequential pages |
| Step 2 (Filter) | Synchronous |
| Step 3 (Dune) | Single query, polled |
| Step 4 (Tenderly) | **Sequential** `for` loop — no parallelism despite `maxConcurrent: 5` headroom |
| Step 5 (DeFiLlama) | Sequential chunks of 80 |
| Step 6 (DB writes) | `Promise.all` for transaction upserts |

---

## Retry Strategy

### `retryWithBackoff(fn, maxRetries, initialDelayMs)` in `lib/utils.ts`

```
Total attempts: maxRetries (default 3) — NOT "original + maxRetries"
Delay between attempt i and i+1: initialDelayMs * 2^i
Only delays when i < maxRetries - 1 (no delay after final attempt)
Final: re-throws last error
```

| Caller | Total Attempts | Initial Delay | Max Total Wait |
|--------|---------------|---------------|----------------|
| Etherscan `fetchWalletTransactions` | 3 | 1,000ms | up to 1s + 2s = 3s |
| Dune `queryMempoolData` (submission) | 2 | 2,000ms | up to 2s |
| Tenderly `simulateTransaction` | 2 | 2,000ms | up to 2s |
| DeFiLlama (calculator) | 1 | — | Single attempt per chunk |

**Important**: `retryWithBackoff` is imported and used inside the data-source modules. The pipeline itself (`pipeline.ts`) does not wrap calls in retry logic — it relies on each module's internal retry handling.

---

## Progress Reporting

### Status Update Mechanism

Progress is **polled** by the client via `GET /api/status/[jobId]` at 2-second intervals. No WebSocket or SSE.

### Progress Events

| Stage | `status` | `progress` | `totalTxs` | `processedTxs` |
|-------|---------|-----------|-----------|----------------|
| Queued | `pending` | 0 | — | — |
| Step 1 | `fetching_txs` | 10 | — | — |
| Step 2 | `filtering` | 20 | — | — |
| Step 3 | `querying_mempool` | 30 | set | — |
| Step 4 start | `simulating` | 50 | set | — |
| Step 4 per-tx | `simulating` | 50-90 | set | incremented |
| Step 5 | `calculating` | 90 | updated | — |
| Step 6 | `complete` | 100 | — | — |
| Any error | `error` | 0 | — | error message set |

### Progress Formula (Step 4)

```typescript
progress = 50 + Math.floor((i / swapTxs.length) * 40);
```

Increments linearly from 50% to 90% as transactions are simulated.

### STATUS_MESSAGES (`lib/constants.ts`)

```typescript
{
  pending:          "Queued for analysis",
  fetching_txs:     "Fetching transaction history",
  filtering:        "Filtering out no-gap transactions",
  querying_mempool: "Querying mempool data",
  simulating:       "Simulating transactions",
  calculating:      "Calculating MEV losses",
  complete:         "Analysis complete",
  error:            "Analysis failed",
}
```

---

## Error Handling

### Pipeline-Level

The entire `analyzeWallet` function is wrapped in a `try/catch`:
- **On error**: `updateAnalysisJobStatus(jobId, "error", 0, { error: message })`, then re-throw
- **Progress resets to 0** on error (not preserved at last successful step)

### Per-Stage Behavior

| Stage | Failure Mode | Pipeline Impact |
|-------|-------------|-----------------|
| Step 1 (Etherscan) | Throws after retries | **Fatal** — job fails |
| Step 2 (Filter) | Cannot fail (synchronous logic) | N/A |
| Step 3 (Dune) | Throws after retries/timeout | **Fatal** — job fails |
| Step 4 (Tenderly) | Returns `null` per simulation | **Non-fatal** — tx skipped or one-sided |
| Step 5 (DeFiLlama) | Returns price 0 per chunk | **Non-fatal** — gapUsd = 0 |
| Step 6 (DB writes) | Prisma throws | **Fatal** — job fails |

### Early Exit

If `swapTxs.length === 0` after filtering:
1. Store zero-value `WalletAnalysis`
2. Store raw Etherscan transactions
3. Skip Steps 3-5 entirely
4. Mark job `complete` at 100%

---

## Cache Behavior

| Check | Location | Result |
|-------|----------|--------|
| Existing `WalletAnalysis` for address | `POST /api/analyze` | Return `complete` immediately — no re-analysis |
| Existing non-error `AnalysisJob` | `POST /api/analyze` | Reuse existing job |
| Job already queued | `POST /api/analyze` | Return current status |

**There is no TTL on cached results.** Once a wallet is analyzed, subsequent requests return the cached result indefinitely. The `analyzedAt` timestamp is stored but not used to trigger re-analysis.

---

## Latency Profile

The dominant latency factor is Step 4 (Tenderly simulations):
- 2 simulations per transaction, sequential
- Each simulation: ~200ms-2s depending on complexity
- For a wallet with 50 swap transactions: ~100 simulations = 1-3 minutes

Approximate total for a typical wallet (20-50 swap txs):
- Step 1: 2-10s (pagination)
- Step 2: <100ms
- Step 3: 5-30s (Dune query execution)
- Step 4: **30s-3min** (bottleneck)
- Step 5: 1-5s (DeFiLlama batch)
- Step 6: <2s (DB writes)
