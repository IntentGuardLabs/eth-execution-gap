# Blueprint 04: Edge Cases

> Version: 1.1 | Last updated: 2026-04-14

Every known failure mode, how we detect it, what we do about it, and what the user sees. If you encounter a failure mode not listed here, **add it before writing handling code**.

## Changelog

- 2026-04-11: Initial version — documented from codebase + Hardened Rules
- 2026-04-14 (v1.1): Added Stage P (Protocol Swap Pipeline) covering P1–P5 failure modes for the Uniswap V2 batch entrypoint.

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

### EC-3.7: Dune completely unavailable

| | |
|---|---|
| **Trigger** | Any Dune failure: credits exhausted, API down, key invalid, timeout, query error |
| **Detection** | `queryMempoolData()` throws — caught by pipeline try/catch at `pipeline.ts:80-87` |
| **Resolution** | Pipeline logs warning, continues with empty `Map<string, MempoolData>`. All txs fall back to `estimateMempoolBlockNumber(inclusionBlock)` = block N-1. All results flagged `isEstimated: true`. |
| **User sees** | Analysis completes normally. Results may be slightly less accurate (all mempool blocks estimated). |
| **Logging** | `[pipeline:{jobId}] Dune query failed: {msg} — falling back to block N-1 for all txs` |

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
| **Accepted inaccuracy** | Yes — stated as "last 10 days" but may not capture all activity for extreme wallets |

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

## Stage 7b: Storage Idempotency — RESOLVED (Task 10)

Both `storeEtherscanTransactions` and `storeDuneMempoolData` now use `upsert` with `@@unique([walletAnalysisId, txHash])` composite keys. Re-analysis is idempotent — no duplicate rows.

---

## Dead Code / Unused Features

### EC-DC.1: Sandwich detection — REMOVED

`sandwich.ts` and `detectSandwiches()` removed. Sandwich detection is deferred to a future phase. All transactions have `isSandwiched: false`. The `isSandwiched` and `sandwichBotAddress` fields remain in the schema for forward compatibility.

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

---

## Stage P: Protocol Swap Pipeline

Failure modes for the protocol-level batch entrypoint (blueprint 02 §"Protocol Swap Pipeline", v1: Uniswap V2). Module references P1–P5 correspond to the module labels in blueprint 02.

### EC-P1.1: Dune returns bytes columns with ambiguous encoding

| | |
|---|---|
| **Trigger** | `ethereum.transactions.to` / `.hash` / `.data` columns are VARBINARY; DuneSQL result JSON encodes them inconsistently across result versions (sometimes `"0x..."`, sometimes raw hex without prefix) |
| **Detection** | Post-query mapping step in `queryProtocolTxsWithMempool()` |
| **Resolution** | `normalizeBytesField()` in `lib/data-sources/dune.ts` — accepts either form and returns a lowercase `"0x..."` string |
| **User sees** | Nothing — handled transparently |
| **Logging** | None (silent normalization) |

### EC-P1.2: Dune returns numeric columns in scientific notation

| | |
|---|---|
| **Trigger** | Large `tx.value` or `tx.gas_price` values get serialized by DuneSQL as JSON numbers or scientific-notation strings |
| **Detection** | Mapping step, `toDecimalString()` |
| **Resolution** | `toDecimalString()` attempts `BigInt(s)`, falls back to integer part before the decimal separator, falls back to `"0"` on parse failure |
| **User sees** | Nothing — handled transparently |
| **Logging** | None |

### EC-P1.3: Dune protocol query timeout

| | |
|---|---|
| **Trigger** | Query polling hits 600s cap without `QUERY_STATE_COMPLETED` |
| **Detection** | Poll loop exits with `firstPage == null` |
| **Resolution** | Throw `Error("Dune protocol query timeout after 600 seconds")` — surfaces as `status: "error"` on the `ProtocolAnalysisRun` row via the `runProtocolAnalysis()` catch block |
| **User sees** | Run row marked `error` with the timeout message |
| **Logging** | `[protocol:{runId}] FAILED: Dune protocol query timeout after 600 seconds` |
| **Note** | Raised from 240s → 600s on 2026-04-15 after observing `QUERY_STATE_EXECUTING` at the 240s mark on a partition-pruned 1-day query. Partition pruning (EC-P1.8) dropped the typical runtime to < 60s but the first run per TTL window can still hit 3–5 minutes while Dune warms partition metadata |

