/**
 * Uniswap V2 Router02 calldata decoder (blueprint 02, Module P2).
 *
 * Hand-rolled — no external ABI library. All 9 supported swap methods share
 * one of two layouts (see `LAYOUT` table below).
 *
 * `deadline` is explicitly NOT in the output. Per project decision it is not
 * used as a proxy for signing time.
 */

import {
  UNISWAP_V2_SWAP_SELECTORS,
  WETH_ADDRESS,
  NATIVE_ETH_ADDRESS,
} from "@/lib/constants";
import type {
  DecodedUniV2Swap,
  ProtocolTxRow,
  UniV2SwapMethod,
} from "@/lib/types";

// Reverse-lookup: selector → method name
const SELECTOR_TO_METHOD: Record<string, UniV2SwapMethod> = Object.fromEntries(
  Object.entries(UNISWAP_V2_SWAP_SELECTORS).map(([method, sel]) => [
    sel,
    method as UniV2SwapMethod,
  ])
);

/**
 * Static-arg layout per method.
 *
 * `staticArgs` is the count of 32-byte words BEFORE the dynamic `path` data.
 * `pathArgIndex` is the index into those static words that holds the offset
 * to the `address[] path` data.
 *
 * `isExactIn` — true for "swapExact*" methods, false for "swap*ForExact*".
 * `ethIn`     — true for methods where the user spends native ETH (msg.value).
 * `ethOut`    — true for methods where the user receives native ETH.
 *
 * For methods with `ethIn: true`, the user does not supply amountIn in
 * calldata — only amountOut(Min) — and the ETH amount comes from tx.value.
 * We map these into the unified shape as:
 *   amountInParam  = tx.value (filled at the call site)
 *   amountOutParam = decoded uint256
 */
type MethodLayout = {
  staticArgs: number;       // number of 32-byte slots before path data
  pathArgIndex: number;     // which slot holds the offset to address[] path
  amountSlotIn: number | null;   // index of "amount-in" uint256 param (null = from tx.value)
  amountSlotOut: number;    // index of "amount-out" uint256 param
  recipientSlot: number;    // index of the `to` address slot
  isExactIn: boolean;
  ethIn: boolean;
  ethOut: boolean;
};

// Reference layouts:
//
// swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)
//   slots: 0=amountIn  1=amountOutMin  2=path_offset  3=to  4=deadline
//
// swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline)
//   slots: 0=amountOut 1=amountInMax   2=path_offset  3=to  4=deadline
//
// swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)
//   slots: 0=amountOutMin  1=path_offset  2=to  3=deadline
//
// swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline)
//   slots: 0=amountOut     1=path_offset  2=to  3=deadline
//
// swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)
//   slots: 0=amountIn  1=amountOutMin  2=path_offset  3=to  4=deadline
//
// swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline)
//   slots: 0=amountOut 1=amountInMax   2=path_offset  3=to  4=deadline

const METHOD_LAYOUTS: Record<UniV2SwapMethod, MethodLayout> = {
  swapExactTokensForTokens: {
    staticArgs: 5,
    pathArgIndex: 2,
    amountSlotIn: 0,
    amountSlotOut: 1,
    recipientSlot: 3,
    isExactIn: true,
    ethIn: false,
    ethOut: false,
  },
  swapTokensForExactTokens: {
    staticArgs: 5,
    pathArgIndex: 2,
    amountSlotIn: 1, // amountInMax
    amountSlotOut: 0, // amountOut (exact)
    recipientSlot: 3,
    isExactIn: false,
    ethIn: false,
    ethOut: false,
  },
  swapExactETHForTokens: {
    staticArgs: 4,
    pathArgIndex: 1,
    amountSlotIn: null, // from tx.value
    amountSlotOut: 0,
    recipientSlot: 2,
    isExactIn: true,
    ethIn: true,
    ethOut: false,
  },
  swapTokensForExactETH: {
    staticArgs: 5,
    pathArgIndex: 2,
    amountSlotIn: 1, // amountInMax
    amountSlotOut: 0, // amountOut (exact)
    recipientSlot: 3,
    isExactIn: false,
    ethIn: false,
    ethOut: true,
  },
  swapExactTokensForETH: {
    staticArgs: 5,
    pathArgIndex: 2,
    amountSlotIn: 0, // amountIn
    amountSlotOut: 1, // amountOutMin
    recipientSlot: 3,
    isExactIn: true,
    ethIn: false,
    ethOut: true,
  },
  swapETHForExactTokens: {
    staticArgs: 4,
    pathArgIndex: 1,
    amountSlotIn: null, // amountInMax = tx.value
    amountSlotOut: 0, // amountOut (exact)
    recipientSlot: 2,
    isExactIn: false,
    ethIn: true,
    ethOut: false,
  },
  // Fee-on-transfer variants have identical ABIs to their non-FOT counterparts
  swapExactTokensForTokensSupportingFeeOnTransferTokens: {
    staticArgs: 5,
    pathArgIndex: 2,
    amountSlotIn: 0,
    amountSlotOut: 1,
    recipientSlot: 3,
    isExactIn: true,
    ethIn: false,
    ethOut: false,
  },
  swapExactETHForTokensSupportingFeeOnTransferTokens: {
    staticArgs: 4,
    pathArgIndex: 1,
    amountSlotIn: null,
    amountSlotOut: 0,
    recipientSlot: 2,
    isExactIn: true,
    ethIn: true,
    ethOut: false,
  },
  swapExactTokensForETHSupportingFeeOnTransferTokens: {
    staticArgs: 5,
    pathArgIndex: 2,
    amountSlotIn: 0,
    amountSlotOut: 1,
    recipientSlot: 3,
    isExactIn: true,
    ethIn: false,
    ethOut: true,
  },
};

