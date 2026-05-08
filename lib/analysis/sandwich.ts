import { KNOWN_SANDWICH_BOTS } from "@/lib/constants";
import type { Transaction, TransactionAnalysisResult } from "@/lib/types";

/**
 * Detect sandwich attacks for a transaction in a block
 */
export async function detectSandwichAttack(
  userTx: Transaction,
  blockTxs: Transaction[],
  userAddress: string
): Promise<{
  isSandwiched: boolean;
  sandwichBotAddress?: string;
  frontrunTxHash?: string;
  backrunTxHash?: string;
}> {
  // Find user's transaction index
  const userTxIndex = blockTxs.findIndex((tx) => tx.hash === userTx.hash);

  if (userTxIndex === -1) {
    return { isSandwiched: false };
  }

  // Look for frontrun and backrun transactions
  // Frontrun: same sender, executed before user's tx
  // Backrun: same sender, executed after user's tx
  // Both interact with the same DEX pool

  const userAddressLower = userAddress.toLowerCase();
  let frontrunTx: Transaction | undefined;
  let backrunTx: Transaction | undefined;

  // Search backwards for frontrun
  for (let i = userTxIndex - 1; i >= 0; i--) {
    const tx = blockTxs[i];
    if (
      tx.from.toLowerCase() === userAddressLower &&
      isDexSwap(tx) &&
      interactsSamePool(tx, userTx)
    ) {
      frontrunTx = tx;
      break;
    }
  }

  // Search forwards for backrun
  for (let i = userTxIndex + 1; i < blockTxs.length; i++) {
    const tx = blockTxs[i];
    if (
      tx.from.toLowerCase() === userAddressLower &&
      isDexSwap(tx) &&
      interactsSamePool(tx, userTx)
    ) {
      backrunTx = tx;
      break;
    }
  }

  const isSandwiched = !!(frontrunTx && backrunTx);

  if (isSandwiched) {
    const botAddress = frontrunTx!.from;
    const isKnownBot = KNOWN_SANDWICH_BOTS.has(botAddress.toLowerCase());

    return {
      isSandwiched: true,
      sandwichBotAddress: isKnownBot ? botAddress : undefined,
      frontrunTxHash: frontrunTx!.hash,
      backrunTxHash: backrunTx!.hash,
    };
  }

  return { isSandwiched: false };
}

/**
 * Check if two transactions interact with the same DEX pool
 */
function interactsSamePool(tx1: Transaction, tx2: Transaction): boolean {
  // Simple heuristic: same target address (DEX router)
  return tx1.to?.toLowerCase() === tx2.to?.toLowerCase();
}

/**
 * Check if transaction is a DEX swap
 */
function isDexSwap(tx: Transaction): boolean {
  // Simplified check - in production, use the filter.ts isDexSwap function
  return tx.input.length > 10 && tx.input.startsWith("0x");
}

/**
 * Detect sandwich attacks for multiple transactions
 */
export async function detectSandwiches(
  results: TransactionAnalysisResult[],
  blockTxsMap: Map<number, Transaction[]>,
  userAddress: string
): Promise<TransactionAnalysisResult[]> {
  const updated = [...results];

  for (let i = 0; i < updated.length; i++) {
    const result = updated[i];
    const blockTxs = blockTxsMap.get(result.blockNumber);

    if (!blockTxs) {
      continue;
    }

    // Find the original transaction
    const originalTx = blockTxs.find((tx) => tx.hash === result.txHash);
    if (!originalTx) {
      continue;
    }

    const sandwich = await detectSandwichAttack(
      originalTx,
      blockTxs,
      userAddress
    );

    if (sandwich.isSandwiched) {
      updated[i] = {
        ...result,
        isSandwiched: true,
        sandwichBotAddress: sandwich.sandwichBotAddress,
        frontrunTxHash: sandwich.frontrunTxHash,
        backrunTxHash: sandwich.backrunTxHash,
        gapType: "sandwich",
      };
    }
  }

  return updated;
}
