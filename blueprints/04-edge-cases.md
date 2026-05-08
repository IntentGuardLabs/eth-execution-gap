# Blueprint 04: Edge Cases

> Version: 1.0 | Last updated: 2026-04-11

Every known failure mode, how we detect it, what we do about it, and what the user sees. If you encounter a failure mode not listed here, **add it before writing handling code**.

## Changelog

- 2026-04-11: Initial version — documented from codebase + Hardened Rules

---

## Stage 1: Transaction Fetching (Etherscan)

### EC-1.1: No transactions found

| | |
|---|---|
| **Trigger** | Wallet has no transactions in the analysis window |
| **Detection** | Etherscan returns `message: "No transactions found"` |
| **Resolution** | Return empty result with all zeroes. Mark job as complete. |
| **User sees** | Results page with $0 total, 0 transactions analyzed |
| **Logging** | `[etherscan] No transactions found for {address}` |

### EC-1.2: Pagination overflow

| | |
|---|---|
| **Trigger** | Wallet has >10,000 txs in the window (`page * offset > 10000`) |
| **Detection** | Etherscan returns `message` containing "Result window is too large" |
| **Resolution** | Stop pagination, analyze what we have. Do not throw. |
| **User sees** | Results based on partial tx history (up to 10,000 txs) |
| **Logging** | `[etherscan] Result window too large at page {n}, stopping pagination` |

### EC-1.3: API key invalid or missing

| | |
|---|---|
| **Trigger** | `ETHERSCAN_API_KEY` not set or invalid |
| **Detection** | Missing env var check before first call, or HTTP 403 |
| **Resolution** | Throw immediately — cannot proceed |
| **User sees** | Error state: "Analysis failed" |
| **Logging** | `ETHERSCAN_API_KEY not configured` |

### EC-1.4: Rate limit hit

| | |
|---|---|
| **Trigger** | Too many requests despite rate limiter (concurrent jobs) |
| **Detection** | HTTP 429 or Etherscan error message about rate limiting |
| **Resolution** | Retry with exponential backoff (3 retries, 1s initial) |
| **User sees** | Slightly slower progress (transparent) |
| **Logging** | Handled by `retryWithBackoff` |

### EC-1.5: Network timeout

| | |
|---|---|
| **Trigger** | Etherscan unresponsive |
| **Detection** | axios timeout (15s) |
| **Resolution** | Retry with backoff. After 3 failures, throw. |
| **User sees** | Error state if all retries exhausted |
| **Logging** | `[etherscan] FAILED fetching txs for {address} at page {n}` |

---

## Stage 2: Transaction Filtering

### EC-2.1: All transactions filtered out

| | |
|---|---|
| **Trigger** | Wallet only has simple transfers, approvals, staking — no simulatable txs |
| **Detection** | `filterTransactionsForSimulation()` returns empty array |
| **Resolution** | Return empty result with all zeroes. Store raw Etherscan txs. Mark complete. |
| **User sees** | Results page with $0 total, 0 transactions analyzed |
| **Logging** | `[pipeline] No transactions require simulation — all {n} txs were filtered out` |

### EC-2.2: Unknown method signature

| | |
|---|---|
| **Trigger** | Transaction has calldata with an unrecognized 4-byte selector |
| **Detection** | Not in `EXCLUDED_METHOD_SIGS` set |
| **Resolution** | **Pass through to simulation** (blacklist approach). Better to waste a Tenderly call than miss real MEV. |
| **User sees** | Nothing — handled transparently |
| **Logging** | None (this is the expected path for DeFi txs) |

---

## Stage 3: Mempool Resolution (Dune)

### EC-3.1: Transaction not in mempool dumpster

| | |
|---|---|
| **Trigger** | Private transaction, Flashbots bundle, or tx too old for Dune data |
| **Detection** | Tx hash not in `mempoolDataMap` after Dune query |
| **Resolution** | Use `estimateMempoolBlockNumber()` = `inclusionBlock - 1` |
| **User sees** | Results may be slightly less accurate (flagged in data) |
| **Logging** | `[pipeline] mempool block: {n} (ESTIMATED: no Dune data, using inclusion_block - 1)` |
| **Data flag** | `isEstimated: true` on the TransactionAnalysisResult |

