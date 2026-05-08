import type { Transaction } from "@/lib/types";

/**
 * METHOD SIGNATURE BLACKLIST
 * These operations have no execution gap / no MEV relevance
 */
const EXCLUDED_METHOD_SIGS = new Set([
  // --- ERC-20 ---
  "0xa9059cbb", // transfer(address,uint256)
  "0x095ea7b3", // approve(address,uint256)

  // --- ERC-721 ---
  "0x23b872dd", // transferFrom(address,address,uint256)
  "0x42842e0e", // safeTransferFrom(address,address,uint256)
  "0xb88d4fde", // safeTransferFrom(address,address,uint256,bytes)
  "0xa22cb465", // setApprovalForAll(address,bool)

  // --- ERC-1155 ---
  "0xf242432a", // safeTransferFrom(address,address,uint256,uint256,bytes)
  "0x2eb2c2d6", // safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)

  // --- WETH ---
  "0x2e1a7d4d", // withdraw(uint256) — unwrap
  "0xd0e30db0", // deposit() — wrap

  // --- Governance / Admin ---
  "0x3659cfe6", // upgradeTo(address) — proxy upgrade
  "0x5c19a95c", // delegate(address) — governance delegation
  "0x56781388", // castVote(uint256,uint8)
  "0xb61d27f6", // execute(address,uint256,bytes) — multisig execute
  "0x6a761202", // execTransaction(...) — Gnosis Safe execute
]);

/**
 * CONTRACT ADDRESS BLACKLIST
 * Protocols where user interactions have no meaningful expected-vs-actual execution gap
 */
const EXCLUDED_CONTRACTS = new Set([
  // --- Lending ---
  "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9", // Aave V2
  "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", // Aave V3
  "0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b", // Compound V2 Comptroller
  "0xc3d688b66703497daa19211eedff47f25384cdc3", // Compound V3 cUSDC
  "0xa17581a9e3356d9a858b789d68b4d866e593ae94", // Compound V3 cWETH
  "0xc13e21b648a5ee794902342038ff3adab66be987", // Spark Pool
  "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb", // Morpho Blue
  "0x89b78cfa322f6c5de0abceecab66aee45393cc5a", // Maker DSR Manager

  // --- Liquid Staking ---
  "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", // Lido stETH
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", // Lido wstETH
  "0xae78736cd615f374d3085123a210448e74fc6393", // Rocket Pool rETH
  "0xdd9bc35ae942ef0cfa76930954a156b3ff30a4e1", // Rocket Pool Deposit
  "0xbe9895146f7af43049ca1c1ae358b0541ea49704", // Coinbase cbETH
  "0xac3e018457b222d93114458476f3e3416abbe38f", // Frax sfrxETH
  "0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa", // Mantle mETH
  "0x858646372cc42e1a627fce94aa7a7033e7cf075a", // EigenLayer Strategy Manager
  "0x39053d51b77dc0d36036fc1fcc8cb819df8ef37a", // EigenLayer Delegation Manager

  // --- Bridges ---
  "0x72ce9c846789fdb6fc1f34ac4ad25dd9ef7031ef", // Arbitrum Gateway Router
  "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1", // Optimism L1 Standard Bridge
  "0xa0c68c638235ee32657e8f720a23cec1bfc6c9a8", // Polygon PoS Bridge
  "0x32400084d98fc1dcd375be9a6427b6445f332024", // zkSync Diamond Proxy
  "0x3154cf16ccdb4c6d922629664174b904d80f2c35", // Base Bridge
  "0x8731d54e9d02c286767d56ac03e8037c07e01e98", // Stargate Router
  "0x5c7bcd6e7de5005b46012c0f2ee135ab3b3f3b0a", // Across SpokePool
  "0xb8901acb165ed027e32754e0ffe830802919727f", // Hop Protocol L1 Bridge (ETH)

  // --- ENS ---
  "0x253553366da8546fc250f225fe3d25d0c782303b", // ENS Registrar Controller
  "0x231b0ee14048e9dccd1d247744d114a4eb5e8e63", // ENS Public Resolver

  // --- NFT Marketplaces (mints/buys are fixed price) ---
  "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", // OpenSea Seaport 1.5
  "0x0000000000a39bb272e79075ade125fd351887ac", // Blur Pool

  // --- Gnosis Safe / Multisig ---
  "0xd9db270c1b5e3bd161e8c8503c55ceabee709552", // Safe Singleton (v1.3.0)
  "0xa6b71e26c5e0845f74c812102ca7114b6a896ab2", // Safe Proxy Factory
]);