### EC-P1.4: Dune mempool-block lookup via blocks table is error-prone

| | |
|---|---|
| **Trigger** | Earlier approach joined `ethereum.blocks` with a 13-second window to resolve `mempool_block_number` from `timestamp_ms`. The 13s window against 12s blocks matched 1–2 blocks per tx, duplicating rows on joins, and also forced an extra table scan per query |
| **Detection** | Prevented by query shape |
| **Resolution** | `queryProtocolTxsWithMempool()` no longer touches `ethereum.blocks`. Instead it derives `mempool_block_number` in pure arithmetic: `tx.block_number - CAST(ceil(inclusion_delay_ms / 12000.0) AS integer)`. Post-merge Ethereum uses fixed 12s slots, so the derivation is accurate to ±1 block. For the gap-analysis use case (simulating at the "block active when the tx arrived in the mempool") a ±1 block error is within simulation noise. Zero duplicate-row risk because no additional join exists |
| **User sees** | Nothing — handled transparently |
| **Logging** | None |
| **Status** | **RESOLVED** (2026-04-14) |

### EC-P1.5: Failed transactions included in the protocol tx list

| | |
|---|---|
| **Trigger** | `ethereum.transactions` includes reverted txs — we don't want to waste Tenderly sims on them |
| **Detection** | The `success` boolean column on `ethereum.transactions` is filtered in the Dune WHERE clause |
| **Resolution** | `queryProtocolTxsWithMempool()` adds `AND tx.success = true` to the WHERE clause. Reverted router calls never leave Dune, so they never reach the decoder or simulator |
| **User sees** | Nothing — reverts are silently excluded from `txsDiscovered` |
| **Logging** | None |
| **Status** | **RESOLVED** (2026-04-14) |

### EC-P1.6: Dune results endpoint paginates large result sets

| | |
|---|---|
| **Trigger** | The `/execution/{id}/results` endpoint returns at most one page of rows per request. Result sets larger than the default page size are served via `next_uri` / `next_offset` pagination |
| **Detection** | Response body contains a `next_uri` field when more rows are available |
| **Resolution** | `queryProtocolTxsWithMempool()` follows `next_uri` in a loop until it is absent, concatenating each page's `result.rows` into a single array before returning. Uses `is_execution_finished` (docs-specified) to detect terminal state rather than matching state strings |
| **User sees** | Nothing — transparent to caller |
| **Logging** | `[dune] Protocol pagination: {n} rows so far` every ~1000 rows |
| **Note** | At `PROTOCOL_ANALYSIS_TX_LIMIT = 200` pagination never triggers. It kicks in around `limit: 1000+` depending on Dune's current default page size |

### EC-P1.7: Dune error body is an object, not a string

| | |
|---|---|
| **Trigger** | When `state` is `QUERY_STATE_FAILED` / `CANCELED` / `EXPIRED`, the `error` field on the response is a structured object with a `message` field (per Dune docs), not a plain string |
| **Detection** | Polling loop in `queryProtocolTxsWithMempool()` inspects `data.error` on terminal failure |
| **Resolution** | Extract `error.message` when the field is an object, fall back to `JSON.stringify(error)`, then to `"unknown error"`. Never passes `[object Object]` into the thrown message |
| **User sees** | Meaningful error message on the `ProtocolAnalysisRun.error` column |
| **Logging** | Error surfaces via `[protocol:{runId}] FAILED: ...` |

### EC-P1.8: `ethereum.transactions` full-scan without partition filter

| | |
|---|---|
| **Trigger** | Earlier query only filtered on `tx.block_time >= CURRENT_TIMESTAMP - INTERVAL '1' DAY`. `block_time` is not the partition key on `ethereum.transactions`, so DuneSQL scanned the entire table before applying the filter, blowing through the 240s poll cap while still in `QUERY_STATE_EXECUTING` |
| **Detection** | Observed on 2026-04-15 — poll #120 at state `QUERY_STATE_EXECUTING finished=false`, thrown as timeout by EC-P1.3 |
| **Resolution** | Added `AND tx.block_date >= CURRENT_DATE - INTERVAL '{days}' DAY` to the WHERE clause. `block_date` is the partition key (per `ethereum.transactions` docs), so this restricts the scan to 1–2 daily partitions. The `block_time` filter is kept as the precise boundary — prune first via `block_date`, then filter the partition contents via `block_time`. Typical runtime dropped from > 10 min to < 60s |
| **User sees** | Query completes within poll window |
| **Logging** | `[dune] Protocol query complete, N rows total` (usually visible within the first few poll cycles) |
| **Note** | Also justifies the 600s poll cap (EC-P1.3 update) — first run per TTL can still take 3–5 minutes while Dune warms partition metadata |