### EC-3.2: Dune query timeout

| | |
|---|---|
| **Trigger** | Query takes >120 seconds |
| **Detection** | Polling exceeds `maxAttempts` (60 * 2s) |
| **Resolution** | Throw — caught by pipeline. All txs fall back to block N-1 heuristic. |
| **User sees** | Pipeline continues with estimated mempool blocks |
| **Logging** | `[dune] Dune query timeout after 120 seconds` |

### EC-3.3: Dune query fails

| | |
|---|---|
| **Trigger** | SQL error, invalid query, Dune internal error |
| **Detection** | `state === "QUERY_STATE_FAILED"` or `"QUERY_STATE_CANCELED"` or `"QUERY_STATE_EXPIRED"` |
| **Resolution** | Throw — caught by pipeline. Fall back to heuristic for all txs. |
| **User sees** | Pipeline continues |
| **Logging** | `[dune] Dune query {state}: {error}` |

### EC-3.3b: Dune query returns partial results

| | |
|---|---|
| **Trigger** | Query completes but Dune could not return all rows |
| **Detection** | `state === "QUERY_STATE_COMPLETED_PARTIAL"` |
| **Resolution** | Treat as completed — extract available rows, log warning. Missing tx hashes fall back to `estimateMempoolBlockNumber()`. |
| **User sees** | Pipeline continues, some txs may use estimated mempool blocks |
| **Logging** | `[dune] Query returned partial results — some rows may be missing` |

### EC-3.4: Dune API key missing or invalid

| | |
|---|---|
| **Trigger** | `DUNE_API_KEY` not set |
| **Detection** | Missing env var check |
| **Resolution** | Throw. Pipeline catches, falls back to heuristic. |
| **User sees** | Pipeline continues with estimated blocks |
| **Logging** | `DUNE_API_KEY not configured` |

### EC-3.5: Dune credits exhausted

| | |
|---|---|
| **Trigger** | Monthly 2,500 credits used up |
| **Detection** | Dune returns credit-related error |
| **Resolution** | Same as EC-3.3 — throw, fall back to heuristic |
| **User sees** | Pipeline continues |
| **Logging** | Error logged by catch block |

### EC-3.6: Dune LEFT JOIN returns null mempool_block_number

| | |
|---|---|
| **Trigger** | Tx found in mempool dumpster but no `ethereum.blocks` row matches the 13s time window in the LEFT JOIN |
| **Detection** | `row.mempool_block_number` is null/undefined after query |
| **Resolution** | Inline fallback at `dune.ts:119`: `row.mempool_block_number \|\| row.included_at_block_height - 1` — same value as EC-3.1 fallback |
| **User sees** | No visible difference from EC-3.1 |
| **Note** | Unlike EC-3.1, this tx IS in the dumpster (has `timestamp_ms`, `inclusion_delay_ms`). Only the block-number lookup failed. Currently NOT flagged as `isEstimated` since the pipeline checks `!mempoolData` (which is false — the map entry exists). |

---

## Stage 4: Simulation (Tenderly)

### EC-4.1: Simulation returns null

| | |
|---|---|
| **Trigger** | Tenderly can't simulate the tx (reverts, unsupported opcode, etc.) |
| **Detection** | `response.transaction` is null or undefined |
| **Resolution** | Return `null`. Pipeline treats as no output for that side. |
| **User sees** | Tx may still appear if other side has output (HR-5) |
| **Logging** | `[tenderly] Simulation returned no transaction object at block {n}` |

### EC-4.2: asset_changes is null or empty

| | |
|---|---|
| **Trigger** | Simulation succeeds but tx has no token movements (pure ETH, internal only) |
| **Detection** | `transaction_info.asset_changes` is null/undefined/empty |
| **Resolution** | `extractAssetChanges()` returns `[]`. `getTokenOutputFromChanges()` returns `null`. |
| **User sees** | Tx skipped if both sides have no output |
| **Logging** | `[pipeline] no token output detected` |