/**
 * Determine if a transaction needs simulation to detect execution gaps.
 *
 * Uses a BLACKLIST approach: we exclude transactions where there is
 * fundamentally no expected-vs-actual output to compare (transfers,
 * approvals, staking, lending, bridging, governance, etc.).
 *
 * Everything NOT excluded goes to Tenderly for simulation.
 * This is intentionally over-inclusive — if in doubt we simulate
 * and let a zero-delta result prove there was no gap.
 */
export function needsSimulation(tx: Transaction): boolean {
  // Failed txs have no meaningful output to compare
  if (tx.isError === "1" || tx.txreceipt_status === "0") {
    return false;
  }

  // Contract deployments (no `to` address) — nothing to simulate
  if (!tx.to) {
    return false;
  }

  // Simple ETH transfers — deterministic, no execution gap
  if (tx.input === "0x" || tx.input === "") {
    return false;
  }

  // Known no-gap method signatures (transfers, approvals, wraps, governance, etc.)
  const methodSig = tx.input.slice(0, 10).toLowerCase();
  if (EXCLUDED_METHOD_SIGS.has(methodSig)) {
    return false;
  }

  // Known no-execution-gap protocols (lending, staking, bridges, etc.)
  if (EXCLUDED_CONTRACTS.has(tx.to.toLowerCase())) {
    return false;
  }

  // Everything else: simulate it
  return true;
}

/** @deprecated Use needsSimulation instead */
export const shouldAnalyze = needsSimulation;

/**
 * Filter out transactions that don't need simulation.
 * Returns only txs where expected-vs-actual output comparison is meaningful.
 */
export function filterTransactionsForSimulation(
  transactions: Transaction[]
): Transaction[] {
  const before = transactions.length;
  const result = transactions.filter(needsSimulation);

  const excluded = before - result.length;
  const failed = transactions.filter((tx) => tx.isError === "1" || tx.txreceipt_status === "0").length;
  const ethTransfers = transactions.filter((tx) => tx.input === "0x" || tx.input === "").length;
  const knownNoGap = excluded - failed - ethTransfers;

  console.log(
    `[filter] ${before} txs → ${result.length} to simulate ` +
    `(excluded ${excluded}: ${failed} failed, ${ethTransfers} ETH transfers, ${knownNoGap} known no-gap protocols/methods)`
  );

  return result;
}

/** @deprecated Use filterTransactionsForSimulation instead */
export const filterTransactionsForAnalysis = filterTransactionsForSimulation;

/**
 * Get protocol label for a contract address (for UI display)
 */
export function getProtocolLabel(contractAddress: string): string {
  const addr = contractAddress.toLowerCase();

  // Lending protocols
  if (addr === "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9")
    return "Aave V2";
  if (addr === "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2")
    return "Aave V3";
  if (addr === "0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b")
    return "Compound V2";
  if (addr === "0xc3d688b66703497daa19211eedff47f25384cdc3")
    return "Compound V3";
  if (addr === "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb")
    return "Morpho Blue";

  // DEX protocols
  if (addr === "0x7a250d5630b4cf539739df2c5dacb4c659f2488d")
    return "Uniswap V2";
  if (addr === "0xe592427a0aece92de3edee1f18e0157c05861564")
    return "Uniswap V3";
  if (addr === "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad")
    return "Uniswap Universal Router";
  if (addr === "0x1111111254eeb25477b68fb85ed929f73a960582")
    return "1inch";
  if (addr === "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f")
    return "SushiSwap";

  // Staking
  if (addr === "0xae7ab96520de3a18e5e111b5eaab095312d7fe84")
    return "Lido stETH";
  if (addr === "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0")
    return "Lido wstETH";

  return "Unknown Protocol";
}
