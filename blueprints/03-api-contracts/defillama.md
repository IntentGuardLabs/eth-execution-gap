# API Contract: DeFiLlama

> Last updated: 2026-04-11 | File: `lib/analysis/calculator.ts`

## Authentication

**None required.** DeFiLlama is fully free with no API key.

## Rate Limits

- No hard rate limit published
- We use **5 requests/second**, **2 concurrent** (conservative)
- Enforced via `rateLimiters.defillama`

## Base URL

```
https://coins.llama.fi
```

---

## Endpoint: Current Prices (batch)

**Purpose**: Get current USD price for multiple tokens in one call

**Request**:
```
GET /prices/current/ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2,coingecko:ethereum
```

**URL construction**:
- ERC-20 tokens: `ethereum:{checksummed_or_lowercase_address}`
- Native ETH: `coingecko:ethereum`
- Comma-separated, no spaces
- **Chunk at 80 tokens per request** to avoid URL length issues

**Response**:
```json
{
  "coins": {
    "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
      "decimals": 6,
      "symbol": "USDC",
      "price": 0.999847,
      "timestamp": 1712345678,
      "confidence": 0.99
    },
    "ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": {
      "decimals": 18,
      "symbol": "WETH",
      "price": 3456.78,
      "timestamp": 1712345678,
      "confidence": 0.99
    },
    "coingecko:ethereum": {
      "symbol": "ETH",
      "price": 3456.78,
      "timestamp": 1712345678,
      "confidence": 0.99
    }
  }
}
```

**Fields we extract**: `coins[key].price` — USD price as a number

**Note**: `coingecko:*` identifiers do NOT return a `decimals` field. Only `ethereum:*` (ERC-20) entries include `decimals`. Code uses `tokenDecimals` from Tenderly's `token_info` (HR-8), not from DeFiLlama.

**Missing tokens**: If a token has no price data, it simply won't appear in the `coins` object. We treat missing as price = 0 and log a warning. The token is effectively "unpriced" (HR-7).

---

## Endpoint: Historical Prices (not yet used)

**Purpose**: Get USD price at a specific timestamp (future enhancement)

**Request**:
```
GET /prices/historical/{unix_timestamp}/ethereum:{addr1},ethereum:{addr2}
```

**Response**: Same shape as current prices.

---

## Error Handling

| Scenario | Detection | Action |
|----------|-----------|--------|
| HTTP error (5xx) | `!response.ok` | Log warning, tokens in this batch get price 0 |
| Token not found | Key missing from `coins` object | Price = 0, logged as "unpriced" |
| Network timeout | fetch timeout | Log warning, retry not implemented (non-critical) |
| Malformed response | Missing `coins` field | Log warning, all tokens in batch get price 0 |

**Pricing errors are non-fatal.** An unpriced token results in `gapUsd: 0` for that tx — the tx still appears in results with the raw gap amount.

## CORS

DeFiLlama supports CORS. Called server-side from API routes.

## Key Formatting Rule

ETH address `0x0000000000000000000000000000000000000000` is mapped to `coingecko:ethereum`. All other addresses use `ethereum:{address}`.
