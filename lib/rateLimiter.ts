/**
 * Rate limiter implementation
 * Controls request frequency using a sliding window approach
 */

type RateLimiterConfig = {
  maxRequests: number;
  timeWindow: number;
};

type RateLimiterState = {
  timestamps: number[];
};

/**
 * Creates a rate limiter instance
 * @param config - Configuration for max requests and time window
 * @returns Object with waitForSlot method
 */
function createRateLimiter(config: RateLimiterConfig) {
  const state: RateLimiterState = {
    timestamps: [],
  };

  /**
   * Removes expired timestamps from state
   */
  function cleanup() {
    const now = Date.now();
    state.timestamps = state.timestamps.filter(
      (time) => now - time < config.timeWindow
    );
  }

  /**
   * Waits for an available request slot
   * @returns Promise that resolves when a slot is available
   */
  async function waitForSlot(): Promise<void> {
    cleanup();
    const now = Date.now();

    if (state.timestamps.length >= config.maxRequests) {
      const oldestTimestamp = state.timestamps[0];
      const waitTime = config.timeWindow - (now - (oldestTimestamp ?? 0));
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    state.timestamps.push(now);
  }

  return {
    waitForSlot,
  };
}

export const rateLimiter = createRateLimiter({
  maxRequests: 10,
  timeWindow: 1000,
});
