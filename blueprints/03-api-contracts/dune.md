# API Contract: Dune Analytics

> Last updated: 2026-04-11 | File: `lib/data-sources/dune.ts`

## Authentication

- API key: `process.env.DUNE_API_KEY`
- Sent as `X-Dune-Api-Key` header

## Rate Limits

- **2,500 credits/month** (free tier) — **most constrained resource**
- Query execution costs vary by complexity
- We batch all tx hashes into a single SQL query to minimize credit usage

## Base URL

```
https://api.dune.com/api/v1
```

---

## Endpoint 1: Execute SQL Query

**Purpose**: Find mempool timestamps for transaction hashes

**Request**:
```
POST /api/v1/sql/execute
```

**Headers**:
```
X-Dune-Api-Key: {apiKey}
Content-Type: application/json
```

**Request Body**:
```json
{
  "sql": "SELECT mp.hash, mp.timestamp_ms, mp.inclusion_delay_ms, mp.included_at_block_height, b.number as mempool_block_number, b.time as mempool_block_time FROM flashbots.dataset_mempool_dumpster mp LEFT JOIN ethereum.blocks b ON b.time <= from_unixtime(mp.timestamp_ms / 1000) AND b.time > from_unixtime(mp.timestamp_ms / 1000 - 13) WHERE mp.hash IN ('0xabc...','0xdef...') ORDER BY mp.hash, b.time DESC",
  "performance": "medium"
}
```

**SQL breakdown**:
- Source table: `flashbots.dataset_mempool_dumpster` — Flashbots' public mempool data
- Joins with `ethereum.blocks` to find the block active when the tx entered the mempool
- The `13` in the time window (one slot + 1s margin) ensures we find the right block
- `ORDER BY b.time DESC` so the first result per hash is the most recent block before mempool entry

**Response**:
```json
{
  "execution_id": "01HXYZ...",
  "state": "QUERY_STATE_PENDING"
}
```

---

## Endpoint 2: Get Execution Results

**Purpose**: Poll for query completion and fetch results

**Request**:
```
GET /api/v1/execution/{execution_id}/results
```

**Headers**:
```
X-Dune-Api-Key: {apiKey}
```

**Response** (pending):
```json
{
  "state": "QUERY_STATE_EXECUTING",
  "is_execution_finished": false
}
```

**Response** (complete):
```json
{
  "state": "QUERY_STATE_COMPLETED",
  "is_execution_finished": true,
  "result": {
    "rows": [
      {
        "hash": "0xabc123...",
        "timestamp_ms": 1712345678000,
        "inclusion_delay_ms": 14320,
        "included_at_block_height": 21456789,
        "mempool_block_number": 21456788,
        "mempool_block_time": "2025-04-05 12:34:56"
      }
    ]
  }
}
```

**Response** (failed):
```json
{
  "state": "QUERY_STATE_FAILED",
  "error": "..."
}
```

**All possible query states**:
| State | Terminal? | Action |
|-------|----------|--------|
| `QUERY_STATE_PENDING` | No | Continue polling |
| `QUERY_STATE_EXECUTING` | No | Continue polling |
| `QUERY_STATE_COMPLETED` | Yes | Extract results |
| `QUERY_STATE_FAILED` | Yes | Throw error |
| `QUERY_STATE_CANCELED` | Yes | Throw error — query was canceled externally |
| `QUERY_STATE_EXPIRED` | Yes | Throw error — query expired before completing |
| `QUERY_STATE_COMPLETED_PARTIAL` | Yes | Treat as completed — extract available rows, log warning |

**Polling strategy**: 2-second intervals, max 60 attempts (120s timeout). Must handle all terminal states — not just COMPLETED and FAILED — to avoid spinning for 120s on unexpected states.

**Fields we extract per row**:
| Field | Type | Description |
|-------|------|-------------|
| `hash` | string | tx hash (lowercase) |
| `timestamp_ms` | number | when tx entered mempool (unix ms) |
| `inclusion_delay_ms` | number | time from mempool to block inclusion |
| `included_at_block_height` | number | block where tx was actually included |
| `mempool_block_number` | number | block active when tx entered mempool |
| `mempool_block_time` | string | timestamp of mempool block |

**Grouping**: Results may have multiple rows per hash (from the block join). We take the first row per hash (most recent block due to `ORDER BY DESC`).

---

## Fallback: `estimateMempoolBlockNumber()`

When a tx hash is NOT in Dune's mempool dumpster (private tx, Flashbots bundle, very old tx):

```typescript
function estimateMempoolBlockNumber(includedAtBlockHeight: number): number {
  return Math.max(0, includedAtBlockHeight - 1);
}
```

This is conservative — assumes the tx was available one block before inclusion. Flagged as `isEstimated: true` in the pipeline output.

---

## Error Handling

| Scenario | Detection | Action |
|----------|-----------|--------|
| No tx hashes to query | `txHashes.length === 0` | Return empty Map immediately |
| Query failed | `state === "QUERY_STATE_FAILED"` | Throw — pipeline catches and continues |
| Query canceled | `state === "QUERY_STATE_CANCELED"` | Throw — pipeline catches and continues |
| Query expired | `state === "QUERY_STATE_EXPIRED"` | Throw — pipeline catches and continues |
| Query partial | `state === "QUERY_STATE_COMPLETED_PARTIAL"` | Extract available rows, log warning |
| Polling timeout (120s) | `attempts >= maxAttempts` | Throw — pipeline catches and continues |
| Tx not in mempool dumpster | Hash not in results | Use `estimateMempoolBlockNumber()` fallback |
| API key invalid | HTTP 401/403 | Throw — pipeline catches and continues with fallback |
| Rate limit exceeded | HTTP 429 | Retry with backoff (2 total attempts, 2s initial) |

**Two-layer fallback strategy**: The pipeline wraps `queryMempoolData()` in a try/catch (`pipeline.ts`). If Dune fails entirely (any throw), the pipeline continues with an empty map. Then per-tx, missing map entries fall back to `estimateMempoolBlockNumber(inclusionBlock)` = block N-1. This means Dune being completely down is non-fatal — the analysis completes with estimated mempool blocks for all txs.

## Credit Conservation

- All tx hashes are batched into ONE SQL query (not one query per tx)
- `performance: "medium"` balances cost vs speed
- If Dune credits are exhausted, the pipeline falls back to `inclusionBlock - 1` for all txs

## CORS

Dune API may not support browser CORS. Called server-side from API routes — not an issue.
