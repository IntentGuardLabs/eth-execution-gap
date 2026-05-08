# Blueprint Accuracy Review — 2026-04-11

> **Scope**: Review all blueprints in `blueprints/` for accuracy against the actual codebase. Classify: blueprint correct, or blueprint needs update.
>
> **Reviewer**: Code Review Agent (per `.claude/agents/review.md`)

---

## Summary

| Blueprint | Findings |
|-----------|----------|
| 01-pipeline-orchestration.md | 1 WRONG, 1 VAGUE |
| 02-data-contracts.md | 2 WRONG, 1 VAGUE |
| 03-api-contracts/etherscan.md | 1 VAGUE |
| 03-api-contracts/tenderly.md | 1 STALE |
| 03-api-contracts/dune.md | 0 |
| 03-api-contracts/defillama.md | 0 |
| 04-edge-cases.md | 2 MISSING |
| 05-database-schema.md | 0 |
| 06-ui-states.md | 1 WRONG, 1 MISSING |

**Total: 3 WRONG, 2 VAGUE, 1 STALE, 2 MISSING = 8 findings**

---

## Blueprint 01: Pipeline Orchestration

### [BLUEPRINT-WRONG] Retry total wait times are overstated

- **Blueprint**: `blueprints/01-pipeline-orchestration.md` lines 182-187, Retry Strategy table
- **Code**: `lib/utils.ts:retryWithBackoff()` lines 141-161
- **What blueprint says**:
  - Etherscan: Max Retries 3, Total Wait "up to 1s + 2s + 4s = 7s"
  - Dune: Max Retries 2, Total Wait "up to 2s + 4s = 6s"
  - Tenderly: Max Retries 2, Total Wait "up to 2s + 4s = 6s"
- **What code does**: `retryWithBackoff(fn, maxRetries, initialDelayMs)` loops `maxRetries` times total (not `maxRetries` retries *after* the first attempt). Delays occur between iterations `i` and `i+1` only when `i < maxRetries - 1`. So:
  - Etherscan (maxRetries=3, 1000ms): 3 total attempts, delays at i=0 (1s) and i=1 (2s) = **3s max**, not 7s
  - Dune (maxRetries=2, 2000ms): 2 total attempts, delay at i=0 (2s) = **2s max**, not 6s
  - Tenderly (maxRetries=2, 2000ms): 2 total attempts, delay at i=0 (2s) = **2s max**, not 6s
- **Root cause**: Blueprint confuses "maxRetries" (total attempts) with "retries after first call"
- **Severity**: advisory — latency estimates in the blueprint overstate actual retry windows by 2-3x

### [BLUEPRINT-VAGUE] Etherscan timeout inconsistency not documented

- **Blueprint**: `blueprints/01-pipeline-orchestration.md` line 67 says "Retried: 3 retries, 1s initial backoff" for Step 1
- **Code**: `lib/data-sources/etherscan.ts`
  - `getLatestBlockNumber()` line 22: `timeout: 10000` (10s)
  - `fetchWalletTransactions()` line 99: `timeout: 15000` (15s)
- **Issue**: Blueprint doesn't distinguish these two timeout values. The Etherscan API contract (`03-api-contracts/etherscan.md`) only mentions 15s.
- **Severity**: advisory

---

## Blueprint 02: Data Contracts

### [BLUEPRINT-WRONG] MempoolData.mempool_block_time type mismatch

- **Blueprint**: `blueprints/02-data-contracts.md` line 119 says `mempool_block_time: number`
- **Code**: `lib/types.ts` line 27: `mempool_block_time: number`
- **Actual Dune data**: `blueprints/03-api-contracts/dune.md` line 98 shows `"mempool_block_time": "2025-04-05 12:34:56"` (string)
- **Code at**: `lib/data-sources/dune.ts` line 120: `mempool_block_time: row.mempool_block_time` — stores whatever Dune returns
- **Impact**: Low — the field is never used downstream (pipeline only reads `mempool_block_number`), but the TypeScript type is wrong. The data contract and the API contract contradict each other.
- **Severity**: advisory

### [BLUEPRINT-WRONG] Results API hardcodes windowDays instead of using constant