### EC-P2.1: Unknown selector (non-swap call to Router02)

| | |
|---|---|
| **Trigger** | Tx is sent to Router02 but calldata selector is not one of the 9 supported swap methods (e.g. `addLiquidity`, `removeLiquidity`, `quote`) |
| **Detection** | `decodeUniV2Swap()` returns `null` on selector miss |
| **Resolution** | Tx is dropped silently from the decoded set. Counts toward `txsDiscovered` but not `txsDecoded`, so the rate is observable via the run row |
| **User sees** | Nothing — tx is absent from the run's `ProtocolSwapAnalysis` rows |
| **Logging** | None (expected path — most Router02 traffic is swaps but not all) |

### EC-P2.2: Malformed calldata

| | |
|---|---|
| **Trigger** | Truncated or corrupted calldata: bad `path_offset`, path length 0 or > 10, slot of wrong size |
| **Detection** | `decodeUniV2Swap()` — returns `null` on length mismatch, out-of-range path length, or BigInt parse failure |
| **Resolution** | Tx dropped from the decoded set; counted like EC-P2.1 |
| **User sees** | Nothing |
| **Logging** | `[univ2-decoder] Failed to decode {txHash}: {error message}` |

### EC-P2.3: `ethIn`/`ethOut` method with `path[0]`/`path[last]` not WETH

| | |
|---|---|
| **Trigger** | Caller passed a non-WETH address in the ETH slot of the path — extremely rare, would fail in the router anyway |
| **Detection** | `decodeUniV2Swap()` path-vs-method sanity check |
| **Resolution** | **Warn only.** The decoded output still collapses the user-facing side to the zero-address pseudo-token (HR-9). Let the simulation be the ground truth |
| **User sees** | Nothing — swap is still analyzed |
| **Logging** | `[univ2-decoder] {txHash}: ethIn method but path[0]={addr} != WETH` (or `ethOut`/`path[last]`) |

### EC-P2.4: `deadline` parameter present in calldata but not decoded

| | |
|---|---|
| **Trigger** | All 9 swap methods have a `deadline` param in their ABI |
| **Detection** | N/A — this is a deliberate design choice, not a failure |
| **Resolution** | **Not extracted.** `deadline` is a user-chosen upper bound on inclusion time, not a signing timestamp. Signing time is inferred from `flashbots.dataset_mempool_dumpster.timestamp_ms` (per Stage 3 / EC-3.1). Extracting `deadline` would invite future misuse as a signing-time proxy |
| **User sees** | Nothing |
| **Logging** | None |

### EC-P3.1: `evaluateSwap()` throws mid-run

| | |
|---|---|
| **Trigger** | Unexpected error inside `evaluateSwap()` (network blip, Tenderly auth failure, etc.) |
| **Detection** | Try/catch in the `runProtocolAnalysis()` main loop |
| **Resolution** | Emit a `ProtocolSwapResult` with `simulationStatus: "skipped"` and `error: {message}`, persisted alongside successful rows. Run continues |
| **User sees** | Skipped swap visible as a row with zero gap and an error message |
| **Logging** | `[protocol:{runId}] evaluateSwap failed for {txHash}: {error message}` |

### EC-P3.2: Both simulations return null

| | |
|---|---|
| **Trigger** | Tenderly returns null for both mempool-block and inclusion-block sims (e.g. tx reverts at both blocks, Tenderly outage mid-tx) |
| **Detection** | `extractOutflow()` / `extractInflow()` both return `null` on each sim |
| **Resolution** | `simulationStatus: "both_failed"`, `error: "both simulations failed"`, all amount/gap fields zeroed. Row persisted for audit |
| **User sees** | Swap visible but with zero gap; appears in `txsDiscovered`/`txsDecoded` but NOT in `txsSimulated` |
| **Logging** | Captured at Tenderly module level |

