@AGENTS.md

# CLAUDE.md — DeFi Execution Gap Analyzer

## Project Summary

A Next.js server-rendered application that calculates how much value an Ethereum wallet lost due to the gap between transaction simulation (at mempool arrival time) and actual execution (at block inclusion time). Captures aggregate impact of MEV, price drift, and protocol state changes across a configurable analysis window (default: `ANALYSIS_WINDOW_DAYS` in `constants.ts`).

**Product context**: Top-of-funnel growth lever for IntentGuard (MEV protection). Users paste a wallet, see their losses, get nudged to enable protection.

---

## Before You Do Anything

1. Read `AGENTS.md` — Next.js 16 has breaking changes from what you know.
2. Read `ARCHITECTURE.md` in the project root — repo structure, blueprint governance, how pieces connect.
3. Read `blueprints/README.md` for the blueprint index.
4. Read the blueprints relevant to your task:
   - **Pipeline module work** → `02-data-contracts.md` → `03-api-contracts/{service}.md` → `04-edge-cases.md` → `05-database-schema.md`
   - **UI work** → `06-ui-states.md` → `02-data-contracts.md`
   - **Debugging** → `04-edge-cases.md` → relevant `03-api-contracts/` file
5. Run `npx tsc --noEmit` before and after your changes.

---

## Tech Stack (actual)

| Layer | Technology | Notes |
|-------|-----------|-------|
| Framework | Next.js 16 (App Router) | TypeScript, server-side API routes |
| Database | SQLite + Prisma ORM | Stores raw API responses + analysis results |
| Styling | Tailwind CSS v4 | Plus inline styles on landing page |
| Charts | Recharts | For results visualization |
| Deployment | Docker / Docker Compose | SQLite file at `./data/dev.db` |

**This is NOT a browser-only SPA.** Pipeline runs server-side in API routes. API keys live in `.env`, never in the browser.

Do NOT propose migrating to plain JS, browser-only SPA, IndexedDB, or localStorage. This architecture is intentional.

---

## Project Structure

```
app/
  api/
    analyze/route.ts          # POST — triggers analysis job
    status/[jobId]/route.ts   # GET  — polls job progress
    results/[address]/route.ts # GET  — returns completed analysis
    leaderboard/route.ts      # GET  — wall of shame (paginated)
    share/[address]/route.ts  # GET  — OG image for social sharing
  page.tsx                    # Landing page (wallet input + leaderboard)
  results/[address]/page.tsx  # Results dashboard
  wall-of-shame/page.tsx      # Full leaderboard page
  layout.tsx                  # Root layout

lib/
  analysis/
    pipeline.ts               # Orchestrator — runs the full analysis
    filter.ts                 # Blacklist filter: excludes no-gap txs
    sandwich.ts               # Sandwich attack detection
    calculator.ts             # DeFiLlama pricing + USD gap calculation
  data-sources/
    etherscan.ts              # Tx history fetcher (paginated, rate-limited)
    dune.ts                   # Mempool timestamp resolver (Flashbots data)
    tenderly.ts               # Transaction simulator + net flow extraction
  db.ts                       # Prisma queries (jobs, wallets, raw storage)
  job-queue.ts                # In-memory job queue (single concurrency)
  rate-limiter.ts             # Generic per-second + concurrent rate limiter
  constants.ts                # Analysis window, block time, DEX routers, rate limits
  types.ts                    # All TypeScript interfaces
  utils.ts                    # Address validation, formatting, retry, sleep

prisma/
  schema.prisma               # 6 models: WalletAnalysis, TransactionAnalysis,
                              #   EtherscanTxRaw, DuneMempoolRaw,
                              #   TenderlySimulationRaw, AnalysisJob
```

---

## Pipeline Architecture

```
Wallet Address
  |
  v
[1] Etherscan: fetch txs (last ANALYSIS_WINDOW_DAYS, real latest block via eth_blockNumber)
  |
  v
[2] Filter: BLACKLIST approach — exclude known no-gap txs, simulate everything else
  |
  v
[3] Dune: batch SQL on flashbots.dataset_mempool_dumpster → timestamp → block mapping
  |     fallback: inclusion_block - 1 if not in mempool dumpster (flagged isEstimated)
  |
  v
[4] Tenderly: simulate each tx at mempool-arrival block (expected output)
  |           simulate same tx at inclusion block (actual output)
  |           extract NET token flows (inflows - outflows per token)
  |
  v
[5] Delta: expected_net - actual_net per token (missing side = 0, not skip)
  |
  v
[6] DeFiLlama: batch-price all unique tokens, apply to gaps
  |
  v
[7] Store: results + all raw API responses in SQLite via Prisma
  |
  v
[8] Serve: annualized loss, per-tx breakdown, leaderboard ranking
```

