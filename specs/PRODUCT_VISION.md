# Product Vision — Execution Gap Tool

## What
A public tool that shows how much value any Ethereum wallet lost between transaction simulation (mempool arrival) and actual execution (block inclusion). One number: total $ lost over the analysis window.

## Who
Anyone. Public tool, no login, no restrictions. Enter a wallet address, get results.

First strategic users are vault curators (kpk, Steakhouse, Nashpoint) but the tool doesn't target or mention them specifically. It doesn't mention IntentGuard. It stands alone.

## Why
Proves the execution gap is real and measurable. The gap exists across all DeFi — not just swaps, not just MEV. By surfacing unknown protocols and unexpected losses, this tool reveals problems the ecosystem doesn't know it has, including transaction simulation spoofing.

## Success Metric
The gap calculation is accurate. That's it. Not traffic, not signups — accuracy.

## What's In

### Core Analysis
- Simulate every qualifying tx at mempool-arrival block vs inclusion block
- Calculate the $ difference (the execution gap)
- Support: EOAs, EIP-7702 accounts, Smart Contract Wallets (Safe)
- For SCWs: decode inner calldata to identify the actual DeFi operation
- Show total $ lost over the analysis window

### Filtering (what NOT to simulate)
Exclude transactions that can't be affected by the execution gap:
- Pure ETH transfers
- ERC-20/721/1155 transfers and approvals (current blacklist)
- Governance votes
- Staking deposits/withdrawals
- Pure WETH wrap/unwrap
- For Smart Contract Wallets: apply filtering to the decoded inner call, not the outer execTransaction

### Results
- Total $ lost (the headline number)
- Top 3 transactions with highest individual loss:
  - Protocol address (contract, no name resolution needed)
  - Amount lost in $
- Leaderboard: all wallets previously analyzed, ranked by total loss
  - Populated organically from user queries
  - Real data only — no fabricated columns

### Wallet Support
- EOAs: direct transaction analysis (current implementation)
- Safe multisig: decode `execTransaction` to extract inner call, simulate that
- EIP-7702: handle delegated execution, identify the delegate contract

## What's Out
- Sandwich detection / MEV attribution (cut — total gap is what matters)
- IntentGuard branding or CTAs
- Multi-chain (Ethereum only)
- Real-time monitoring (batch analysis)
- Protocol name resolution (address is enough)
- Exportable reports (PDF/CSV)
- Historical trending / charts
- Pre-populated curator wallets on the leaderboard

## Non-Goals
- This is not a security scanner
- This is not an MEV dashboard
- This is not a portfolio tracker
- This does not attribute losses to specific causes — it measures the total gap

## Current State (as of session)

### Working
- Pipeline: fetch → filter → mempool resolve → simulate → delta → price → aggregate
- Results page renders correctly via analyze flow
- Leaderboard loads
- Rate limiters tuned to actual API limits
- HR-1 through HR-9 implemented
- Blueprints scaffolded and baselined

### Broken / Missing
1. No-jobId navigation: leaderboard clicks → infinite spinner (10-line fix)
2. Dune failure crashes pipeline instead of falling back to heuristic
3. Fabricated leaderboard columns ("Slippage", "Last hit") — must remove
4. Sandwich detection imported but never called — remove dead code
5. Token decimals hardcoded to 18 (HR-8 pending) — USDC/USDT gaps wrong by 10^12
6. No Smart Contract Wallet support (Safe, 7702)
7. Filtering doesn't cover governance, staking, WETH wraps
8. No SCW calldata decoding for filtering

### Priority Order
1. Accuracy fixes (HR-8 decimals, fix broken flows)
2. Remove fabricated data and dead code
3. Expand filtering (governance, staking, wraps)
4. Smart Contract Wallet support (Safe decode, 7702)
