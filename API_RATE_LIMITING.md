# API Rate Limiting — Authoritative Reference

This is the single source of truth for external-API rate limits in this project.
**Dev MUST consult this file before** adding a new API call, bumping a rate limit,
or changing concurrency.

Last audited: **2026-04-13** — see "Audit Log" at the bottom.

---

## Cardinal Rule

> **Every external API call MUST go through `rateLimiters.<service>.execute(fn)`
> from `lib/rate-limiter.ts`. No exceptions.**

If a new service is added, its limiter must be defined in `rate-limiter.ts` *before*
the first call site lands. A direct `axios` / `fetch` call that bypasses the limiter
is a bug, regardless of how low the call volume looks.

---

## Services In Use

The table below lists the **official vendor limit**, the **configured limit in code**,
and the **call sites** that must stay wrapped. When vendor docs change, update both
`lib/rate-limiter.ts` and this file in the same commit.

| Service     | Vendor limit (free tier)            | Configured (`rate-limiter.ts`) | Concurrency | Auth              | Notes |
|-------------|-------------------------------------|--------------------------------|-------------|-------------------|-------|
| Etherscan   | 3 req/sec (free); 5/sec is paid Lite | 3 req/sec                      | 1           | `ETHERSCAN_API_KEY` | Paginate at 10k results; `page * offset <= 10000` |
| Tenderly    | ~400 sims/min (≈6.7/sec), 120k/mo    | 6 req/sec                      | 3           | `TENDERLY_API_KEY`  | Hex values, 8M gas, `save:false`, `simulation_type:"full"` (HR-1,2) |
| DeFiLlama   | No hard rate limit published         | 5 req/sec (conservative)       | 2           | None              | Batch tokens, **chunk at 80** per request (HR-7) |
| Dune        | 2,500 credits/month (credit-based)   | **NOT WRAPPED — see violation below** | — | `DUNE_API_KEY`    | Use `performance: "medium"`; polling loop fires up to 60 GETs/query |

> CoinGecko is **NOT** used. HR-7 forbids it — all pricing goes through DeFiLlama.
> Any reference to CoinGecko in new code is a review-blocker.

### Hard-coded timeouts (`lib/constants.ts` → `API_RATE_LIMITS`)

| Constant                          | Value    | Applies to                          |
|-----------------------------------|----------|-------------------------------------|
| `DEFILLAMA_REQ_PER_SEC`           | 5        | Mirror of limiter cfg               |
| `ETHERSCAN_REQ_PER_SEC`           | 3        | Mirror of limiter cfg               |
| `DUNE_QUERY_TIMEOUT_MS`           | 30_000   | `axios` timeout per Dune call       |
| `TENDERLY_SIMULATION_TIMEOUT_MS`  | 30_000   | `axios` timeout per simulation      |

If you change a value in `rate-limiter.ts`, update the mirror constant in
`constants.ts` *and* the table above in the same commit.

---

## Current Call-Site Inventory

Every external call is listed here. If you add a new call site, append it to this
list in the same PR.

### Etherscan — all wrapped ✅
- `lib/data-sources/etherscan.ts:14` — `getLatestBlockNumber` (`eth_blockNumber`)
- `lib/data-sources/etherscan.ts:87` — `fetchWalletTransactions` (`account.txlist`, paginated)
- `lib/data-sources/etherscan.ts:185` — `fetchWalletERC20Transfers` (`account.tokentx`)
- `lib/data-sources/etherscan.ts:249` — `getTransactionReceipt` (`proxy.eth_getTransactionReceipt`)
- `lib/data-sources/etherscan.ts:280` — `getCode` (`proxy.eth_getCode`) — called in a per-address loop in `batchCheckContracts`; relies on the limiter to pace the loop

### Tenderly — all wrapped ✅
- `lib/data-sources/tenderly.ts:57` — `simulateTransaction` (`POST /simulate`)

### DeFiLlama — all wrapped ✅
- `lib/analysis/calculator.ts:37` — `batchGetTokenPrices` (`GET /prices/current/...`), chunked at 80

### Dune — NOT wrapped ❌ (see violation)
- `lib/data-sources/dune.ts:52` — `POST /sql/execute`
- `lib/data-sources/dune.ts:83` — `GET /execution/{id}/results` (inside a 60-iteration poll loop, 2s cadence)

---

## Known Violations (as of 2026-04-13)

### V1 — Dune bypasses the rate limiter (blocker)