### EC-P3.3: Tx absent from mempool dumpster (private relay)

| | |
|---|---|
| **Trigger** | Tx was submitted via Flashbots / private relay / was too old for Dune's dumpster window |
| **Detection** | `mempoolTimestampMs` / `mempoolBlockNumber` are null in the Dune row (LEFT JOIN with `flashbots.dataset_mempool_dumpster`) |
| **Resolution** | Fall back to `mempoolBlockNumber = inclusionBlockNumber - 1`. `isEstimated = true` flag is persisted on the swap row so downstream consumers can filter |
| **User sees** | Swap is analyzed, marked estimated; results may be slightly less accurate |
| **Logging** | None (LEFT JOIN is the documented path) |
| **Note** | Analogous to EC-3.1 for the per-wallet pipeline |

### EC-P3.5: Unclassified token flows bucket-collide with native ETH

| | |
|---|---|
| **Trigger** | Superseded by EC-P3.7. The symptom was real (all gaps coming out zero) but the diagnosis was wrong — the root cause was that the entire `asset_changes` interface in the codebase did not match what Tenderly actually returns, not a "honeypot" bucket collision |
| **Detection** | Observed on 2026-04-15 in smoke run `cmnz7hti50000h7cudy2q083j` |
| **Resolution** | First attempted fix (tightening the native-ETH branch to `type === "NATIVE"`) made the bug more honest but didn't address the root cause — see EC-P3.7 for the correct fix |
| **Status** | **SUPERSEDED** by EC-P3.7 (2026-04-15) |

### EC-P3.7: `SimulationResult` interface did not match real Tenderly shape

| | |
|---|---|
| **Trigger** | The `SimulationResult` type (and the inline `changes` shapes on `computeNetTokenFlows`, `getTokenOutputFromChanges`, `extractAssetChanges`) were entirely fictional. Tenderly's v1 `simulate` endpoint with `simulation_type: "full"` returns a shape where (a) `token_info.address` does not exist — the real field is `token_info.contract_address`, (b) the top-level `type` is `"Mint"` / `"Transfer"` / `"Burn"` (event-level), NOT a token standard, (c) the token standard lives at `token_info.standard` with values `"ERC20"` / `"NativeCurrency"` / etc., (d) `amount` is a human-readable decimal string (e.g. `"0.1376"`), NOT a BigInt-parseable wei value — the wei string is in `raw_amount` |
| **Detection** | Smoke run `cmnz82m4d0000zh11udt68sv5` on 2026-04-15 produced `discovered=53 decoded=53 simulated=53 withGap=0 totalGapUsd=0.00` with `[tenderly] Net flows: 0 positive, 0 negative, 0 zero` on every tx. Inspecting `TenderlySimulationRaw.simulationResult` revealed the real shape — `token_info.contract_address`, `token_info.standard`, `raw_amount` — completely different from what `lib/types.ts::SimulationResult` declared |
| **Resolution** | 2026-04-15 rewrite of `lib/types.ts::SimulationResult` and `lib/data-sources/tenderly.ts::computeNetTokenFlows()` to use the real shape: (1) new `TenderlyAssetChange` type in `lib/types.ts` matching the observed fields; (2) discrimination via `token_info.standard` (`"NativeCurrency"` → zero-address ETH bucket, `"ERC20"` with `contract_address` → ERC-20 bucket, everything else logged and dropped); (3) BigInt amounts parsed from `raw_amount` with defensive fallback to the truncated decimal `amount`; (4) `Mint` events handled correctly (no `from`). `extractAssetChanges` and `getTokenOutputFromChanges` signatures updated to use `TenderlyAssetChange[]` for consistency. HR-9 in `CLAUDE.md` rewritten to describe the real shape explicitly and call out the old-code symptoms |
| **User sees** | First time raw amounts are non-zero end-to-end. Gaps become meaningful. The wallet pipeline also produces correct net flows for the first time — a dormant regression that existed since the asset-extraction rewrite (HR-4) and was never caught because the per-wallet flow's end-to-end "looked reasonable" to users who never cross-checked raw amounts |
| **Logging** | Per-change log line now shows `raw=<BigInt>` instead of the decimal `amount`. Drop-fall-through logs `[tenderly]   SKIP: standard=... type=... contract=... symbol=... amount=...` so mis-classified entries can be observed empirically |
| **Status** | **RESOLVED** (2026-04-15). Needs re-validation run to confirm non-zero gaps on real data |
| **Note** | This is a **cross-pipeline** fix — the wallet flow and the protocol flow share `computeNetTokenFlows`. Wallet-pipeline USD numbers produced before 2026-04-15 should be considered unreliable. Re-running existing wallet analyses is not mandatory but highly recommended |

