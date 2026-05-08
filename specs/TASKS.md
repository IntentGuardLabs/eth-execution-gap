# Tasks

Ordered by priority. Top = next.

Last updated: 2026-04-11

## In Progress

_none_

## Ready

### Phase 1: Accuracy & Reliability

1. **Fix decimals hardcoded to 18** (EC-6b.1 → HR-8)
   Files: calculator.ts, tenderly.ts, 02-data-contracts.md
   ✓ when: USDC (6 decimals) gap shows correct USD value, not 10^12x off

2. **Fix no-jobId navigation**
   Files: app/results/[address]/page.tsx
   ✓ when: clicking a leaderboard row loads results without infinite spinner

3. **Dune failure fallback**
   Files: pipeline.ts
   ✓ when: pipeline completes with heuristic block numbers when Dune is down

4. **Remove fabricated leaderboard columns**
   Files: leaderboard component
   ✓ when: no "Slippage" or "Last hit" columns, only real data (Rank, Wallet, Total Loss)

5. **Remove sandwich detection dead code**
   Files: pipeline.ts, sandwich.ts
   ✓ when: no imports of detectSandwiches, no sandwich.ts file, isSandwiched column removed or always null

### Phase 1b: Caching & Persistence

6. **Implement incremental tx fetching**
   Files: txFetcher / etherscan data source, 05-database-schema.md
   For a wallet, store the highest block number already fetched in DB.
   On re-scan: fetch only from `lastBlock + 1` to `latest`, merge with existing.
   ✓ when: re-analyzing a wallet after a week only fetches new txs, not all 180 days

7. **Cache simulation results (immutable)**
   Files: txSimulator / tenderly data source, cache utility, 05-database-schema.md
   Key: `txHash:blockNumber` → simulation result. TTL: forever (deterministic).
   Before calling Tenderly, check DB. On hit, skip API call.
   ✓ when: re-analyzing a wallet with 50 cached simulations makes 0 Tenderly calls for those 50

8. **Cache mempool lookups (immutable)**
   Files: mempoolResolver / dune data source, 05-database-schema.md
   Key: `txHash` → mempool entry. TTL: forever (historical).
   ✓ when: re-analysis doesn't re-query Dune for already-resolved tx hashes

9. **Cache historical prices (immutable)**
   Files: priceResolver / defillama data source, 05-database-schema.md
   Key: `tokenAddress:timestamp` → price. TTL: forever.
   ✓ when: re-analysis with same tokens doesn't re-call DeFiLlama

10. **Fix re-analysis duplication (EC-7b)**
    Files: pipeline.ts, prisma schema
    Use `upsert` instead of `create` for raw Etherscan and Dune data.
    ✓ when: re-running same wallet doesn't create duplicate rows

### Phase 2: Filtering Refinement

11. **Add governance vote filter**
   Common selectors: `castVote`, `castVoteWithReason`, `propose`
   ✓ when: governance txs excluded from simulation

12. **Add staking filter**
   Common selectors: `deposit`, `stake`, `withdraw` on known staking contracts
   ✓ when: pure staking txs excluded from simulation

13. **Add WETH wrap/unwrap filter**
   WETH contract: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`
   Selectors: `deposit()` (0xd0e30db0), `withdraw(uint256)` (0x2e1a7d4d)
   ✓ when: WETH wrap/unwrap excluded from simulation

14. **Check if `to` is a contract — skip simulation for EOA-to-EOA calls with calldata**
   ✓ when: txs sent to EOAs (even with calldata) are excluded

### Phase 3: Smart Contract Wallet Support

15. **Safe execTransaction decoding**
    Selector: `0x6a761202` (execTransaction)
    Decode inner `to` + `data` from the calldata, apply filtering to the inner call
    ✓ when: Safe vault txs are correctly filtered and simulated based on inner operation

16. **EIP-7702 delegate detection**
    Detect delegated execution, identify the delegate contract, apply filtering to the delegated call
    ✓ when: 7702 txs are correctly filtered and simulated

17. **Results work for SCWs**
    The gap calculation uses the inner call's asset changes, not the outer wrapper
    ✓ when: Safe wallet shows accurate per-tx gaps for inner DeFi operations

## Done

- [x] HR-1 through HR-7 (original hardened rules)
- [x] HR-9 (native ETH flows)
- [x] Blueprint scaffolding (all 6 baselined)
- [x] Blueprint review (10 findings resolved)
- [x] Rate limiter tuning (Etherscan 3/sec, Tenderly 6.7/sec)
- [x] Tenderly hex format investigation (in progress)