- **Blueprint**: `blueprints/02-data-contracts.md` line 274 says `windowDays: number` and "ANALYSIS_WINDOW_DAYS (30)"
- **Code**: `app/api/results/[address]/route.ts` line 42: `const windowDays = 30;` — hardcoded, does NOT import `ANALYSIS_WINDOW_DAYS` from `lib/constants.ts`
- **Impact**: If `ANALYSIS_WINDOW_DAYS` changes, the results API will serve stale `windowDays` and compute wrong `annualizedLossUsd`.
- **Blueprint fix needed**: Document that the results route hardcodes 30 rather than referencing the shared constant.
- **Severity**: advisory (but a latent bug if the constant ever changes)

### [BLUEPRINT-VAGUE] Module 6 doesn't mention hardcoded decimals

- **Blueprint**: `blueprints/02-data-contracts.md` lines 256-262, Module 6 USD conversion
- **Code**: `lib/analysis/calculator.ts` line 139: `gapToUsd(result.gapRaw, price, 18 // Default ERC20 decimals)`
- **Issue**: The data contract shows the safe division formula but doesn't mention that `decimals` is hardcoded to 18 for ALL tokens. This critical detail only appears in `04-edge-cases.md` EC-6b.1. Someone reading the data contract alone would assume per-token decimals.
- **Severity**: advisory (documented elsewhere, but the contract is misleading in isolation)

---

## Blueprint 03: API Contracts

### [BLUEPRINT-VAGUE] Etherscan timeout differences not documented

- **Blueprint**: `blueprints/03-api-contracts/etherscan.md` line 145 says "axios timeout (15s)"
- **Code**: `getLatestBlockNumber()` uses 10s timeout, `fetchWalletTransactions()` uses 15s, `fetchWalletERC20Transfers()` uses 10s, `getTransactionReceipt()` uses 10s
- **Issue**: Blueprint lists a single 15s timeout, but 3 of 4 endpoints use 10s.
- **Severity**: advisory

### [BLUEPRINT-STALE] Tenderly net flow section omits native ETH (HR-9)

- **Blueprint**: `blueprints/03-api-contracts/tenderly.md` lines 116-121, "Net flow computation (HR-4)" section
- **What blueprint says**: "For each ERC20 change where token_info exists: inflow/outflow"
- **What code does**: `lib/data-sources/tenderly.ts:computeNetTokenFlows()` at lines 170-183 handles BOTH ERC-20 (`change.type === "ERC20"`) AND native ETH (entries where `!change.token_info?.address`), per HR-9
- **Issue**: The HR-9 fix added native ETH handling to the code and to `02-data-contracts.md` (Module 4b), but the Tenderly API contract's net flow description was not updated. It still only describes ERC-20 processing.
- **Severity**: advisory — the behavior IS documented in Blueprint 02 Module 4b and EC-4b.1, but this blueprint is internally stale

---

## Blueprint 04: Edge Cases

### [BLUEPRINT-MISSING] Dune LEFT JOIN null fallback not documented

- **Code**: `lib/data-sources/dune.ts` line 119: `mempool_block_number: row.mempool_block_number || row.included_at_block_height - 1`
- **Issue**: When Dune's LEFT JOIN on `ethereum.blocks` returns NULL for `mempool_block_number` (e.g., block data pruned, timing edge case where no block matches the 13s window), the code falls back to `included_at_block_height - 1` inline. This is distinct from EC-3.1 (tx not in mempool dumpster at all) — here the tx IS in the dumpster but the block lookup fails.
- **Proposed edge case**: EC-3.6: Dune mempool block JOIN returns null
  - Trigger: Tx found in mempool dumpster but no ethereum.blocks row matches the 13s time window
  - Detection: `row.mempool_block_number` is null/undefined
  - Resolution: Falls back to `included_at_block_height - 1` (same as EC-3.1 fallback)
  - Not flagged as `isEstimated` — the pipeline only checks `!mempoolData` for that flag
- **Severity**: advisory

### [BLUEPRINT-MISSING] `bigIntToDecimal()` in utils.ts violates HR-6 pattern

- **Code**: `lib/utils.ts` lines 105-108:
  ```typescript
  export function bigIntToDecimal(value: bigint, decimals: number): number {
    const divisor = BigInt(10 ** decimals);
    return Number(value) / Number(divisor);
  }
  ```