### EC-4.3: Tenderly timeout

| | |
|---|---|
| **Trigger** | Complex tx takes too long to simulate |
| **Detection** | axios timeout (30s) |
| **Resolution** | Retry with backoff (2 retries, 2s initial). After failures, return null. |
| **User sees** | Tx skipped |
| **Logging** | `[tenderly] FAILED simulating at block {n}: {error}` |

### EC-4.4: Tenderly config missing

| | |
|---|---|
| **Trigger** | `TENDERLY_ACCOUNT`, `TENDERLY_PROJECT`, or `TENDERLY_API_KEY` not set |
| **Detection** | Check before first call |
| **Resolution** | Throw — entire pipeline fails (simulation is core functionality) |
| **User sees** | Error state |
| **Logging** | `[tenderly] Missing config: account={bool}, project={bool}, apiKey={bool}` |

### EC-4.5: Decimal string sent to Tenderly (HR-1 violation)

| | |
|---|---|
| **Trigger** | Code regression removes `toHex()` conversion |
| **Detection** | Only catchable by review/testing agents |
| **Resolution** | MUST use `toHex()` for `value` and `gas_price`. See Hardened Rule HR-1. |
| **Impact if missed** | Simulations return wrong results SILENTLY — no error, just bad data |

---

## Stage 5: Delta Calculation

### EC-5.1: Both sides have no output

| | |
|---|---|
| **Trigger** | Neither mempool sim nor inclusion sim produced token output |
| **Detection** | `!expectedOutput && !actualOutput` |
| **Resolution** | Skip this tx. Do not create a TransactionAnalysisResult. |
| **User sees** | Tx not in results |
| **Logging** | `[pipeline] no token output in either simulation — skipping` |

### EC-5.2: One side has output, other doesn't (HR-5)

| | |
|---|---|
| **Trigger** | Mempool sim shows output but inclusion sim doesn't (or vice versa) |
| **Detection** | One of `expectedOutput`/`actualOutput` is null, other isn't |
| **Resolution** | **Treat missing side as BigInt(0)**. Compute gap = expected - 0 or 0 - actual. |
| **User sees** | Tx appears with potentially large gap |
| **Logging** | `[pipeline] [no expected output — treated as 0]` or `[no actual output — treated as 0]` |
| **Rationale** | One-sided cases are often 100% slippage — the worst losses. Dropping them hides critical data. |

### EC-5.3: Different tokens in expected vs actual

| | |
|---|---|
| **Trigger** | Swap routed differently at mempool block vs inclusion block |
| **Detection** | `expectedOutput.tokenAddress !== actualOutput.tokenAddress` |
| **Resolution** | Currently uses `expectedOutput || actualOutput` for token info. Gap computed but may compare different tokens. |
| **Accepted inaccuracy** | Yes — in rare routing cases the USD conversion normalizes the comparison. Future enhancement: detect and flag. |

### EC-5.4: Negative gap (user got MORE than expected)

| | |
|---|---|
| **Trigger** | Price moved in user's favor between mempool and inclusion |
| **Detection** | `gapRaw` is negative (as BigInt) |
| **Resolution** | Included in results with negative `gapUsd`. Reduces `totalLossUsd`. |
| **User sees** | Negative gaps offset positive ones in the total |

---

## Stage 6: Pricing (DeFiLlama)

### EC-6.1: Token has no price

| | |
|---|---|
| **Trigger** | Obscure token not tracked by DeFiLlama |
| **Detection** | Token key missing from `coins` response object |
| **Resolution** | Price = 0, `gapUsd = 0`. Token marked as "unpriced" in logs. |
| **User sees** | Tx appears in results but with $0 loss |
| **Logging** | `[pricer] {n} of {total} tokens have no DeFiLlama price` |

### EC-6.2: DeFiLlama API down