### EC-P3.6: Mempool-dumpster hit rate unknown on larger samples

| | |
|---|---|
| **Trigger** | 5/5 txs in the 2026-04-15 smoke run (`windowDays=1`, `limit=5`) came back with `mempoolBlockNumber = null` (no matching row in `dune.flashbots.dataset_mempool_dumpster`), forcing the `isEstimated: true` fallback for every tx |
| **Detection** | `ProtocolSwapAnalysis.isEstimated = true` on every row of the smoke run |
| **Resolution** | **Open.** A 5-tx random slice is not statistically meaningful — legitimate for a smoke test, but needs a dedicated check at `limit=200 windowDays=1` to measure the actual dumpster hit rate on Uniswap V2 Router02 txs. If the rate is >= 50%, the `isEstimated` fallback is a reasonable edge case. If it's < 50%, `isEstimated` becomes the default and the "mempool-arrival-time proxy" premise of the protocol pipeline is degraded — we'd need to either (a) switch mempool source, (b) limit runs to txs present in the dumpster, or (c) document the accuracy loss prominently in the UI |
| **User sees** | On the current (buggy?) hit rate: all gaps are computed relative to `inclusion - 1` rather than real mempool-arrival, inflating apparent slippage numbers |
| **Logging** | None yet — worth adding `estimatedCount / decodedCount` to the run summary line |
| **Status** | **OPEN** — pending limit=200 measurement run |

### EC-P3.4: Token decimals fall back to 18 when neither sim touched the token

| | |
|---|---|
| **Trigger** | Exotic routing where the user's wallet never appears as `from`/`to` on the decoded `tokenIn` or `tokenOut` in either simulation's `asset_changes` |
| **Detection** | `firstTouched()` returns undefined; the zero-flow placeholder's default `decimals: 18` is used |
| **Resolution** | Placeholder defaults to 18. **Under the v1.4 gap-computability gate (EC-P4.3) this case now produces `totalGapUsd = 0` because the mempool and/or inclusion sim both emit only placeholder flows for the target tokens. The wrong-decimals outcome is no longer possible to reach a USD field — it can still show up in raw amounts, which are audit-only.** |
| **User sees** | Swap visible with raw amounts but `totalGapUsd = 0`, excluded from run aggregates |
| **Logging** | None |
| **Status** | **RESOLVED (indirectly) by v1.4 gap-computability gate** — on-chain `decimals()` lookup is still a nice-to-have for UI display of raw amounts, but no longer pollutes USD math |

### EC-P4.1: Positive slippage (user received MORE / paid LESS than predicted) — v1.4

| | |
|---|---|
| **Trigger** | Favorable slippage: actual execution was better than the mempool-block simulation |
| **Detection** | `priceProtocolSwaps()` — sign is preserved rather than clamped |
| **Resolution** | Under v1.4 sign convention, positive slippage appears as a **positive** `totalGapUsd` on the per-swap row (the user gained USD relative to sim). Aggregate `totalGapUsd` on the run is signed: it's the net of all priced gains and losses on computable swaps. UI renders positive values in green as "positive slippage" |
| **User sees** | Some swaps show positive USD total; top-of-page run summary may show either `+$X net gain` or `−$X net loss` depending on the sample |
| **Logging** | None |
| **Note** | Analogous to EC-5.4 in the per-wallet pipeline. **v1.3 stored the opposite sign** — loss was positive — and the v1.4 migration negated all existing `amountInGapUsd / amountOutGapUsd / totalGapUsd / topLossUsd` values. Any tooling that queries those fields directly must assume the v1.4 convention from 2026-04-15 onward. |

### EC-P4.3: Gap math applied to one-sided sim data produced entire-trade-size "gaps" (v1.4 fix)