- **Issue**: This function uses exactly the pattern HR-6 forbids: `Number(bigint) / Number(bigint)`. It is currently unused in the pipeline (the pipeline uses `gapToUsd()` which follows the safe pattern), but its existence as a public utility is a trap for future callers.
- **Not in edge cases or dead code section**: Should be added to EC-DC as dead code with an HR-6 warning.
- **Severity**: advisory

---

## Blueprint 05: Database Schema

**No findings.** Schema in `prisma/schema.prisma` matches the blueprint exactly:
- All 6 models match (fields, types, constraints, defaults)
- All indexes match
- All relations and cascade behaviors match
- Query patterns in `lib/db.ts` match documented patterns
- Non-idempotent raw storage (`create` vs `upsert`) correctly documented

---

## Blueprint 06: UI States

### [BLUEPRINT-WRONG] Results page loading checklist steps differ from blueprint

- **Blueprint**: `blueprints/06-ui-states.md` lines 130-137, State 2.1 checklist:
  1. Fetching transactions
  2. Filtering transactions
  3. Querying mempool
  4. Simulating transactions
  5. Calculating losses
  6. Complete
- **Code**: `app/results/[address]/page.tsx` lines 115-122:
  1. `pending` → "Preparing analysis"
  2. `fetching_txs` → "Fetching transactions (30d)"
  3. `filtering` → "Filtering out no-gap txs"
  4. `querying_mempool` → "Querying mempool data"
  5. `simulating` → "Simulating transactions"
  6. `calculating` → "Calculating losses"
- **Differences**: Code starts with "Preparing analysis" (pending state) as step 1 and has NO "Complete" step. Blueprint starts with "Fetching transactions" and ends with "Complete". Both have 6 items but different content.
- **Severity**: advisory

### [BLUEPRINT-MISSING] Landing page "Last hit" column not documented

- **Code**: `app/page.tsx` lines 291 and 343-344
  - Header: `<span>Last hit</span>`
  - Data: `{i < 3 ? `${i + 2}h ago` : `${i + 1}d ago`}` — fabricated values based on row index
- **Issue**: The landing page leaderboard has 6 columns (Rank, Wallet, Total Loss, Sandwiches, Slippage, Last hit), but Blueprint 06 only documents 4 (Rank, Address, Total Loss, Sandwiched count). Neither the "Slippage" column (documented elsewhere as fabricated) nor the "Last hit" column (entirely fabricated) are mentioned in the State 1.2 description of the landing page leaderboard.
- **Severity**: advisory — the "Last hit" column shows completely fabricated data with no API backing

---

## Verified Correct (Spot Checks)

These items were verified and found to match between blueprints and code:

- HR-1: Tenderly hex conversion via `toHex()` — `tenderly.ts:15-21` ✓
- HR-2: Simulation gas limit 8,000,000 — `tenderly.ts:10` ✓
- HR-3: All 7 required selectors present in filter + 7 additional — `filter.ts:7-32` ✓
- HR-4: Net flow computation with per-token aggregation — `tenderly.ts:148-211` ✓
- HR-5: One-sided delta handling, missing side treated as 0 — `pipeline.ts:174-182` ✓
- HR-6: Safe BigInt division in `gapToUsd()` — `calculator.ts:83-88` ✓
- HR-7: DeFiLlama pricing, no CoinGecko — `calculator.ts:37` ✓
- HR-9: Native ETH tracking in `computeNetTokenFlows()` — `tenderly.ts:175-179` ✓
- EC-DC.1: Sandwich detection imported but uncalled — `pipeline.ts:5` imported, never invoked ✓
- EC-DC.3: `isTransactionAnalyzed` defined in `db.ts:215` but never called ✓
- EC-DC.4: RateLimiter queue is dead code — `rate-limiter.ts:16` never populated ✓
- Pipeline concurrency model: single-job queue, FIFO — `job-queue.ts` ✓
- All Prisma models match schema.prisma exactly ✓
- DeFiLlama chunk size 80, ETH key `coingecko:ethereum` ✓
- Dune SQL query structure, polling 2s/60 max, `performance: "medium"` ✓
- Status messages in constants.ts match blueprint ✓
- No-jobId results page bug confirmed in code ✓
- Fabricated slippage column (0.28 multiplier) confirmed in both leaderboards ✓
- Decorative time period buttons confirmed ✓
- Share card SVG with `Cache-Control: public, max-age=3600` confirmed ✓
