# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-08

Initial public CLI release. The web-app version of this tool lives privately.

### Added — validated

- `tx:run` — analyze a single Ethereum transaction's execution gap by hash. **Smoke-tested end-to-end with real txs in this release.**
- Earliest-valid simulation walk (used by `tx:run`): starting from the mempool block (resolved via `dune.flashbots.dataset_mempool_dumpster`), step forward one block at a time until Tenderly returns a non-reverting simulation. The first valid block is used as the "expected" baseline.
- Actual-position inclusion simulation: uses the tx's real on-chain `transactionIndex` so the comparison reproduces the exact execution context.
- Per-token signed-USD gap aggregation with a `%` and dollar breakdown per token, plus a single `net gap (USD)` total per tx.
- `--debug` mode emits step-by-step `[debug:N.step]` log lines at every stage of the canonical core (fetch, mempool, sim walk, flow extraction, diff, pricing, aggregate).
- Local file-based caches for Tenderly simulations, Dune mempool data, Dune protocol-tx queries, and DeFiLlama prices. Re-runs of the same target are mostly free.
- WARN logs when a tx is missing from the Flashbots dumpster or when a Tenderly simulation reverts at an intermediate block during the walk.
- Public-facing repository scaffolding: README, CONTRIBUTING, SECURITY, LICENSE (MIT), `.env.example`, GitHub issue and PR templates, CI workflow.

### Added — experimental (not validated end-to-end in v0.1.0)

- `wallet:run` — analyze a wallet's recent simulatable transactions in a single batch. Code is wired up and reuses the same `_core.ts` as `tx:run`, but the orchestrator itself was not smoke-tested against a real wallet before release. Treat output skeptically.
- `protocol:run` — analyze recent Uniswap V2 router activity over a configurable window. Uses a separate evaluator that does **not** yet share the earliest-valid walk used by the other two modes (both sims run at index 0 of their blocks). Functional in earlier sessions but not re-validated after the v0.1.0 algorithm changes.
- `tx:run --user <addr>` flag for tracking flows of an address other than the tx sender. Implemented but not validated with a real override.

### Known limits (carried forward, see README "Limits and known issues")
- `wallet:run` is bounded by `ANALYSIS_WINDOW_DAYS` and Etherscan's `page * offset <= 10000` rule.
- Private bundles and Flashbots-relayed txs do not appear in the Dune dumpster; mempool-block resolution falls back to `inclusion - 1` for those.
- `protocol:run` only understands Uniswap V2 router calldata. Other protocols can be analyzed per-tx via `tx:run`.

[Unreleased]: https://github.com/<owner>/<repo>/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/<owner>/<repo>/releases/tag/v0.1.0
