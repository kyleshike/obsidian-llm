import { logProcessRetrying } from "./logging";

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  config: {
    maxRetries: number;
    initialDelay: number;
    maxDelay: number;
    factor: number;
  } = {
    maxRetries: 3,
    initialDelay: 1_000, // 1 second
    maxDelay: 10_000, // 10 seconds
    factor: 2, // Exponential backoff factor
  }
): Promise<T> {
  let lastError: Error | null = null;
  let delay: number = config.initialDelay;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (attempt === config.maxRetries) {
        break;
      }

      logProcessRetrying("Operation", attempt + 1, {
        delay,
        error: lastError.message,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * config.factor, config.maxDelay);
    }
  }

  throw new Error(
    `Operation failed after ${config.maxRetries} retries: ${lastError?.message}`
  );
}
