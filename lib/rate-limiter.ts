/**
 * Generic rate limiter for API requests
 * Ensures requests don't exceed specified limits per second
 */

interface RateLimiterConfig {
  requestsPerSecond: number;
  maxConcurrent?: number;
}

class RateLimiter {
  private requestsPerSecond: number;
  private maxConcurrent: number;
  private requestTimestamps: number[] = [];
  private activeRequests = 0;
  private queue: Array<() => Promise<void>> = [];

  constructor(config: RateLimiterConfig) {
    this.requestsPerSecond = config.requestsPerSecond;
    this.maxConcurrent = config.maxConcurrent || Infinity;
  }

  /**
   * Wait until the next request can be made according to rate limits
   */
  private async waitForSlot(): Promise<void> {
    // Wait for concurrent request slots
    while (this.activeRequests >= this.maxConcurrent) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Clean up old timestamps (older than 1 second)
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(
      (ts) => now - ts < 1000
    );

    // If we've hit the rate limit, wait until the oldest request expires
    if (this.requestTimestamps.length >= this.requestsPerSecond) {
      const oldestTimestamp = this.requestTimestamps[0];
      const waitTime = 1000 - (now - oldestTimestamp) + 1; // +1ms buffer
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
  }

  /**
   * Execute a function with rate limiting
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.waitForSlot();

    this.activeRequests++;
    this.requestTimestamps.push(Date.now());

    try {
      return await fn();
    } finally {
      this.activeRequests--;
      this.processQueue();
    }
  }

  /**
   * Process queued requests
   */
  private async processQueue(): Promise<void> {
    if (this.queue.length === 0 || this.activeRequests >= this.maxConcurrent) {
      return;
    }

    const task = this.queue.shift();
    if (task) {
      await task();
    }
  }

  /**
   * Get current rate limit stats (for monitoring)
   */
  getStats() {
    return {
      activeRequests: this.activeRequests,
      recentRequests: this.requestTimestamps.length,
      queuedRequests: this.queue.length,
    };
  }
}

// Create rate limiters for different APIs
export const rateLimiters = {
  defillama: new RateLimiter({
    requestsPerSecond: 5, // DeFiLlama: free, no key, generous limits — 5/sec is conservative
    maxConcurrent: 2,
  }),
  etherscan: new RateLimiter({
    requestsPerSecond: 5, // Etherscan free tier: 5 calls/sec
    maxConcurrent: 1,
  }),
  tenderly: new RateLimiter({
    requestsPerSecond: 50, // Tenderly free tier: generous rate limits, conservative estimate
    maxConcurrent: 5,
  }),
};

export default RateLimiter;
