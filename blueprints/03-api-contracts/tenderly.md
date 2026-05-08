# API Contract: Tenderly

> Last updated: 2026-04-11 | File: `lib/data-sources/tenderly.ts`

## Authentication

- Account slug: `process.env.TENDERLY_ACCOUNT`
- Project slug: `process.env.TENDERLY_PROJECT`
- API key: `process.env.TENDERLY_API_KEY` — sent as `X-Access-Key` header

## Rate Limits

- **400 requests/minute** (~6.7 req/sec) for authenticated users
- **100 requests/minute** for non-authenticated users
- **120,000 simulations/month** (free tier total)
- Enforced via `rateLimiters.tenderly` (6 req/s, 3 concurrent max)

## Base URL

```
https://api.tenderly.co/api/v1
```

---

## Endpoint: Simulate Transaction

**Purpose**: Simulate a transaction at a specific block state to get expected asset changes

**Request**:
```
POST /api/v1/account/{account}/project/{project}/simulate
```

**Headers**:
```
X-Access-Key: {apiKey}
Content-Type: application/json
```

**Request Body**:
```json
{
  "network_id": "1",
  "from": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
  "to": "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
  "input": "0x38ed1739...",
  "value": "0xde0b6b3a7640000",
  "gas": 8000000,
  "gas_price": "0x6fc23ac00",
  "block_number": 21456788,
  "save": false,
  "save_if_fails": false,
  "simulation_type": "full"
}
```

### Critical Format Rules (HR-1, HR-2)

| Field | Format | Source | Example |
|-------|--------|--------|---------|
| `value` | **Hex string with 0x prefix** | `toHex(txData.value)` | `"0xde0b6b3a7640000"` |
| `gas` | **Integer** | Always `SIMULATION_GAS_LIMIT` (8,000,000) | `8000000` |
| `gas_price` | **Hex string with 0x prefix** | `toHex(txData.gasPrice)` | `"0x6fc23ac00"` |
| `block_number` | **Integer** | Mempool block or inclusion block | `21456788` |
| `network_id` | **String** | Always `"1"` | `"1"` |
| `save` | **Boolean** | Always `false` | `false` |
| `simulation_type` | **String** | Always `"full"` | `"full"` |

**NEVER send decimal strings for `value` or `gas_price`.** Tenderly silently misinterprets them (HR-1).

> **Docs discrepancy (HR-1)**: Tenderly's own API docs show decimal strings for `value` and `gas_price` (e.g. `"0"`, `"18312000018"`). However, HR-1 was established from a real production bug: decimal strings produced silently wrong simulation results. Hex strings with `0x` prefix produce correct results. Do not "fix" this to match Tenderly docs — the hex format is validated in production.

### simulation_type parameter

| Value | Description |
|-------|-------------|
| `full` | Full simulation with asset_changes, call traces, state diffs. **Required for our use case.** |
| `quick` | Faster simulation, may omit asset_changes. **Do not use.** |
| `abi` | ABI-decoded simulation. Not needed. |

We explicitly set `simulation_type: "full"` to guarantee `asset_changes` is populated in the response.

**Response** (success — tx executed):
```json
{
  "transaction": {
    "status": true,
    "transaction_info": {
      "asset_changes": [
        {
          "type": "ERC20",
          "from": "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
          "to": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
          "token_info": {
            "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            "symbol": "USDC",
            "decimals": 6
          },
          "amount": "1500000000"
        },
        {
          "type": "ERC20",
          "from": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
          "to": "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
          "token_info": {
            "address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            "symbol": "WETH",
            "decimals": 18
          },
          "amount": "500000000000000000"
        }
      ]
    }
  }
}
```

**Response** (simulation reverted — tx would fail on-chain):
```json
{
  "transaction": {
    "status": false,
    "error_message": "execution reverted",
    "error_info": { ... },
    "transaction_info": {
      "asset_changes": null
    }
  }
}
```

A reverted tx returns a full `transaction` object with `status: false` — NOT `"transaction": null`. The `null` case only occurs on truly malformed requests that produce HTTP 400. Our code handles both paths:
- `!response.transaction` (null — malformed request) → return null, log warning
- `response.transaction` exists but `asset_changes` is null/empty → `extractAssetChanges()` returns `[]`, pipeline sees no token output

**Fields we extract**:
- `transaction.transaction_info.asset_changes[]` — array of token movements
- Each change has: `type`, `from`, `to`, `token_info` (address, symbol, decimals), `amount`

**Net flow computation (HR-4, HR-9)**:
```
For each asset change:
  If type === "ERC20" and token_info.address exists:
    Track by token_info.address, using token_info.symbol and token_info.decimals
  Else if token_info.address is missing (native ETH transfer — HR-9):
    Track by 0x0000000000000000000000000000000000000000, symbol "ETH", decimals 18
  Else (ERC-721, ERC-1155, etc.):
    Skip — non-fungible types are not priced

  If change.to === wallet → inflow  += BigInt(amount)
  If change.from === wallet → outflow += BigInt(amount)
  net = inflow - outflow per token
Pick largest positive net as swap output.
```

---

## Error Handling

| Scenario | Detection | Action |
|----------|-----------|--------|
| Simulation reverted | `response.transaction.status === false` | `asset_changes` is null → `extractAssetChanges()` returns `[]` → pipeline treats as no output |
| No transaction object | `response.transaction` is null (malformed request) | Return null, log warning |
| HTTP 400 (bad request) | axios error, status 400 | Return null, log error with block number |
| HTTP 401/403 (auth) | axios error, status 401/403 | Throw — cannot proceed without valid key |
| HTTP 429 (rate limit) | axios error, status 429 | Retry with backoff (2 total attempts, 2s initial) |
| Timeout | axios timeout (30s) | Retry with backoff |
| `asset_changes` is null/empty | Check after successful response | `extractAssetChanges()` returns `[]`, `getTokenOutputFromChanges()` returns null |

## CORS

Tenderly supports CORS. Called server-side from API routes.

## Simulation Count Budget

Each `simulateTransaction()` call = 1 simulation. Each analyzed tx uses 2 simulations (mempool block + inclusion block). Budget: 120k/month = ~60k txs/month = ~2000 txs/day.
