/**
 * Validate Ethereum address format (`0x` + 40 hex chars).
 */
export function isValidEthereumAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Normalize an Ethereum address to lowercase. Throws on invalid input —
 * callers that accept user input MUST validate first.
 */
export function normalizeAddress(address: string): string {
  if (!isValidEthereumAddress(address)) {
    throw new Error(`Invalid Ethereum address: ${address}`);
  }
  return address.toLowerCase();
}

/**
 * Sleep for `ms` milliseconds. Used by Dune polling and the rate-limit
 * spacing logic; not for arbitrary "wait and hope" loops.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff. The total wait between
 * attempts is `initialDelayMs * (1 + 2 + 4 + ... + 2^(maxRetries-2))`.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  initialDelayMs = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (i < maxRetries - 1) {
        const delayMs = initialDelayMs * Math.pow(2, i);
        await sleep(delayMs);
      }
    }
  }

  throw lastError || new Error("Max retries exceeded");
}
