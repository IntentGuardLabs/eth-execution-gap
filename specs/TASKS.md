# Tasks

Ordered by priority. Top = next.

Last updated: 2026-04-12

## In Progress

_none_

## Ready

### Phase 5: Failed Transaction Analysis

18. **Stop filtering failed DeFi txs**
    Files: filter.ts, pipeline.ts
    Currently `isError === "1"` txs are dropped. Instead: keep failed txs with DeFi selectors.
    Tag them as `failed: true` in the pipeline. Apply same filtering blacklist (skip failed
    transfers, failed approvals — only keep failed swaps/liquidity/lending calls).
    ✓ when: failed DeFi txs appear in pipeline output with `failed: true` flag

19. **Simulate failed txs at mempool block only**
    Files: pipeline.ts, tenderly data source
    Failed txs need ONE simulation (at mempool block) — we already know the actual outcome
    (reverted, zero output). Simulate at mempool block to confirm the tx WOULD have succeeded
    when the user signed it. IMPORTANT: if the mempool simulation ALSO fails, this is a user
    error (bad allowance, wrong params, etc.) — protection would NOT have helped. Only count
    txs where mempool sim = success, actual execution = revert.
    ✓ when: failed tx shows "expected output: $X, actual: reverted" with only 1 sim call
    ✓ when: failed txs that also fail at mempool block are excluded from the "preventable" count

20. **Calculate gas wasted on failed txs**
    Files: calculator.ts
    For each preventable failed tx: `gasUsed * gasPrice` = ETH wasted. Price via DeFiLlama.
    Aggregate: total gas $ wasted on preventable failed DeFi txs in the window.
    ✓ when: results show "Gas wasted on failed transactions: $X"

21. **Failed tx results display**
    Files: results component
    Show on results page:
    - Count of preventable failed DeFi txs (mempool sim succeeded, execution reverted)
    - Total gas wasted in $
    - For multisig wallets (detected as Safe): estimated time wasted (N × ~10 min signing)
    - "Pre-submission simulation would have prevented N failed transactions"
    ✓ when: results page shows failed tx summary alongside the execution gap

### Phase 6: Anvil Migration

22. **Anvil fork wrapper**
    Build a Node.js wrapper that spawns Anvil, forks at a given block, sends a tx, collects
    results, and kills the process. Interface matches the existing Tenderly simulator's
    input/output contract so it's a drop-in replacement.
    `spawnAnvil(rpcUrl, blockNumber) → { sendTx(tx) → receipt, kill() }`
    ~50 lines. Needs archive node RPC (Alchemy free tier to start).
    ✓ when: wrapper can fork, simulate a tx, and return a receipt

23. **Transfer event parser (replaces Tenderly asset_changes)**
    Parse ERC-20 Transfer events from tx receipt logs:
    - Filter topic `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`
    - `topic[1]` = from, `topic[2]` = to, `data` = amount, emitting contract = token
    - Aggregate into net flows per address per token (same shape as `computeNetTokenFlows`)
    - For native ETH: diff balance before/after tx, or trace internal calls
    - Skip ERC-721 (topic has tokenId not amount) — same as current HR-9 skip logic
    ~50-100 lines, reusable across all phases.
    ✓ when: parser produces identical net flows to Tenderly asset_changes for test txs

24. **Replace Tenderly with Anvil in core pipeline**
    Swap the simulation step: instead of calling Tenderly API, use Anvil wrapper + Transfer
    parser. Keep Tenderly as optional fallback (config flag).
    Update blueprints: `03-api-contracts/tenderly.md` → mark as fallback only.
    Update CLAUDE.md: Tenderly rules become Anvil rules.
    ✓ when: full pipeline runs without any Tenderly API calls
    ✓ when: results match Tenderly results for a test wallet (compare gap values)

25. **Remove Tenderly rate limiter dependency**
    With Anvil, no external rate limiting needed for simulations. Remove or reduce Tenderly
    rate limiter config. Keep Etherscan/Dune/DeFiLlama rate limiters unchanged.
    ✓ when: no Tenderly rate limit waits in pipeline execution

