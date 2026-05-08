# API Rate Limiting Guide

This project uses a **generic rate limiter** to manage API requests across all free-tier APIs. This ensures we stay within rate limits and avoid getting blocked or throttled.

## Overview

The rate limiter is implemented in [`lib/rate-limiter.ts`](lib/rate-limiter.ts) and provides:

- **Per-second request throttling** — ensures we don't exceed X requests per second
- **Concurrent request limits** — limits the number of simultaneous requests
- **Automatic queuing** — requests are queued if limits are reached
- **Transparent API** — simple `execute()` method that handles everything

## Current API Integrations

### CoinGecko (Token Prices)
- **Limit**: 10 requests/second (free tier ~50 req/min)
- **Used in**: [`lib/analysis/calculator.ts`](lib/analysis/calculator.ts)
- **Concurrent**: 3 requests max
- **Implementation**: Wraps `getTokenPrice()` calls

```typescript
return await rateLimiters.coingecko.execute(async () => {
  // Your API call here
});
```

### Etherscan (Transaction History)
- **Limit**: 5 requests/second (free tier limit)
- **Used in**: [`lib/data-sources/etherscan.ts`](lib/data-sources/etherscan.ts)
- **Concurrent**: 1 request max (conservative for stability)
- **Implementation**: Wraps each paginated request

### Tenderly (Transaction Simulation)
- **Limit**: 50 requests/second (free tier is generous)
- **Used in**: [`lib/data-sources/tenderly.ts`](lib/data-sources/tenderly.ts)
- **Concurrent**: 5 requests max
- **Implementation**: Wraps each simulation request

## How to Use

### For Existing APIs
Just use the pre-configured rate limiters:

```typescript
import { rateLimiters } from "@/lib/rate-limiter";

// CoinGecko
await rateLimiters.coingecko.execute(async () => {
  return await fetch("https://api.coingecko.com/...");
});

// Etherscan
await rateLimiters.etherscan.execute(async () => {
  return await axios.get("https://api.etherscan.io/...");
});

// Tenderly
await rateLimiters.tenderly.execute(async () => {
  return await axios.post("https://api.tenderly.co/...");
});
```

### For New APIs
1. Add a new rate limiter instance in [`lib/rate-limiter.ts`](lib/rate-limiter.ts):

```typescript
export const rateLimiters = {
  // ... existing limiters
  newapi: new RateLimiter({
    requestsPerSecond: 10,  // Adjust based on API limits
    maxConcurrent: 2,       // Adjust based on API requirements
  }),
};
```

2. Use it in your API code:

```typescript
import { rateLimiters } from "@/lib/rate-limiter";

await rateLimiters.newapi.execute(async () => {
  return await fetch("https://api.newapi.com/...");
});
```

## Configuration Reference

### Rate Limit Defaults
- **CoinGecko**: 10 req/sec, 3 concurrent (conservative estimate from 50/min)
- **Etherscan**: 5 req/sec, 1 concurrent (strict to ensure reliability)
- **Tenderly**: 50 req/sec, 5 concurrent (generous free tier)

To adjust limits, edit [`lib/constants.ts`](lib/constants.ts):

```typescript
export const API_RATE_LIMITS = {
  COINGECKO_REQ_PER_SEC: 10,
  ETHERSCAN_REQ_PER_SEC: 5,
  // ... add more as needed
} as const;
```

## Monitoring

To check rate limiter stats (for debugging):

```typescript
const stats = rateLimiters.coingecko.getStats();
console.log(stats);
// Output:
// {
//   activeRequests: 2,
//   recentRequests: 8,      // In the last second
//   queuedRequests: 0,
// }
```

## How It Works Internally

1. **Request arrives** → Rate limiter checks if we're within limits
2. **Within limits** → Request executes immediately
3. **At limit** → Request waits until a slot opens up
4. **Concurrent limit hit** → Request queued and waits for active request to complete
5. **Timestamps tracked** → Sliding window of last 1-second requests
6. **Auto cleanup** → Old timestamps dropped after 1 second

## Best Practices

✅ **DO**:
- Wrap all external API calls in `rateLimiters.apiname.execute()`
- Keep concurrent limits conservative (start with 1-5)
- Monitor stats during development to ensure limits are appropriate

❌ **DON'T**:
- Call APIs directly without rate limiting (you'll risk getting blocked)
- Set `requestsPerSecond` higher than the API allows
- Use very high `maxConcurrent` values (risk overwhelming the API)

## Troubleshooting

### "Hitting rate limits and getting 429 errors"
- Lower `requestsPerSecond` or `maxConcurrent`
- Check if you're making more requests than expected
- Consider batching requests where possible

### "API is slow / responses are delayed"
- This is expected when at rate limits (throttling is working!)
- If too slow, check if the rate limits are too conservative
- Verify the API's actual free tier limits

### "Rate limiter not working"
- Ensure you're using `await rateLimiters.apiname.execute()`
- Check that the rate limiter is imported correctly
- Look for errors in console logs

## See Also
- [`lib/rate-limiter.ts`](lib/rate-limiter.ts) — Rate limiter implementation
- [`lib/constants.ts`](lib/constants.ts) — API rate limit constants
- [`lib/analysis/calculator.ts`](lib/analysis/calculator.ts) — CoinGecko example
- [`lib/data-sources/etherscan.ts`](lib/data-sources/etherscan.ts) — Etherscan example
- [`lib/data-sources/tenderly.ts`](lib/data-sources/tenderly.ts) — Tenderly example