| | |
|---|---|
| **Trigger** | DeFiLlama returns 5xx or is unreachable |
| **Detection** | `!response.ok` |
| **Resolution** | Log warning. All tokens in the failed batch get price 0. Pipeline continues. |
| **User sees** | Results with $0 USD values (raw gaps still shown) |
| **Logging** | `[pricer] DeFiLlama returned {status} for batch of {n} tokens` |

### EC-6.3: BigInt precision loss in USD conversion (HR-6)

| | |
|---|---|
| **Trigger** | Code regression uses `Number(bigint) / Number(bigint)` |
| **Detection** | Only catchable by review/testing agents |
| **Resolution** | MUST use safe division: `Number(gap / div) + Number(gap % div) / Number(div)` |
| **Impact if missed** | Silent precision loss for token amounts > 9e15 (common with 18-decimal tokens) |

---

## Stage 7: Storage

### EC-7.1: Database write failure

| | |
|---|---|
| **Trigger** | SQLite locked, disk full, Prisma error |
| **Detection** | Prisma throws |
| **Resolution** | Caught by pipeline's outer try-catch. Job marked as error. |
| **User sees** | Error state |
| **Logging** | `[pipeline] FAILED: {error}` |

### EC-7.2: Duplicate wallet analysis

| | |
|---|---|
| **Trigger** | Same wallet analyzed twice |
| **Detection** | `walletAnalysis.upsert()` handles this automatically |
| **Resolution** | Previous results overwritten with new analysis |
| **User sees** | Latest results |

---

## Cross-Cutting Edge Cases

### EC-X.1: Wallet address validation

| | |
|---|---|
| **Trigger** | Non-address string submitted |
| **Detection** | `isValidEthereumAddress()` check: `/^0x[a-fA-F0-9]{40}$/` |
| **Resolution** | Rejected at API route level. 400 error returned. |
| **User sees** | "Invalid Ethereum address" error in UI |
| **Where** | `app/api/analyze/route.ts` and `app/page.tsx` (client-side) |

### EC-X.2: Concurrent analysis of same wallet

| | |
|---|---|
| **Trigger** | Two requests for the same address arrive simultaneously |
| **Detection** | `getOrCreateAnalysisJob()` checks for existing non-error job |
| **Resolution** | Second request gets the existing job ID, polls same status |
| **User sees** | Both users see the same progress/results |

### EC-X.3: Very active wallet (>10,000 filtered txs)

| | |
|---|---|
| **Trigger** | Whale/bot wallet with massive DeFi activity |
| **Detection** | Etherscan pagination limit (EC-1.2) caps at 10,000 raw txs |
| **Resolution** | Analyze up to 10,000 most recent txs. Results are partial. |
| **Accepted inaccuracy** | Yes — stated as "last 30 days" but may not capture all activity for extreme wallets |

---

## Stage 4b: Asset Extraction

### EC-4b.1: ETH-output swaps — RESOLVED (HR-9)

| | |
|---|---|
| **Trigger** | Swap outputs native ETH (token → ETH) rather than an ERC-20 |
| **Detection** | `computeNetTokenFlows()` now processes both ERC20 and native ETH asset changes |
| **Resolution** | Native ETH entries (no `token_info`) are tracked using the zero address (`0x000...000`), symbol `"ETH"`, decimals `18`. DeFiLlama prices ETH via `coingecko:ethereum` (already mapped in `calculator.ts`). |
| **User sees** | Token → ETH swaps now appear in results with correct USD gap |
| **Resolved in** | HR-9, `lib/data-sources/tenderly.ts` |

### EC-4b.2: `toHex()` silently returns "0x0" on invalid input

| | |
|---|---|
| **Trigger** | `txData.value` or `txData.gasPrice` is not a valid integer string |
| **Detection** | `try/catch` inside `toHex()` function |
| **Resolution** | Returns `"0x0"` — simulation runs with 0 value or 0 gas price |
| **User sees** | Simulation may produce incorrect results or fail (returning null) |
| **Impact** | Low — unlikely with Etherscan-sourced data |

---

## Stage 6b: Pricing Accuracy