/**
 * Decode a UniV2 swap call from a raw ProtocolTxRow.
 * Returns null if the selector is not one of the 9 supported swap methods,
 * or if calldata is malformed.
 */
export function decodeUniV2Swap(tx: ProtocolTxRow): DecodedUniV2Swap | null {
  const hex = normalizeCalldata(tx.calldata);
  if (hex.length < 8) return null;

  const selector = `0x${hex.slice(0, 8)}`;
  const method = SELECTOR_TO_METHOD[selector];
  if (!method) return null;

  const layout = METHOD_LAYOUTS[method];
  const args = hex.slice(8);

  try {
    // Read all static slots (32 bytes each = 64 hex chars)
    const staticSlots: string[] = [];
    for (let i = 0; i < layout.staticArgs; i++) {
      const slot = args.slice(i * 64, (i + 1) * 64);
      if (slot.length !== 64) return null;
      staticSlots.push(slot);
    }

    // Extract path
    const pathOffsetHex = staticSlots[layout.pathArgIndex];
    const pathOffset = Number(BigInt("0x" + pathOffsetHex));
    // Offset is measured from the start of the args (after the 4-byte selector),
    // and is in bytes. Convert to hex-char index.
    const pathByteStart = pathOffset * 2;

    // path length (32 bytes)
    const pathLengthHex = args.slice(pathByteStart, pathByteStart + 64);
    if (pathLengthHex.length !== 64) return null;
    const pathLength = Number(BigInt("0x" + pathLengthHex));
    if (pathLength < 2 || pathLength > 10) return null; // sanity: UniV2 paths are short

    const path: string[] = [];
    for (let i = 0; i < pathLength; i++) {
      const entryStart = pathByteStart + 64 + i * 64;
      const entry = args.slice(entryStart, entryStart + 64);
      if (entry.length !== 64) return null;
      // address is right-padded into 32 bytes → take last 40 hex chars
      path.push("0x" + entry.slice(24).toLowerCase());
    }

    // Extract amounts
    const amountOutParam = BigInt(
      "0x" + staticSlots[layout.amountSlotOut]
    ).toString();
    const amountInParam =
      layout.amountSlotIn == null
        ? tx.value // native ETH in → amountIn comes from tx.value
        : BigInt("0x" + staticSlots[layout.amountSlotIn]).toString();

    // Recipient
    const recipient =
      "0x" + staticSlots[layout.recipientSlot].slice(24).toLowerCase();

    // Resolve tokenIn / tokenOut. Per HR-9 convention, native ETH sides
    // collapse to the zero-address pseudo-token for net-flow accounting.
    const pathFirst = path[0];
    const pathLast = path[path.length - 1];

    const tokenIn = layout.ethIn ? NATIVE_ETH_ADDRESS : pathFirst;
    const tokenOut = layout.ethOut ? NATIVE_ETH_ADDRESS : pathLast;

    // Sanity: for ETH variants, path[0]/path[last] should be WETH. Log if not.
    if (layout.ethIn && pathFirst !== WETH_ADDRESS) {
      console.warn(
        `[univ2-decoder] ${tx.txHash}: ethIn method but path[0]=${pathFirst} != WETH`
      );
    }
    if (layout.ethOut && pathLast !== WETH_ADDRESS) {
      console.warn(
        `[univ2-decoder] ${tx.txHash}: ethOut method but path[last]=${pathLast} != WETH`
      );
    }

    return {
      txHash: tx.txHash,
      method,
      selector,
      isExactIn: layout.isExactIn,
      tokenInIsNative: layout.ethIn,
      tokenOutIsNative: layout.ethOut,
      tokenIn,
      tokenOut,
      path,
      amountInParam,
      amountOutParam,
      recipient,
    };
  } catch (err) {
    console.warn(
      `[univ2-decoder] Failed to decode ${tx.txHash}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

function normalizeCalldata(input: string): string {
  if (!input) return "";
  const s = input.toLowerCase();
  return s.startsWith("0x") ? s.slice(2) : s;
}