All pipeline stages run server-side. Errors are non-fatal — one tx failing does not stop the pipeline. Failed txs are logged and skipped.

---

## Core Rules

### Blueprints Are Law

- Implementations MUST match the data contracts in `blueprints/02-data-contracts.md`.
- If you believe a blueprint is wrong, say so explicitly. Do not silently deviate.
- If you encounter an undocumented edge case, add it to `blueprints/04-edge-cases.md` with a proposed resolution before writing handling code.
- Blueprints are updated BEFORE code changes.

### Cache Everything

- Every external API call MUST check the database cache first.
- Use the `withCache(table, key, ttl, fetchFn)` pattern (to be formalized as a shared utility).
- TTL values are defined in `blueprints/05-database-schema.md`. Do not invent your own.
- Simulations and historical prices are immutable — cache with no expiry.
- Transaction lists are short-lived — re-fetch picks up new activity.

---

## Hardened Rules (from production bugs)

These rules exist because their violations caused real bugs. Do not revisit or "simplify" them.

### HR-1: Tenderly value format is hex

All numeric values sent to Tenderly (`value`, `gas_price`) MUST be `0x`-prefixed hex strings. Use the `toHex()` converter in `tenderly.ts`. Never send decimal strings or plain numbers. A decimal string silently produces wrong simulation results — Tenderly does not error, it just misinterprets the value.

### HR-2: Simulation gas is always 8,000,000

Do not use the original transaction's gas limit for simulations. Complex DeFi interactions need headroom. Hardcoded `SIMULATION_GAS_LIMIT = 8_000_000` in `tenderly.ts`.

### HR-3: Filter blacklist must cover all pure-transfer signatures

The filter that excludes simple txs from simulation MUST include all of these 4-byte selectors:

```
0xa9059cbb  — ERC-20 transfer
0x095ea7b3  — ERC-20 approve
0x23b872dd  — ERC-721 transferFrom
0x42842e0e  — ERC-721 safeTransferFrom (no data)
0xb88d4fde  — ERC-721 safeTransferFrom (with data)
0xf242432a  — ERC-1155 safeTransferFrom
0x2eb2c2d6  — ERC-1155 safeBatchTransferFrom
```

If a new pure-transfer signature is identified, add it to the blacklist in `filter.ts` AND update `blueprints/02-data-contracts.md`.

### HR-4: Asset extraction uses net flows, not first-positive-transfer

When extracting token output from Tenderly `asset_changes`, compute net flows per token:

```
For each token:
  net = sum(inflows to wallet) - sum(outflows from wallet)
Pick the largest net-positive as the swap output.
```

This correctly handles multi-hop swaps, partial fills, and same-token send+receive. The function is `computeNetTokenFlows()` in `tenderly.ts`.

### HR-5: Never skip one-sided deltas

If the simulated side has output but the actual side doesn't (or vice versa), treat the missing side as 0. The delta is `expected - 0 = expected`. Only skip a tx when BOTH sides have no output. One-sided cases are often the worst losses (100% slippage) — silently dropping them hides the most important data.

### HR-6: BigInt division must avoid precision loss

Never do `Number(bigintA) / Number(bigintB)` — this overflows IEEE 754 for amounts > 9e15 (common with 18-decimal tokens). Use:

```typescript
Number(gap / divisor) + Number(gap % divisor) / Number(divisor)
```

Also: `tsconfig.json` targets ES2017 — BigInt literals (`0n`) are not allowed. Use `BigInt(0)`.

### HR-7: DeFiLlama for pricing, not CoinGecko

Use `coins.llama.fi/prices/current/ethereum:{addr1},ethereum:{addr2},...` with batch requests chunked at 80 tokens. DeFiLlama is free, no API key, CORS-enabled. For ETH use `coingecko:ethereum` as the identifier. If DeFiLlama has no price for a token, mark it as "unpriced" — do not fall back to another provider.

### HR-8: Use actual token decimals from Tenderly, never hardcode 18

`gapToUsd()` in `calculator.ts` MUST use the actual token decimals from Tenderly's `token_info.decimals`, not a hardcoded `18`. The decimals flow through:

```
computeNetTokenFlows() → getTokenOutputFromChanges() → pipeline result.tokenDecimals → calculateGaps() → gapToUsd()
```

Without this, 6-decimal tokens (USDC, USDT) have their gaps divided by `10^18` instead of `10^6` — making losses appear ~10^12x smaller than reality. WBTC (8 decimals) is similarly affected. Fall back to `18` only when `tokenDecimals` is missing.

### HR-9: Net flow extraction must match the real Tenderly `asset_changes` shape

