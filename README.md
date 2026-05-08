# MEV Impact Calculator

A production-grade web application that analyzes Ethereum wallet transaction history to quantify MEV (Maximal Extractable Value) losses from sandwich attacks, execution delays, and slippage.

## Overview

This tool serves as a top-of-funnel growth lever for IntentGuard, a MEV protection product. Users can:

1. **Paste their Ethereum wallet address** to analyze their transaction history
2. **View detailed MEV loss breakdown** by attack type (sandwich, delay, slippage)
3. **See their rank** on the Wall of Shame leaderboard
4. **Share results** as a card on social media
5. **Enable IntentGuard protection** to stop losing money to MEV

## Technology Stack

- **Frontend**: Next.js 14 (App Router), TypeScript, TailwindCSS
- **Backend**: Next.js API Routes (serverless functions)
- **Database**: SQLite with Prisma ORM
- **Data Sources**:
  - Etherscan API (wallet transaction history)
  - Dune Analytics API (mempool data)
  - Tenderly Simulation API (transaction simulation)
  - DeFiLlama API (token pricing — free, no key needed)
- **Deployment**: Docker-ready for any infrastructure

## Project Structure

```
mev-impact-calculator/
├── app/
│   ├── api/                    # API routes
│   │   ├── analyze/           # POST: trigger analysis
│   │   ├── status/[jobId]/    # GET: poll progress
│   │   ├── results/[address]/ # GET: fetch results
│   │   ├── leaderboard/       # GET: wall of shame
│   │   └── share/[address]/   # GET: share card
│   ├── results/[address]/     # Results dashboard
│   ├── wall-of-shame/         # Leaderboard page
│   ├── layout.tsx             # Root layout
│   ├── page.tsx               # Landing page
│   └── globals.css            # Global styles
├── lib/
│   ├── analysis/              # MEV analysis logic
│   │   ├── pipeline.ts        # Orchestration
│   │   ├── filter.ts          # DEX swap detection
│   │   ├── sandwich.ts        # Sandwich detection
│   │   └── calculator.ts      # Loss calculation
│   ├── data-sources/          # External API integrations
│   │   ├── etherscan.ts       # Etherscan API
│   │   ├── dune.ts            # Dune Analytics API
│   │   └── tenderly.ts        # Tenderly Simulation API
│   ├── db.ts                  # Database utilities
│   ├── job-queue.ts           # In-memory job queue
│   ├── constants.ts           # Constants & DEX routers
│   ├── types.ts               # TypeScript types
│   └── utils.ts               # Utility functions
├── prisma/
│   └── schema.prisma          # Database schema
├── Dockerfile                 # Docker image
├── docker-compose.yml         # Docker Compose config
└── package.json               # Dependencies
```

## Setup Instructions

### Prerequisites