**Where:** `lib/data-sources/dune.ts` lines 52 and 83.

**What:** Both `axios` calls go out with no limiter wrapping. There is also no
`rateLimiters.dune` defined in `lib/rate-limiter.ts`.

**Why it matters:**
- Violates the Cardinal Rule above.
- Dune's credit budget (2,500/mo) is the tightest of any service in this project;
  every run burns credits, and concurrent runs can race.
- The polling loop can fire up to 60 GETs for a single `queryMempoolData` call. If
  two wallet analyses overlap, request bursts interleave with zero pacing.
- When Dune eventually returns 429s or rate errors, there's no back-pressure; the
  pipeline will just fail loudly instead of queueing.

**Fix plan (for dev):**
1. Add to `lib/rate-limiter.ts`:
   ```ts
   dune: new RateLimiter({
     requestsPerSecond: 2,  // conservative; Dune free tier has no documented per-sec limit
     maxConcurrent: 1,      // only one Dune query in flight at a time
   }),
   ```
2. Wrap both `axios.post` and `axios.get` in `dune.ts` with
   `await rateLimiters.dune.execute(async () => { ... })`.
3. Leave `retryWithBackoff` around the `execute` call, not inside it (same pattern
   as `tenderly.ts:55-87`).
4. Update the table above to reflect the new configured values.
5. Update `blueprints/03-api-contracts/dune.md` if that file exists.

---

## Checklist — Before Merging Any API-Touching Change

Dev MUST tick every box. Review blocks on any ❌.

- [ ] Every new external call goes through `rateLimiters.<service>.execute(fn)`.
- [ ] If a new service is introduced, a limiter entry is added to `rate-limiter.ts`
      with **both** `requestsPerSecond` and `maxConcurrent` set, and the values
      have a comment citing the vendor's documented limit.
- [ ] `lib/constants.ts` mirror constants are updated if the limiter values changed.
- [ ] The "Services In Use" table and "Current Call-Site Inventory" in **this file**
      are updated in the same commit.
- [ ] The cache layer (see `blueprints/05-database-schema.md`) is checked *before*
      hitting the API — rate limits don't matter if cache hits avoid the call entirely.
- [ ] For bursty endpoints (Dune polling, Etherscan pagination, Tenderly per-tx
      simulation in pipelines), confirm the limiter's `requestsPerSecond` × typical
      burst fits within the vendor's per-minute budget too.
- [ ] No CoinGecko. HR-7.
- [ ] Tenderly values are hex (HR-1), gas is `SIMULATION_GAS_LIMIT = 8_000_000` (HR-2).
- [ ] DeFiLlama token batches chunked at ≤80 (HR-7).

---

## How the Limiter Works (short version)

`lib/rate-limiter.ts` maintains a sliding 1-second window of request timestamps per
service. `execute(fn)`:

1. Waits until `activeRequests < maxConcurrent`.
2. Waits until the 1-second window has fewer than `requestsPerSecond` entries
   (sleeps until the oldest entry expires + 1ms buffer).
3. Pushes a timestamp, increments `activeRequests`, runs `fn`.
4. On finish/throw, decrements `activeRequests` and drains the queue.

There is no cross-process coordination — the limiter is in-memory per Node process.
If the pipeline ever moves to multi-worker, the limiter must be reworked (Redis-backed
token bucket or similar). Until then, `maxConcurrent: 1` on the tightest service
(Etherscan, Dune) is what keeps bursts in check.

---

## Audit Log

| Date       | Auditor | Scope                                      | Result |
|------------|---------|--------------------------------------------|--------|
| 2026-04-13 | Claude  | Grep every `fetch`/`axios` call in `lib/`; match against `rateLimiters.*.execute` wrapping | ✅ Etherscan, Tenderly, DeFiLlama clean. ❌ Dune bypasses limiter — V1 filed above. Stale file rewritten (old file referenced CoinGecko & wrong limits). |

When you run a new audit, append a row — do not overwrite. Keep rows short; link
to a PR or report for detail.

---

## See Also
- `lib/rate-limiter.ts` — implementation
- `lib/constants.ts` — `API_RATE_LIMITS` mirrors
- `CLAUDE.md` → "External API Discipline" & "Hardened Rules" sections
- `blueprints/03-api-contracts/` — per-service request/response shapes
- `blueprints/05-database-schema.md` — cache TTLs (call the cache before the API)
