# API Contract: Etherscan

> Last updated: 2026-04-11 | File: `lib/data-sources/etherscan.ts`

## Authentication

- API key in `process.env.ETHERSCAN_API_KEY`
- Passed as `apikey` query parameter

## Rate Limits

- **3 requests/second** (free tier hard limit — 5/sec is paid Lite tier)
- Enforced via `rateLimiters.etherscan` (3 req/s, 1 concurrent max)

## Base URL

```
https://api.etherscan.io/v2/api
```

All requests include `chainid=1` (Ethereum mainnet).

---

## Endpoint 1: Get Latest Block Number

**Purpose**: Determine real current block for window calculation

**Request**:
```
GET /v2/api?chainid=1&module=proxy&action=eth_blockNumber&apikey={key}
```

**Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": "0x1446A08"
}
```

**Fields we extract**: `result` — hex block number, parsed with `parseInt(hex, 16)`

---

## Endpoint 2: Transaction List

**Purpose**: Fetch all wallet transactions within block range

**Request**:
```
GET /v2/api?chainid=1&module=account&action=txlist
  &address=0x...
  &startblock={startBlock}
  &endblock={latestBlock}
  &page={page}
  &offset=1000
  &sort=desc
  &apikey={key}
```

**Response** (success):
```json
{
  "status": "1",
  "message": "OK",
  "result": [
    {
      "hash": "0xabc123...",
      "from": "0x...",
      "to": "0x...",
      "value": "1000000000000000000",
      "input": "0x38ed1739...",
      "gas": "200000",
      "gasPrice": "30000000000",
      "gasUsed": "150000",
      "blockNumber": "21456789",
      "blockHash": "0x...",
      "transactionIndex": "42",
      "isError": "0",
      "txreceipt_status": "1",
      "timeStamp": "1712345678"
    }
  ]
}
```

**Response** (no results):
```json
{ "status": "0", "message": "No transactions found", "result": [] }
```

**Response** (pagination overflow):
```json
{ "status": "0", "message": "Result window is too large, ...", "result": [] }
```

**Pagination**: `page * offset` must be <= 10,000. We use `offset=1000`, `maxPages=10`.

**Fields we extract**: All fields in `result[]`. `blockNumber` and `transactionIndex` are parsed from string to `number`. Everything else stays as string.

**Important**: All numeric values (`value`, `gas`, `gasPrice`, `gasUsed`) are **decimal strings**. Must be converted to hex before Tenderly (HR-1).

---

## Endpoint 3: ERC-20 Token Transfers

**Purpose**: Fetch token transfer events (used by `fetchWalletERC20Transfers`)

**Request**:
```
GET /v2/api?chainid=1&module=account&action=tokentx
  &address=0x...
  &startblock=0&endblock=99999999
  &sort=asc&apikey={key}
```

**Response**: Same shape as txlist, but for token transfer events.

---

## Endpoint 4: Transaction Receipt

**Purpose**: Get receipt for a specific transaction

**Request**:
```
GET /v2/api?chainid=1&module=proxy&action=eth_getTransactionReceipt
  &txhash=0x...&apikey={key}
```

**Response**: Standard Ethereum JSON-RPC receipt object.

---

## Error Handling

| Scenario | Detection | Action |
|----------|-----------|--------|
| Rate limited (429) | HTTP 429 or `status: "0"` with rate limit message | Retry with backoff (3 total attempts, 1s initial) |
| No transactions | `message === "No transactions found"` | Return empty array |
| Pagination overflow | `message` includes "Result window is too large" | Stop pagination, return what we have |
| API key invalid | HTTP 403 or error message | Throw — cannot proceed |
| Network timeout | axios timeout (15s for `txlist`, 10s for `eth_blockNumber`/`tokentx`/`getTransactionReceipt`) | Retry with backoff |

## CORS

Etherscan supports CORS. Called server-side from API routes.
