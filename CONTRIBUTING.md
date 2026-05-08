# Contributing

Thanks for considering a contribution. This is a small CLI tool — there's no formal RFC process or governance structure. The bar is "would this be useful to other people running the CLI?"

## Quick start for contributors

```bash
git clone <repo-url>
cd <repo-dir>
npm install
cp .env.example .env       # fill in your API keys
npm run typecheck          # confirm TypeScript is happy
npm run tx:run -- --help   # confirm the CLI runs
```

## Before you open a PR

1. **`npm run typecheck`** — TypeScript must pass with zero errors. This is the only required check today (no test suite exists yet — see *Wanted contributions* below).
2. **`npm run lint`** — ESLint should produce no errors.
3. **Smoke-test the affected mode** with at least one real transaction:
   - `tx:run` change → run against a recent tx from Etherscan and verify the report is sensible.
   - `wallet:run` change → run against your own wallet (or a public address like `0xd8da6bf26964af9d7eed9e03e53415d37aa96045`).
   - `protocol:run` change → run with `--window-minutes 10 --limit 20`.
   - Also run with `--debug` and confirm the step-by-step log still makes sense.
4. **No new lockfile churn.** If you don't need a new dependency, don't add one. The current footprint is 4 runtime deps + 4 dev deps, and we'd like to keep it small.
5. **No secrets in commits.** `.env` is gitignored; do not commit fixtures or screenshots that include keys.

## Code conventions

- **TypeScript strict mode**, BigInt for token amounts, file-based caching only (no DB).
- **HR rules** (Hardened Rules) are inline as comments in the source — they document constraints that came from real production bugs. If you see `HR-1`, `HR-6`, etc. in a comment, it means there's a non-obvious reason for the line; don't "simplify" it without understanding why.
- **No `any`** unless you're quoting an external API response shape and immediately narrowing it.
- **Logging style**: bracket-prefixed module tags, e.g. `[cli] ...`, `[tenderly] ...`, `[dune] ...`. Use `[debug:N.step]` (e.g. `[debug:3.sim]`) for step-by-step traces gated on `--debug`.
- **No `console.log` in pricing/math hot paths** — only at module boundaries (start/end of a step) so high-cardinality runs stay readable.
- **Cache writes** must happen on the cache-miss path only. Cache hits never trigger an API call or a write.

## Commit messages

We use multi-paragraph commits when the change has multiple touching points. The style is:

```
<short imperative subject, ≤ 72 chars>

<context paragraph: what changed and why, in plain English>

<bullet list of concrete touched files / behavior, optional>
```

The subject line should describe the *behavior change*, not the implementation detail (good: `Switch expected-sim to earliest-valid walk`; bad: `Update _core.ts`).

## How to add a new protocol to `protocol:run`

Today only Uniswap V2 is supported. To add another protocol:

1. **Add the router address** to `lib/constants.ts` (`DEX_ROUTERS` and a constant like `UNISWAP_V3_ROUTER_ADDRESS`).
2. **Write a calldata decoder** at `lib/analysis/<protocol>-decoder.ts` that takes a `ProtocolTxRow` and returns a typed decoded swap (mirroring `lib/analysis/univ2-decoder.ts`).
3. **Wire the decoder** into `cli/protocol-run.ts`'s decode loop. Branch on the router address or method selector.
4. **Confirm `evaluateSwap` works** with the new decoded shape — `evaluateSwap` is currently UniV2-typed (`DecodedUniV2Swap`); generalizing the type or adding a parallel evaluator is part of the work.
5. **Smoke-test** with `--window-minutes 10 --limit 20` against the new router.

For an arbitrary single tx on any protocol, `tx:run` already works — it doesn't decode anything, it just diffs `asset_changes` between the two sims. That's usually the easier path to support a one-off protocol.

## Wanted contributions

If you're looking for somewhere to start:

- **Test suite.** There is none. A small `vitest` suite for `cli/_core.ts` (especially `bigintRatioPercent`, `rawToUsd`, the walk loop logic) and the UniV2 decoder would be valuable.
- **Multi-token support in `protocol:run`.** Today the protocol mode hard-codes `tokenIn` / `tokenOut` from the UniV2 decode. The canonical multi-token diff used by `tx:run` and `wallet:run` doesn't have this limitation — porting it to protocol mode would catch fee-on-transfer / rebase / multi-hop edge cases that UniV2 decode misses.
- **More protocol decoders.** Uniswap V3, Curve, Balancer, 1inch, CoW Protocol — see *How to add a new protocol* above.
- **Better unpriced-token UX.** Today unpriced tokens drop silently from the USD aggregate. A summary line like "3 tokens unpriced (combined raw amount …)" would make this less invisible.
- **Block-history bound** for `wallet:run`. Today it pulls Etherscan's full window; a `--from-block` / `--to-block` option would let users analyze a specific range.

## What's out of scope

- **Web frontend.** The CLI deliberately does not bundle a UI. A previous web-app version exists privately; if you want a UI, build it on top of the JSON output files (`reports/*-runs/*.json`) — the schema is stable and versioned.
- **Persisting results to a database.** `lib/db.ts` is intentionally a file-based cache with no result tables. If you want long-term storage, write a downstream tool that reads the JSON output files.
- **Non-Ethereum chains.** The Etherscan / Tenderly / Dune integrations are mainnet-only today. L2 support is a larger architectural change (different chain IDs, different mempool data sources, different block times for the walk arithmetic).

## Reporting issues

Please include:

- The CLI command you ran (with `--debug` if reproducible).
- The first ~30 lines of stdout, including the `[debug:*]` log lines if applicable.
- The transaction hash or wallet address, when relevant.
- Whether it's reproducible after `rm -rf .cache/` (to rule out stale-cache issues).

## License

By contributing, you agree your contribution is licensed under the MIT License (see [LICENSE](LICENSE)).