### EC-6b.1: Token decimals hardcoded to 18 — RESOLVED (HR-8)

| | |
|---|---|
| **Trigger** | Any ERC-20 with non-18 decimals (USDC=6, USDT=6, WBTC=8) |
| **Detection** | `getTokenOutputFromChanges()` now returns `decimals` from Tenderly's `token_info` |
| **Resolution** | `tokenDecimals` propagated through `TransactionAnalysisResult` → `calculateGaps()` → `gapToUsd()`. Falls back to `18` if missing. Stored in `TransactionAnalysis` Prisma model. |
| **User sees** | Correct USD loss figures for all token decimals |
| **Resolved in** | HR-8, `lib/data-sources/tenderly.ts`, `lib/analysis/calculator.ts`, `lib/types.ts`, `prisma/schema.prisma` |

### EC-6b.2: Exotic token decimal overflow (>18 decimals)

| | |
|---|---|
| **Trigger** | Non-standard ERC-20 reports more than 18 decimals |
| **Detection** | `Math.min(decimals, 18)` clamp in `gapToUsd()` |
| **Resolution** | Decimals clamped to 18 silently |
| **User sees** | Slightly inaccurate USD conversion for exotic tokens |
| **Impact** | Low — very few tokens exceed 18 decimals |

---

## Stage 7b: Storage Idempotency

### EC-7b.1: Re-analysis duplicates raw Etherscan data

| | |
|---|---|
| **Trigger** | Same wallet analyzed twice |
| **Detection** | None — `storeEtherscanTransactions` uses `create`, not `upsert` |
| **Resolution** | Duplicate `EtherscanTxRaw` rows created (no unique constraint on txHash in this table) |
| **User sees** | No visible impact, but DB grows with duplicates |
| **Impact** | Low — data correctness unaffected, storage waste only |

### EC-7b.2: Re-analysis duplicates raw Dune data

| | |
|---|---|
| **Trigger** | Same wallet analyzed twice |
| **Detection** | None — `storeDuneMempoolData` uses `create`, not `upsert` |
| **Resolution** | Duplicate `DuneMempoolRaw` rows created |
| **User sees** | No visible impact |
| **Impact** | Low — same as EC-7b.1 |

---

## Dead Code / Unused Features

### EC-DC.1: Sandwich detection not wired into pipeline

| | |
|---|---|
| **Trigger** | N/A — `detectSandwiches()` is imported but never called in `pipeline.ts` |
| **Detection** | Code inspection |
| **Resolution** | All transactions remain `isSandwiched: false` and `gapType: "slippage"` or `"delay"` |
| **User sees** | Sandwich column always shows 0; sandwich loss always $0 |
| **Impact** | **Medium** — feature exists in code but is non-functional |

### EC-DC.2: `retryWithBackoff` not used in pipeline orchestrator

| | |
|---|---|
| **Trigger** | N/A — `retryWithBackoff` is used inside data-source modules, but not by `pipeline.ts` itself |
| **Detection** | Code inspection |
| **Resolution** | Pipeline relies on each module's internal retry handling |
| **User sees** | No impact if modules handle retries correctly |
| **Impact** | Low — retry coverage is at the right level (per-module) |

### EC-DC.3: `isTransactionAnalyzed` defined but never called

| | |
|---|---|
| **Trigger** | N/A — function exists in `db.ts` but pipeline does not use it |
| **Detection** | Code inspection |
| **Resolution** | Pipeline always re-simulates all transactions (no per-tx cache check) |
| **User sees** | Slightly longer analysis times on re-runs |
| **Impact** | Low — `upsert` handles data correctness; this is a performance optimization opportunity |

### EC-DC.4: RateLimiter queue array is dead code

| | |
|---|---|
| **Trigger** | N/A — `this.queue` in `RateLimiter` is never populated; `processQueue()` always exits early |
| **Detection** | Code inspection |
| **Resolution** | All throttling works via `waitForSlot()` busy-polling |
| **User sees** | No impact |
| **Impact** | None — dead code with no behavioral consequence |
