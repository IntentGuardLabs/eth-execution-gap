# Execution-Gap CLI

A command-line analyzer for Ethereum transactions. It measures the **execution gap**: the difference between what a transaction *would have done* if executed at the moment it entered the mempool, and what it *actually did* at the position it landed on-chain. The gap is reported per token and aggregated to a signed dollar amount.

Runs entirely locally — no database, no web server, no service to deploy. All caches are JSON files under `.cache/`.

```
gap_per_token  = (actual_net − expected_net) × token_price_usd
gap_total      = Σ gap_per_token over all tokens touched
```

**Negative `gap_total`** = user lost USD relative to simulation. **Positive** = favorable slippage. Tokens DeFiLlama can't price are reported in raw amounts only and excluded from the dollar total.

---

## ⚠️ Status

**Early development. Use at your own risk.**

- This is `v0.1.0`. The output schema, command-line flags, and underlying gap algorithm are still evolving — breaking changes between minor versions are expected until `1.0.0`.
- **Of the three modes, only `tx:run` has been validated end-to-end with real transactions in this release.** `wallet:run` and `protocol:run` ship as **experimental** — the code is in place and type-checks, but they have not been smoke-tested against real inputs in v0.1.0. See the table in [Modes](#modes) below for the per-command status.
- The reported gap is a *simulation-based estimate*. It depends on third-party APIs (Etherscan, Dune, Tenderly, DeFiLlama) being correct, available, and rate-limit-permitting. Any of them can return stale, partial, or wrong data; the CLI tries to surface this with WARN logs but cannot guarantee detection of every edge case.
- **Not financial advice.** Do not rely on the dollar numbers for trading, accounting, tax, or legal purposes.
- Bugs are expected. If a number looks wrong, run with `--debug`, file an issue with the reproduction tx hash, and treat the report skeptically until verified.
- The MIT [LICENSE](LICENSE) provides this software *"AS IS, WITHOUT WARRANTY OF ANY KIND"*.

---

## Modes

The CLI ships three commands. They share the same canonical core (mostly): earliest-valid expected simulation, actual-position inclusion simulation, multi-token net-flow diff, DeFiLlama pricing, signed-USD aggregation. They differ in *which* transactions they analyze and in **maturity**.

| Command | What it analyzes | Status |
|---|---|---|
| `tx:run` | A single transaction by hash. Smallest, fastest, easiest to debug. | **Validated** in v0.1.0 — primary tested path. |
| `wallet:run` | A wallet's recent transactions. Filters out transfers, approvals, and other no-gap txs, then runs the canonical core for each remaining tx. | **Experimental** — orchestration code exists and reuses the same `_core.ts` as `tx:run`, but the wallet flow itself has not been smoke-tested with a real wallet in v0.1.0. Expect rough edges. |
| `protocol:run` | All transactions sent to a protocol router (Uniswap V2 only today). Decodes UniV2 swap calldata and evaluates each swap. | **Experimental** — uses a separate evaluator (`evaluateSwap` in `lib/analysis/protocol-pipeline.ts`) that does *not* yet share the earliest-valid walk used by the other two modes. Functional but not at parity. |

If you're using the CLI in anger today, prefer `tx:run` and report bugs against the experimental modes — see CONTRIBUTING.md.

---

## How the simulation works

For each transaction:

1. **Fetch tx** from Etherscan (`eth_getTransactionByHash`).
2. **Resolve mempool block** from the Flashbots dumpster on Dune (`dune.flashbots.dataset_mempool_dumpster`). On a miss the CLI falls back to `inclusion - 1` and emits a WARN.
3. **Earliest-valid expected sim** — walk forward one block at a time from the mempool block to the inclusion block, simulating at the head of each block (`transaction_index = 0`). The first block where Tenderly returns `status = true` (no revert) is the earliest moment the tx would have been valid; that simulation is the *expected* outcome. Reverts at intermediate blocks usually mean the user's setup tx (approval, balance change, pool init) hadn't landed yet — we don't try to interpret the revert reason, just keep walking.
4. **Actual sim** at `inclusion_block` and the tx's real `transactionIndex` (so we reproduce the exact on-chain execution context).
5. **Per-token diff**: for every token that appears in either sim's `asset_changes`, compute `actual_net - expected_net`. Positive means the user got more of that token than the expected sim predicted.
6. **Pricing**: DeFiLlama batch-prices the tokens we have addresses for. Unpriced tokens stay raw and are flagged.
7. **USD aggregate**: sum of priced per-token diffs. Negative = the user lost dollars on this swap.

The walk is the key trick. If we used "mempool block, head" naively, transactions that depended on the user's own setup tx in the same block (multicall, approve+swap, Permit2-style flows) would show a revert and a meaningless gap. The walk finds the first state where the tx is actually executable and uses that as the comparison baseline — which is the more honest definition of "what the user expected."

---

## Setup

### Requirements

- **Node.js 22+** (current Maintenance LTS; the CLI uses `tsx` to run TypeScript with no build step). The project ships an `.nvmrc` you can `nvm use` against.
- API keys for: **Etherscan**, **Dune**, **Tenderly**. DeFiLlama is keyless. Free tiers are sufficient — see [Dependencies](#dependencies) below for what each service is used for and the quotas to expect.

### Install

```bash
git clone <repo-url>
cd <repo-dir>
npm install
```

### Configure

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

```env
ETHERSCAN_API_KEY=...     # https://etherscan.io/myapikey
DUNE_API_KEY=...          # https://dune.com/settings/api
TENDERLY_ACCOUNT=...      # your Tenderly account slug
TENDERLY_PROJECT=...      # your Tenderly project slug
TENDERLY_API_KEY=...      # https://dashboard.tenderly.co (Settings → Authorization)
```

The CLI loads `.env` automatically via `dotenv`. No other configuration is needed.

### Verify

```bash
npm run typecheck
npm run tx:run -- --help
```

---

## Usage

### Single transaction

```bash
# Analyze one tx
npm run tx:run -- --tx 0xb71da98f1882063ad9e077ac269a89215c58d569ac32afb108852d9fc010533f

# With step-by-step debug logs
npm run tx:run -- --tx 0x... --debug

# Override the user (track flows for a different address than the tx sender).
# The flag is implemented but has not been validated with a real override
# in v0.1.0 — file an issue if it produces unexpected results.
npm run tx:run -- --tx 0x... --user 0xabc...

# Custom JSON detail path
npm run tx:run -- --tx 0x... -o ./my-tx.json

# Force fresh sims, ignore the local Tenderly cache
npm run tx:run -- --tx 0x... --no-cache
```

### Wallet (experimental)

> ⚠️ This mode is **experimental in v0.1.0** — the code is wired up but has not been validated end-to-end against a real wallet. Treat the output skeptically and report bugs.

```bash
# Analyze the wallet's most recent simulatable txs (default top 50)
npm run wallet:run -- --address 0xb86d0701... --debug

# Smaller batch
npm run wallet:run -- -a 0xb86d... --limit 10
```

The wallet command pulls Etherscan tx history (recent ~10k txs, capped by `ANALYSIS_WINDOW_DAYS` in `lib/constants.ts`), drops the no-gap ones (ERC-20 transfers, approvals, contract creations, failed txs, known no-gap protocols), and runs the canonical gap evaluation on the top `--limit` remaining.

### Protocol (experimental)

> ⚠️ This mode is **experimental in v0.1.0**. It uses a separate evaluator (`evaluateSwap` in `lib/analysis/protocol-pipeline.ts`) that does **not** yet share the earliest-valid sim walk used by `tx:run` and `wallet:run` — both sims run at index 0 of their respective blocks, no walk. Some early swap-mode runs were sanity-checked but the mode has not been re-validated after the v0.1.0 algorithm changes.

```bash
# Analyze the last 10 minutes of Uniswap V2 router activity
npm run protocol:run -- --window-minutes 10 --limit 50

# Verbose per-swap log
npm run protocol:run -- --window-minutes 10 -v
```

The protocol command queries Dune for all txs sent to the Uniswap V2 Router02 inside the requested window, decodes each one as a `swap*` call, and runs the gap math on the decoded `tokenIn` / `tokenOut`. For a multi-token view of any single tx, use `tx:run` on that hash directly.

### Common flags

| Flag | Modes | Purpose |
|---|---|---|
| `--debug, -d` | tx, wallet | Emit `[debug:N.step]` log lines at every stage of the canonical core (tx fetch, mempool resolution, walk, sim, flow extraction, diff, pricing, aggregate). Use this when the report value looks wrong. |
| `--no-cache` | all | Skip the Tenderly simulation cache. Forces fresh sims. Dune and DeFiLlama caches are still consulted. |
| `-o, --output <path>` | all | Where to write the full JSON detail. Defaults under `reports/<command>-runs/`. |
| `--help, -h` | all | Show usage. |

---

## Output

Every run prints a summary table to stdout and writes a full JSON detail file. The JSON files carry a `schema` field (e.g. `wallet-run-cli@1.0`) so downstream tooling can grep by command + version.

Example `tx:run` summary:

```
────────────────────────────────────────────────────────────────────────
 Single-tx execution-gap report
────────────────────────────────────────────────────────────────────────
 tx                : 0x010b2612eae09ab6e41a413010378e2d31e325ec37f704c4887bd0795eba67b9
 user              : 0xd8da6bf26964af9d7eed9e03e53415d37aa96045
 inclusion block   : 24993038    mempool block: 24993037
 expected sim      : block 24993038#0  —  valid only at block 24993038 (after 2 walk attempts)
 simulation status : ok
 tokens touched    : 3  (0 unpriced)
 net gap (USD)     : −$8.67  (user lost)
 duration          : 12.8s
────────────────────────────────────────────────────────────────────────

 Per-token breakdown:
  symbol     expected (raw)        ($)         actual (raw)          ($)         diff (raw)            (%)        ($)
  XDB             −26544.2415          —            −26544.2415         —                     0       0.00%      $0.00
  weth                      0          —                       0         —                     0        —          $0.00
  ETH                0.005746     +$13.20           0.001971     +$4.53        −0.003775     −65.71%     −$8.67
```

Sign convention recap:
- Token raw `expected` / `actual`: positive = user received that token, negative = user sent it.
- Token raw `diff` = `actual − expected`. Negative = user got worse on this token.
- Token `USD` = `diff × price`. Negative = user lost dollars on this token.
- Total `net gap` = Σ token USDs. Negative = user net loss.

---

## Debugging

When a number looks wrong, run the same command with `--debug`. You'll see, per analyzed transaction:

```
[debug:1.fetch]    txHash=0x... (etherscan lookup)
[debug:1.fetch]    from=0x... to=0x... value=... blockNumber=24993038
[debug:2.mempool]  resolving mempool block for inclusion=24993038
[debug:2.mempool]  mempoolBlock=24993037 (from Dune dumpster)
[debug:3.sim]      expected-sim walk: blocks 24993037..24993038 (head of each); actual sim at 24993038#5; cache=on
[debug:3.sim]      expected-sim walk: block 24993037 reverted (TransferHelper: TRANSFER_FROM_FAILED), advancing
[debug:3.sim]      expected-sim walk found a valid block: 24993038 (after 2 attempts)
[debug:3.sim]      simulationStatus=ok
[debug:4.flows]    expected (mempool): 1 non-zero token flows for user
[debug:4.flows]    actual   (inclusion): 1 non-zero token flows for user
[debug:5.diff]     union of touched tokens: 3
[debug:6.price]    priced 2/3, 1 unpriced
[debug:7.aggregate] totalGapUsd=-8.668000 (user lost); unpricedTokens=1
```

Each step's label is stable (`1.fetch`, `2.mempool`, `3.sim`, `4.flows`, `5.diff`, `6.price`, `7.aggregate`) so you can grep for one stage across a multi-tx run.

---

## Caches

Everything is on the local filesystem under `.cache/`:

```
.cache/
  tenderly/{txHash}_{block}_i{index}.json     # immutable per (tx, block, index)
  dune/mempool/{txHash}.json                   # immutable per tx
  dune/protocol/{router}.json                  # router-scoped tx list (TTL 30 min)
  dune/protocol/{router}.fetched-at.json       # TTL marker
  prices/{token}.json                          # DeFiLlama prices (TTL 1 hour)
```

Re-running the same command is mostly free for everything cached on the first run. Tenderly is the dominant cost; once a `(tx, block, index)` triple is cached it never expires (sims at a fixed position are deterministic).

To wipe the cache: `rm -rf .cache/`. Override the cache directory with `CLI_CACHE_DIR=...` in your `.env`.

---

## Dependencies

The CLI is intentionally small. It talks to four external services and pulls a handful of npm packages.

### External services

All four are queried over HTTPS through `lib/data-sources/`. Each call goes through `lib/rate-limiter.ts` to keep us inside free-tier limits — see [API_RATE_LIMITING.md](API_RATE_LIMITING.md) for the configured limits.

| Service | What it's used for | Auth | Free tier | Required by |
|---|---|---|---|---|
| **[Etherscan](https://etherscan.io/myapikey) v2 API** | `eth_getTransactionByHash` for single-tx mode; wallet tx history (`account.txlist`) for wallet mode; `eth_blockNumber` for the analysis-window math. | `ETHERSCAN_API_KEY` | 3 req/sec, 100k req/day | `tx:run`, `wallet:run` |
| **[Dune Analytics](https://dune.com/settings/api)** | Flashbots `dataset_mempool_dumpster` lookup — gives us the block at which the tx was first seen in the mempool, used as the *start of the earliest-valid sim walk*. Also drives the router-scoped tx query for `protocol:run`. | `DUNE_API_KEY` | 2,500 credits/month | `tx:run` (metadata + walk start), `wallet:run`, `protocol:run` |
| **[Tenderly](https://dashboard.tenderly.co/)** | Transaction simulation via `POST /v1/account/{account}/project/{project}/simulate` with `simulation_type: "full"` — returns full `asset_changes` per side. We pass an explicit `block_number` and `transaction_index` to control the simulation context (head-of-block for the walk, real on-chain index for the actual sim). | `TENDERLY_ACCOUNT` + `TENDERLY_PROJECT` + `TENDERLY_API_KEY` | 50 req/min on free; ~120k sims/month on dev plans | All three modes |
| **[DeFiLlama](https://defillama.com/docs/api)** | Batch token pricing: `GET coins.llama.fi/prices/current/{ethereum:0x...,ethereum:0x...,...}`. Used to convert raw per-token gaps into USD. | None | Keyless, no documented hard limit | All three modes (when pricing is needed) |

### npm runtime dependencies

| Package | Role |
|---|---|
| [`axios`](https://www.npmjs.com/package/axios) | HTTP client for Etherscan, Dune, and Tenderly. (DeFiLlama uses native `fetch`.) |
| [`dotenv`](https://www.npmjs.com/package/dotenv) | Loads `.env` into `process.env` at CLI startup. |
| [`zod`](https://www.npmjs.com/package/zod) | Schema validation for inbound JSON shapes (used in protocol-mode arg parsing today, available for any new strict-validation needs). |

### npm dev dependencies

| Package | Role |
|---|---|
| [`tsx`](https://www.npmjs.com/package/tsx) | Runs the TypeScript CLI files directly without a build step. Imposes the **Node 18+** floor. |
| [`typescript`](https://www.npmjs.com/package/typescript) | Type checking via `npm run typecheck`. No emit; we never ship compiled JS. |
| [`eslint`](https://www.npmjs.com/package/eslint) | Linting via `npm run lint`. |
| [`@types/node`](https://www.npmjs.com/package/@types/node) | Node standard-library type definitions. |

If you're auditing the dependency tree before installing: 4 runtime + 4 dev top-level packages, ~119 transitive packages total. There are no native build steps, no postinstall scripts that hit the network, and no Prisma / database drivers (a deliberate choice — see the architectural decision recorded in [CHANGELOG.md](CHANGELOG.md) for v0.1.0).

---

## Limits and known issues

- **Etherscan tx window**: `wallet:run` is bounded by `ANALYSIS_WINDOW_DAYS` in `lib/constants.ts` (default 10 days) and by Etherscan's `page * offset <= 10000` rule. Wallets with more than ~10k txs in the window will silently truncate.
- **Dune dumpster coverage**: not every tx has a row in `dune.flashbots.dataset_mempool_dumpster` — private bundles and Flashbots-relayed txs do not. Those fall back to `inclusion - 1` as the mempool block, flagged in the WARN log. Results are slightly less accurate.
- **DeFiLlama unpriced tokens**: long-tail / fresh-listing tokens often don't have a DeFiLlama price. Those tokens still appear in the per-token table with raw amounts; they just don't contribute to the USD total. Scam / honeypot tokens routinely fall in this bucket.
- **Walk Tenderly cost**: the earliest-valid walk simulates up to `(inclusionBlock − mempoolBlock + 1)` blocks per tx in the worst case. For typical txs this is 1–3 sims. For txs with long mempool delays (private bundles, congested mempool) it can be more. Cache hits make subsequent runs free.
- **No protocol decoders beyond UniV2**: `protocol:run` currently understands only Uniswap V2 router calldata. For any other protocol, run `tx:run` on individual hashes — the canonical core works on any tx because it doesn't decode anything; it just diffs the asset_changes Tenderly returns.

---

## Project layout

```
cli/
  _core.ts          # Shared canonical multi-token gap evaluator (walk + diff + price)
  tx-run.ts         # tx-by-hash mode
  wallet-run.ts     # wallet-by-address mode
  protocol-run.ts   # protocol-by-router mode (UniV2 only)

lib/
  analysis/
    calculator.ts          # DeFiLlama pricing, gap-computability gate
    filter.ts              # tx pre-filter (transfers, approvals, ...)
    protocol-pipeline.ts   # evaluateSwap (per-tx UniV2 evaluator)
    univ2-decoder.ts       # 9 swap*-method decoder
  data-sources/
    dune.ts                # mempool + protocol-tx queries
    etherscan.ts           # tx-history fetcher
    tenderly.ts            # simulation
  db.ts                    # local file-based cache
  constants.ts
  rate-limiter.ts
  types.ts
  utils.ts
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code conventions, and the list of wanted contributions (test suite, multi-token protocol mode, more protocol decoders).

---

## License

[MIT](LICENSE)