- Node.js 18+ (tested with Node 22)
- pnpm (or npm/yarn)
- API keys for:
  - Etherscan (free tier: https://etherscan.io/apis)
  - Dune Analytics (free tier: https://dune.com/api)
  - Tenderly (free tier: https://tenderly.co)
  - DeFiLlama (free, no key needed — used automatically)

### Local Development

1. **Clone and install dependencies**:
   ```bash
   cd mev-impact-calculator
   pnpm install
   ```

2. **Set up environment variables**:
   ```bash
   cp .env.example .env.local
   # Edit .env.local with your API keys
   ```

3. **Initialize database**:
   ```bash
   pnpm exec prisma generate
   pnpm exec prisma db push
   ```

4. **Start development server**:
   ```bash
   pnpm dev
   ```

   Open [http://localhost:3000](http://localhost:3000) in your browser.

### Production Deployment

#### Option 1: Docker

```bash
# Build image
docker build -t mev-impact-calculator .

# Run container
docker run -p 3000:3000 \
  -e ETHERSCAN_API_KEY=your_key \
  -e DUNE_API_KEY=your_key \
  -e TENDERLY_ACCOUNT=your_account \
  -e TENDERLY_PROJECT=your_project \
  -e TENDERLY_API_KEY=your_key \
  -e NEXT_PUBLIC_INTENTGUARD_URL=https://your-intentguard-url \
  -v ./data:/app/data \
  mev-impact-calculator
```

#### Option 2: Docker Compose

```bash
# Create .env file with your API keys
cp .env.example .env

# Start services
docker-compose up -d

# View logs
docker-compose logs -f app
```

#### Option 3: Manual Deployment

```bash
# Build
pnpm run build

# Start
pnpm start
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | SQLite connection string (default: `file:./dev.db`) |
| `ETHERSCAN_API_KEY` | Yes | Etherscan API key for tx history |
| `DUNE_API_KEY` | Yes | Dune Analytics API key for mempool data |
| `TENDERLY_ACCOUNT` | Yes | Tenderly account name |
| `TENDERLY_PROJECT` | Yes | Tenderly project name |
| `TENDERLY_API_KEY` | Yes | Tenderly API key for simulations |
| ~~`COINGECKO_API_KEY`~~ | No | **Deprecated** — pricing now uses DeFiLlama (no key needed) |
| `NEXT_PUBLIC_INTENTGUARD_URL` | No | IntentGuard product URL |
| `NEXT_PUBLIC_APP_URL` | No | App URL for OG image generation |

## API Endpoints

### POST /api/analyze
Trigger analysis for a wallet address.

**Request**:
```json
{
  "address": "0x..."
}
```

**Response**:
```json
{
  "jobId": "...",
  "status": "pending",
  "progress": 0
}
```

### GET /api/status/[jobId]
Poll analysis progress.

**Response**:
```json
{
  "status": "simulating",
  "progress": 65,
  "totalTxs": 47,
  "processedTxs": 31,
  "currentStep": "Simulating transaction 31 of 47..."
}
```

### GET /api/results/[address]
Fetch completed analysis results.

**Response**:
```json
{
  "address": "0x...",
  "totalLossUsd": 2847.32,
  "sandwichLossUsd": 1923.10,
  "delayLossUsd": 412.50,
  "slippageLossUsd": 511.72,
  "txsAnalyzed": 156,
  "txsSandwiched": 14,
  "rank": 8342,
  "worstTx": { "hash": "0x...", "lossUsd": 847.20, "type": "sandwich" },
  "transactions": [...],
  "analyzedAt": "2026-04-09T..."
}
```

### GET /api/leaderboard
Get Wall of Shame leaderboard.

**Query Parameters**:
- `page`: Page number (default: 1)
- `limit`: Results per page (default: 20, max: 100)

**Response**:
```json
{
  "entries": [
    { "rank": 1, "address": "0x...", "addressTruncated": "0x1234...abcd", "totalLossUsd": 142847.32, "txsSandwiched": 89 },
    ...
  ],
  "totalWallets": 12453,
  "page": 1,
  "limit": 20,
  "totalPages": 623
}
```

### GET /api/share/[address]
Generate OG image for social sharing.

**Response**: SVG image (for use as og:image meta tag)

## Key Features

### 1. Sandwich Attack Detection
- Identifies front-run and back-run transactions in the same block
- Detects known sandwich bot addresses
- Calculates losses from price manipulation

### 2. Execution Delay Analysis
- Measures inclusion delay from mempool to block
- Calculates losses from market movement during wait
- Uses Dune mempool data for accurate timing

### 3. Slippage Calculation
- Compares expected vs actual swap output
- Simulates transactions at mempool block state
- Accounts for intra-block price impact

### 4. Leaderboard & Ranking
- Ranks wallets by total MEV losses
- Displays top 100 most impacted wallets
- Provides wallet-specific ranking

### 5. Share Cards
- Generates SVG cards with wallet stats
- Optimized for Twitter/Farcaster sharing
- Includes IntentGuard CTA

## Data Flow

1. **User enters wallet address** → Landing page
2. **POST /api/analyze** → Creates analysis job
3. **Analysis Pipeline**:
   - Fetch tx history from Etherscan
   - Filter DEX swaps
   - Query mempool data from Dune
   - Simulate at mempool block (Tenderly)
   - Get actual output from on-chain events
   - Detect sandwiches
   - Calculate gaps in USD
4. **Store results** in SQLite database
5. **GET /api/results** → Display dashboard
6. **GET /api/leaderboard** → Wall of Shame

## Performance Considerations

### Rate Limiting
- **Etherscan**: 5 req/sec (respects free tier limits)
- **Dune**: Batches queries to minimize credits
- **Tenderly**: Sequential simulations with delays

### Caching
- Transaction analysis results cached in database
- Wallet rankings updated on new analysis
- Leaderboard paginated for performance

### Job Queue
- Simple in-memory queue for async analysis
- Processes one job at a time (respects API limits)
- Suitable for small to medium scale
- For production scale, consider Redis + Bull/BullMQ

## Error Handling

- **Graceful degradation**: Partial results if some APIs fail
- **Retry logic**: Exponential backoff for transient failures
- **Fallback mechanisms**: Estimates for missing mempool data
- **User feedback**: Clear error messages in UI

## Security

- No private keys stored or transmitted
- All data is public on-chain
- API keys stored in environment variables
- No user authentication required (read-only analysis)

## Testing

```bash
# Run tests (when implemented)
pnpm test

# Type checking
pnpm exec tsc --noEmit

# Linting
pnpm exec eslint .
```

## Monitoring & Logging

- Server logs: Check Docker container logs
- Database: SQLite at `./data/dev.db`
- API errors: Logged to console in development

## Future Enhancements

- [ ] Wallet Connect integration for address resolution
- [ ] Historical MEV loss tracking over time
- [ ] Advanced filtering (by DEX, token pair, date range)
- [ ] Webhook notifications for sandwich attacks
- [ ] Integration with MEV protection services
- [ ] Real-time monitoring dashboard
- [ ] GraphQL API
- [ ] Mobile app

## Contributing

This is a production application. For modifications:

1. Create a feature branch
2. Follow existing code patterns
3. Test thoroughly before deploying
4. Update documentation

## License

MIT

## Support

For issues or questions:
- Check API key configuration
- Review logs for error details
- Verify network connectivity to external APIs
- Ensure database is initialized

## Acknowledgments

- Etherscan for transaction history
- Dune Analytics for mempool data
- Tenderly for transaction simulation
- DeFiLlama for token pricing
- IntentGuard for MEV protection context