`computeNetTokenFlows()` in `tenderly.ts` MUST read the **actual** field layout that Tenderly returns from the v1 `simulate` endpoint with `simulation_type: "full"`. Pre-2026-04-15 the codebase used an imagined shape (`token_info.address`, top-level `type === "ERC20"`) that does not exist in any Tenderly response. The real shape is:

```typescript
{
  type: "Mint" | "Transfer" | "Burn";     // event-level classification, NOT a token standard
  from?: string;                          // absent on Mint
  to: string;                              // always present
  amount: string;                          // human-readable decimal ("0.1376") — NOT BigInt-parseable
  raw_amount?: string;                     // wei string ("137600000000000000") — USE THIS for BigInt math
  token_info: {
    standard: "ERC20" | "NativeCurrency" | "ERC721" | "ERC1155";
    type: "Fungible" | "Native" | "NonFungible";
    contract_address?: string;             // absent for NativeCurrency
    symbol?: string;
    decimals?: number;
  };
}
```

**Discrimination rules** — exactly what `computeNetTokenFlows()` does:

1. **Native ETH**: `token_info.standard === "NativeCurrency"`. Tracked under the zero-address pseudo-token (`0x0000...0000`), symbol `"ETH"`, decimals `18`.
2. **ERC-20**: `token_info.standard === "ERC20"` AND `token_info.contract_address` is present. Token address comes from `token_info.contract_address` (lowercased), NOT `token_info.address`.
3. **Everything else** (non-fungibles, unclassified, ERC-20 missing a contract address): **logged and dropped**. Never collapsed into any other bucket.

**BigInt amounts** come from `raw_amount`, with a fallback to the integer-truncated `amount` only for defensive handling. `amount` is a decimal string — passing it directly to `BigInt()` throws. The old code silently produced zero on every decimal amount by splitting on `"."` and taking `"0"`.

**Pre-2026-04-15 consequence** (EC-P3.7): every ERC-20 asset change fell through the non-existent `token_info.address` check into the "no token_info → ETH" branch, got bucketed under the zero address, and had its amount parsed as `BigInt(0)`. Both the wallet pipeline and the protocol pipeline were silently producing zero raw amounts and zero USD gaps. The smoke test that showed this was the first real inspection of the output.

**Top-level `change.type`** (`Mint` / `Transfer` / `Burn`) is NOT a token-standard discriminator. It describes the event, not the asset. Do not switch on it.

---

## External API Discipline

| Service | Rate Limit | Auth | Key Rule |
|---------|-----------|------|----------|
| Etherscan | 3 calls/sec (free tier) | API key in `.env` | Paginate at 10k results |
| Tenderly | 400/min ~6.7/sec (120k sims/month) | API key in `.env` | `save: false`, hex values, 8M gas, `simulation_type: "full"` |
| DeFiLlama | No hard limit | None | Batch tokens per request, chunk at 80 |
| Dune | 2,500 credits/mo | API key in `.env` | Most constrained — fallback to block N-1 |

Every external API call **must** go through `rateLimiters` from `rate-limiter.ts`:

```typescript
await rateLimiters.etherscan.execute(async () => { ... });
await rateLimiters.tenderly.execute(async () => { ... });
await rateLimiters.defillama.execute(async () => { ... });
```

---

## Block Number Calculation

The analysis window uses **real block numbers**, not magic constants:

```typescript
const latestBlock = await getLatestBlockNumber(apiKey);  // eth_blockNumber
const blocksPerDay = Math.floor((24 * 60 * 60) / BLOCK_TIME_SECONDS);  // 7200
const startBlock = latestBlock - (blocksPerDay * ANALYSIS_WINDOW_DAYS);
```

`ANALYSIS_WINDOW_DAYS` and `BLOCK_TIME_SECONDS` (12, post-merge) are in `constants.ts`.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | SQLite path (default: `file:./data/dev.db`) |
| `ETHERSCAN_API_KEY` | Yes | Free tier key |
| `DUNE_API_KEY` | Yes | Free tier key |
| `TENDERLY_ACCOUNT` | Yes | Account slug |
| `TENDERLY_PROJECT` | Yes | Project slug |
| `TENDERLY_API_KEY` | Yes | API key |
| `NEXT_PUBLIC_INTENTGUARD_URL` | No | CTA link on results page |

`COINGECKO_API_KEY` is **not used** — pricing is via DeFiLlama (no key needed).

---

## Error Handling Philosophy

- **Pipeline errors are non-fatal.** One tx simulation failing does not stop the pipeline. Skip it, log it, continue.
- **Never swallow errors silently.** At minimum: `console.warn` with context (tx hash, block, what failed).
- **Simulations return null on failure**, not throw. The pipeline checks for null and logs accordingly.
- **Retry with exponential backoff** for transient API failures (`retryWithBackoff` in `utils.ts`).

