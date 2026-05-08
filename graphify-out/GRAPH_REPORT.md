# Graph Report - .  (2026-04-11)

## Corpus Check
- Corpus is ~13,605 words - fits in a single context window. You may not need a graph.

## Summary
- 89 nodes · 121 edges · 12 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `RateLimiter` - 6 edges
2. `JobQueue` - 5 edges
3. `calculateGaps()` - 4 edges
4. `detectSandwichAttack()` - 4 edges
5. `isValidEthereumAddress()` - 3 edges
6. `GET()` - 2 edges
7. `generateShareCard()` - 2 edges
8. `normalizeAddress()` - 2 edges
9. `truncateAddress()` - 2 edges
10. `sleep()` - 2 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities

### Community 0 - "Utils & Helpers"
Cohesion: 0.14
Nodes (5): isValidEthereumAddress(), normalizeAddress(), retryWithBackoff(), sleep(), truncateAddress()

### Community 1 - "Pipeline & Data Sources"
Cohesion: 0.17
Nodes (4): getMempoolDataForTx(), queryMempoolData(), fetchWalletTransactions(), getLatestBlockNumber()

### Community 2 - "Database Layer"
Cohesion: 0.15
Nodes (0): 

### Community 3 - "API Routes & Job Queue"
Cohesion: 0.24
Nodes (3): JobQueue, generateShareCard(), GET()

### Community 4 - "Rate Limiter"
Cohesion: 0.38
Nodes (1): RateLimiter

### Community 5 - "Price Calculator"
Cohesion: 0.53
Nodes (4): batchGetTokenPrices(), calculateGaps(), categorizeGapType(), gapToUsd()

### Community 6 - "Tenderly Simulation"
Cohesion: 0.4
Nodes (2): computeNetTokenFlows(), getTokenOutputFromChanges()

### Community 7 - "Sandwich Detection"
Cohesion: 0.7
Nodes (4): detectSandwichAttack(), detectSandwiches(), interactsSamePool(), isDexSwap()

### Community 8 - "Landing Page UI"
Cohesion: 0.5
Nodes (0): 

### Community 9 - "Root Layout"
Cohesion: 1.0
Nodes (0): 

### Community 10 - "Next.js Types"
Cohesion: 1.0
Nodes (0): 

### Community 11 - "Next.js Config"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **Thin community `Root Layout`** (2 nodes): `layout.tsx`, `RootLayout()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Next.js Types`** (1 nodes): `next-env.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Next.js Config`** (1 nodes): `next.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Should `Utils & Helpers` be split into smaller, more focused modules?**
  _Cohesion score 0.14 - nodes in this community are weakly interconnected._