// Known DEX Router Addresses
export const DEX_ROUTERS = {
  UNISWAP_V2_ROUTER: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  UNISWAP_V3_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  UNISWAP_UNIVERSAL_ROUTER: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
  INCH_V5: "0x1111111254EEB25477B68fb85Ed929f73A960582",
  SUSHISWAP: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
  ZX_EXCHANGE_PROXY: "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",
  COW_PROTOCOL: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
} as const;

// Known DEX Method Signatures (4-byte function selectors)
export const DEX_METHOD_SIGS = {
  // Uniswap V2 Router
  SWAP_EXACT_ETH_FOR_TOKENS: "0x7ff36ab5",
  SWAP_EXACT_TOKENS_FOR_ETH: "0x18cbafe5",
  SWAP_EXACT_TOKENS_FOR_TOKENS: "0x38ed1739",
  SWAP_ETH_FOR_EXACT_TOKENS: "0xfb3bdb41",
  SWAP_TOKENS_FOR_EXACT_ETH: "0x4a25d94a",
  SWAP_TOKENS_FOR_EXACT_TOKENS: "0x8803dbee",
  
  // Uniswap V3 Router
  EXACT_INPUT_SINGLE: "0x414bf389",
  EXACT_INPUT: "0xc04b8d59",
  EXACT_OUTPUT_SINGLE: "0xdb3e2198",
  EXACT_OUTPUT: "0xf28c0498",
  
  // Uniswap Universal Router
  EXECUTE: "0x3593564c",
  
  // 1inch
  SWAP: "0x12aa3caf",
  UNOSWAP: "0x2e95b6c8",
  FILL_ORDER: "0x6d411604",
  
  // CoW Protocol
  SETTLE: "0x13d79a0b",
  
  // Standard ERC20
  TRANSFER: "0xa9059cbb",
  APPROVE: "0x095ea7b3",
} as const;

// Uniswap V2 Swap Event Signature
export const UNISWAP_V2_SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe1cb487d";

// Uniswap V3 Swap Event Signature
export const UNISWAP_V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f7e02632f38141c3461f98fd0d690df807";

// Analysis window (days)
export const ANALYSIS_WINDOW_DAYS = 10;

// Protocol-analysis window (days). Kept short — Dune + Tenderly cost scales
// linearly with the number of router txs.
export const PROTOCOL_ANALYSIS_WINDOW_DAYS = 1;

// Max protocol router txs pulled from Dune per run.
export const PROTOCOL_ANALYSIS_TX_LIMIT = 200;

// Protocol-analysis precise window in MINUTES. When set (> 0) this takes
// precedence over `PROTOCOL_ANALYSIS_WINDOW_DAYS` — the Dune query uses an
// `INTERVAL 'N' MINUTE` predicate, and the Dune result cache is bypassed
// entirely (sub-day smoke runs don't pollute the router-scoped cache).
// Kept small for iteration speed on smoke tests.
export const PROTOCOL_ANALYSIS_WINDOW_MINUTES = 10;

// Batch size for incremental persistence in the protocol pipeline
// (Dune cache, Tenderly sim cache, price snapshots, swap results).
// 10 keeps SQLite's journal happy: a 200-tx run issues ~20 writes per
// checkpoint instead of ~200 single-row upserts.
export const PROTOCOL_PERSIST_BATCH = 10;

// TTL for the Dune protocol-tx cache (DuneProtocolTxCache + DuneProtocolFetch).
// Short because new router txs arrive every block; stale-within-30min is an
// explicit tradeoff documented in blueprints/02-data-contracts.md Module P1.
export const PROTOCOL_DUNE_CACHE_TTL_MS = 30 * 60 * 1000;

// Execution delay threshold (ms) - more than 1 block
export const EXECUTION_DELAY_THRESHOLD_MS = 12000;

// Block time in seconds (post-merge Ethereum, fixed 12s slots)
export const BLOCK_TIME_SECONDS = 12;

// Block time in milliseconds (post-merge Ethereum)
export const BLOCK_TIME_MS = 12000;

// API Rate Limits
export const API_RATE_LIMITS = {
  DEFILLAMA_REQ_PER_SEC: 5, // Free, no key needed — conservative
  ETHERSCAN_REQ_PER_SEC: 3, // Free tier: 3/sec (5/sec is paid Lite tier)
  DUNE_QUERY_TIMEOUT_MS: 30000,
  TENDERLY_SIMULATION_TIMEOUT_MS: 30000,
} as const;

// Pagination defaults
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Protocol Swap Pipeline (blueprint 02)
// ─────────────────────────────────────────────────────────────────────────────

// Canonical Uniswap V2 Router02 address on Ethereum mainnet (lowercase).
// Derived from the checksummed DEX_ROUTERS entry so there's a single source
// of truth for the address value.
export const UNISWAP_V2_ROUTER_ADDRESS =
  DEX_ROUTERS.UNISWAP_V2_ROUTER.toLowerCase();

// WETH9 on Ethereum mainnet — used as the "in-calldata" representation
// of native ETH inside UniV2 router swap paths.
export const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

// Pseudo-address for native ETH in net-flow accounting (HR-9)
export const NATIVE_ETH_ADDRESS =
  "0x0000000000000000000000000000000000000000";

// The 9 Uniswap V2 Router02 swap method selectors we handle
// (see blueprint 02, Module P2)
export const UNISWAP_V2_SWAP_SELECTORS = {
  swapExactTokensForTokens: "0x38ed1739",
  swapTokensForExactTokens: "0x8803dbee",
  swapExactETHForTokens: "0x7ff36ab5",
  swapTokensForExactETH: "0x4a25d94a",
  swapExactTokensForETH: "0x18cbafe5",
  swapETHForExactTokens: "0xfb3bdb41",
  swapExactTokensForTokensSupportingFeeOnTransferTokens: "0x5c11d795",
  swapExactETHForTokensSupportingFeeOnTransferTokens: "0xb6f9de95",
  swapExactTokensForETHSupportingFeeOnTransferTokens: "0x791ac947",
} as const;

// Analysis status messages
export const STATUS_MESSAGES = {
  pending: "Queued for analysis",
  fetching_txs: "Fetching transaction history",
  filtering: "Filtering out no-gap transactions",
  querying_mempool: "Querying mempool data",
  simulating: "Simulating transactions",
  calculating: "Calculating MEV losses",
  complete: "Analysis complete",
  error: "Analysis failed",
} as const;