---

## Code Conventions

- **TypeScript strict mode.** `tsconfig.json` has `strict: true`.
- **BigInt for token amounts.** Convert to Number only at final USD display/response layer, using the safe division pattern (HR-6).
- **Addresses lowercase in code.** Checksummed only when displayed to user or sent to DeFiLlama.
- **No BigInt literals** (`0n`). Use `BigInt(0)` — target is ES2017.
- **Imports use `@/` path alias** for project-local imports.
- **Console logging uses `[module]` prefixes**: `[etherscan]`, `[tenderly]`, `[pipeline:jobId]`, `[filter]`, `[pricer]`, `[dune]`, `[db]`.

---

## Blueprint-Driven Development

This project uses blueprints as the single source of truth for all design decisions. Every agent — dev, testing, security, review — operates under this model.

### The Contract

1. **Blueprints describe what to build. Code implements it.** If they disagree, the blueprint is right until explicitly updated.
2. **Blueprints are updated BEFORE code.** Never implement a change to a data contract, API integration, or edge case handling without updating the relevant blueprint first. A code change without a blueprint update is tech debt by definition.
3. **Deviations are escalated, not buried.** If a blueprint is wrong or incomplete, say so explicitly in your output. Propose a correction. Do not silently work around it.
4. **Edge cases are documented before handled.** If you encounter a failure mode not in `blueprints/04-edge-cases.md`, add it with a proposed resolution before writing the handling code.
5. **Data contracts are the arbiter.** When two modules disagree on a type, field name, or format, `blueprints/02-data-contracts.md` is the tiebreaker.

### Blueprint Index

| Blueprint | What it governs | Updated by |
|-----------|----------------|------------|
| `01-pipeline-orchestration.md` | Execution order, concurrency, retries, progress events | Dev agent |
| `02-data-contracts.md` | Every module's input/output schema with exact types | Dev agent |
| `03-api-contracts/{service}.md` | Raw API request/response shapes per external service | Dev agent |
| `04-edge-cases.md` | Every failure mode, detection, resolution, user visibility | Any agent (escalation) |
| `05-database-schema.md` | Cache tables, TTLs, keys, query patterns | Dev agent |
| `06-ui-states.md` | What the user sees at each stage | Dev agent |

---

## Knowledge Graph (Graphify)

This project uses Graphify to maintain a knowledge graph of the codebase. A PreToolUse hook in `.claude/settings.json` ensures Claude Code consults the graph before searching files.

### Rules

- The graph in `graphify-out/` is **read-only** during development sessions. Do not run graphify commands.
- The graph is rebuilt on main after merges: `graphify . --update`
- `graphify-out/` is in `.gitignore` — it's a derived artifact.
- Use the graph for **navigation and understanding**. Use blueprints for **specification**.

### Graph vs Blueprints

- **Graph** = "what the code actually does and how it connects" (descriptive)
- **Blueprints** = "what the code should do" (prescriptive)
- When they diverge, investigate — it's either a bug or a stale blueprint.

---

## Agent Roles

This project uses specialist agents with defined personas in `.claude/agents/`. Each agent has a specific role, scope, and output directory.

| Agent | File | Writes to | Modifies source? |
|-------|------|----------|-----------------|
| Dev | `.claude/agents/dev.md` | `lib/`, `app/`, `blueprints/` | **Yes** |
| Testing | `.claude/agents/testing.md` | `tests/`, `reports/testing/` | No |
| Security | `.claude/agents/security.md` | `reports/security/` | No |
| Review | `.claude/agents/review.md` | `reports/review/` | No |

**Cardinal rule**: Only the dev agent modifies source code. Specialists diagnose, dev agent treats. If you are a specialist agent, do not fix what you find — report it.

---

## What Not To Do

- Do not move the pipeline to run in the browser. It runs server-side.
- Do not expose API keys to the client.
- Do not call external APIs without going through the rate limiter and cache.
- Do not use `Number()` on raw BigInt token amounts without the safe division pattern.
- Do not send decimal strings to Tenderly — always hex.
- Do not handle edge cases that aren't documented in `blueprints/04-edge-cases.md` — document them first.
- Do not create new pipeline modules without adding their data contracts to `blueprints/02-data-contracts.md` first.
- Do not use CoinGecko for pricing.

---

## Adopting Soon

These are planned improvements. Do not implement them unless explicitly tasked:

1. **`withCache` utility** �� generic cache-check-then-fetch wrapper to replace ad-hoc cache logic in each module.
2. **Structured pipeline run logs** — JSON log per run with stages, durations, cache hits, errors. Stored in Prisma.
3. **Blueprint directory** — `blueprints/` populated from actual codebase state.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"` to keep the graph current