### Phase 7: Protection Savings Simulation

Full spec: `specs/features/protection-savings-simulation.md`

26. **Sandwich detection**
    Fetch per-block tx lists via `cast block` or Etherscan. Identify frontrun/backrun pairs.
    Handle multi-victim sandwiches (Bloxroute patterns).
    ✓ when: sandwiched txs are correctly identified and flagged

27. **Scenario A savings: non-sandwiched txs**
    For each non-sandwiched tx with a gap, simulate at inclusion block with tighter `amountOutMin`.
    Test at 0.5%, 1%, 2% tolerance. Use Anvil (free, no limits).
    ✓ when: protection table shows accurate blocked count and $ saved for non-sandwiched txs

28. **Scenario B savings: sandwiched txs (Anvil block replay)**
    Fork block N-1 with Anvil. Replay block N without sandwich txs.
    Insert modified victim tx with tighter slippage. Use Transfer event parser for asset changes.
    ✓ when: protection table includes sandwich victims with accurate counterfactual savings

29. **Protection savings results UI**
    Show protection levels table on results page.
    Total saved per level. Count of blocked txs per level.
    ✓ when: user sees protection levels table with accurate $ saved per threshold

## Done

- [x] **Phase 1b: Caching & Persistence** (all 5 tasks)
  - [x] Task 6: Incremental tx fetching (lastFetchedBlock on WalletAnalysis, startBlockOverride, staleness-based re-analysis)
  - [x] Task 7: Simulation cache (getCachedSimulation checks TenderlySimulationRaw before API call)
  - [x] Task 8: Mempool cache (getCachedMempoolData filters resolved hashes, only queries Dune for new ones)
  - [x] Task 9: Price cache (PriceCache model, getCachedPrices/storePrices, DeFiLlama only for uncached tokens — current prices, upsert on re-analysis)
  - [x] Task 10: Fix re-analysis duplication (upsert with @@unique constraints on EtherscanTxRaw, DuneMempoolRaw)
- [x] **Phase 1: Accuracy & Reliability** (all 5 tasks)
  - [x] Task 1: Fix decimals hardcoded to 18 (EC-6b.1 → HR-8)
  - [x] Task 2: Fix no-jobId navigation (split useEffect for direct fetch vs polling)
  - [x] Task 3: Dune failure fallback (try/catch in pipeline, empty map fallback)
  - [x] Task 4: Remove fabricated leaderboard columns (Slippage 0.28x, Last hit)
  - [x] Task 5: Remove sandwich detection dead code (sandwich.ts deleted, import removed)
- [x] **Phase 3: Smart Contract Wallet Support** (all 3 tasks)
  - [x] Task 15: Safe execTransaction decoding (filter.ts — inner call decode + blacklist) — done prior
  - [x] Task 16: EIP-7702 delegate detection (bypass EOA filter for DEX selectors via KNOWN_DEX_SELECTORS)
  - [x] Task 17: SCW flow extraction (getEffectiveWallet uses tx.to for Safe txs, tx.from for EOAs)
- [x] HR-1 through HR-7 (original hardened rules)
- [x] HR-8 (actual token decimals from Tenderly)
- [x] **Phase 2: Filtering Refinement** (all 4 tasks)
  - [x] Task 11: Governance filter (castVoteWithReason, castVoteBySig, propose + 4 governor contracts)
  - [x] Task 12: Staking filter (stake/unstake/join selectors + ETH2 Deposit, pufETH contracts)
  - [x] Task 13: WETH contract added to EXCLUDED_CONTRACTS (selectors already existed)
  - [x] Task 14: EOA check via batchCheckContracts(eth_getCode), skip simulation for EOA recipients
- [x] HR-9 (native ETH flows)
- [x] Task 15: Safe execTransaction decoding (filter.ts — inner call decode + blacklist)
- [x] Blueprint scaffolding (all 6 baselined)
- [x] Blueprint review (10 findings resolved)
- [x] Rate limiter tuning (Etherscan 3/sec, Tenderly 6.7/sec)
- [x] Tenderly simulation_type: "full" + hex format documented