| | |
|---|---|
| **Trigger** | Two overlapping cases: (a) `simulationStatus = "mempool_failed"` or `"inclusion_failed"`, where HR-5 substitutes `BigInt(0)` for the missing side and the pipeline then computes `actual − 0 = full trade notional` instead of a delta; (b) `simulationStatus = "ok"` but the target tokens never appeared in either sim's `asset_changes` (EC-P3.4), so `firstTouched()` returns undefined and both sides fall back to placeholder zeros |
| **Detection** | Smoke audit 2026-04-15 on `cmnz9kfz*` runs: 119 `mempool_failed` rows contributed ~$1,406 of bogus gap and 3 `ok`-with-placeholder rows contributed smaller noise. Pattern: `expectedAmountInRaw = "0" AND expectedAmountOutRaw = "0" AND (actualAmountInRaw != "0" OR actualAmountOutRaw != "0")`, with a symmetric variant for `inclusion_failed` |
| **Resolution** | `priceProtocolSwaps()` (v1.4) adds a **gap-computability gate**: a row is only USD-priceable when `simulationStatus == "ok"` AND both sides of both sims have at least one real (non-placeholder, non-zero) flow for a target token. When the gate fails, raw amounts are preserved but `amountInGapUsd / amountOutGapUsd / totalGapUsd` are set to `0`. Run-level `totalGapUsd` aggregation excludes these rows. HR-5 is unchanged — it still applies to the intermediate `amount*GapRaw` computation — but the USD layer no longer trusts the raw fields of non-computable rows |
| **User sees** | Previously misleading rows disappear from the run total and are flagged (simulation incomplete) in the UI. The legitimate loss/gain signal is no longer drowned out by trade-notional noise |
| **Logging** | `[pricer] {n}/{m} swaps gap-computable; {n_non} non-computable excluded from USD aggregate` |
| **Status** | **RESOLVED (v1.4, 2026-04-15)** — one-shot backfill ran on existing rows: zeroed the USD fields on all non-computable rows, negated signs on all remaining rows, recomputed `ProtocolAnalysisRun.totalGapUsd / topLossUsd` from the cleaned per-swap data |
| **Note** | The underlying sim-failure cases (P3.2 / P3.3 / P3.4) are all upstream causes. The gate is a defensive boundary at the USD layer, not a replacement for fixing any one of those |

### EC-P4.2: DeFiLlama has no price for one or both swap tokens

| | |
|---|---|
| **Trigger** | Long-tail / scam / freshly deployed token not indexed by DeFiLlama |
| **Detection** | `resolvePrices()` returns a Map without that address |
| **Resolution** | Token is marked "unpriced" (`tokenInPriceUsd`/`tokenOutPriceUsd = null`). That side of the gap is recorded as USD 0, the other side is still priced normally. `totalGapUsd` reflects the priced side only |
| **User sees** | Swap appears with a partial or zero USD total even though `amount*GapRaw` is non-zero — raw values remain available for audit |
| **Logging** | `[pricer] {n} of {m} tokens have no DeFiLlama price` |

### EC-P5.1: `inclusionBlockTime` unparseable by JS `Date`

| | |
|---|---|
| **Trigger** | DuneSQL returns the timestamp in an unexpected string format across result-version changes |
| **Detection** | `saveProtocolSwaps()` calls `new Date(s.inclusionBlockTime)` — an invalid input yields `Invalid Date`, which Prisma either rejects or persists as null |
| **Resolution** | Guard with `Date.parse()` before constructing the `Date`; on parse failure log a warning and substitute `new Date()` (fetch-time) so the row still persists. Dune normalizer in `queryProtocolTxsWithMempool()` should ideally emit an ISO8601 string |
| **User sees** | Swap row persisted with approximately-correct timestamp if Dune changes its format |
| **Logging** | `[db] inclusionBlockTime unparseable for {txHash}: {raw value}` |

### EC-P5.2: Large `saveProtocolSwaps()` batch overloads SQLite

| | |
|---|---|
| **Trigger** | `Promise.all(swaps.map(upsert))` on a 5000-row batch |
| **Detection** | Not auto-detected — observable as slow writes or `SQLITE_BUSY` under load |
| **Resolution** | Wrap in `prisma.$transaction([...upserts])` or chunk to e.g. 200 rows per batch |
| **User sees** | Longer run completion time |
| **Logging** | None |
| **Status** | **OPEN ADVISORY** — addressed when scaling beyond `limit: 1000` |
