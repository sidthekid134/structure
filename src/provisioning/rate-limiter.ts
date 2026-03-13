/**
 * RateLimiter applies exponential backoff when HTTP 429 / quota errors are detected.
 *
 * Retry policy:
 *   - initial delay : 1 s
 *   - max delay     : 60 s  (retries stop when the raw delay would exceed this)
 *   - max retries   : 10
 *   - jitter        : ±10 % of the computed delay
 */
export class RateLimiter {
  private readonly initialDelay: number;
  private readonly maxDelay: number;
  private readonly maxRetries: number;
  private readonly jitterFactor: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options?: {
    initialDelay?: number;
    maxDelay?: number;
    maxRetries?: number;
    jitterFactor?: number;
    /** Inject a custom sleep for testing (avoids real waits). */
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.initialDelay = options?.initialDelay ?? 1000;
    this.maxDelay = options?.maxDelay ?? 60_000;
    this.maxRetries = options?.maxRetries ?? 10;
    this.jitterFactor = options?.jitterFactor ?? 0.1;
    this.sleep =
      options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Returns true when the error signals a rate-limit or quota exhaustion.
   * Detects: HTTP 429 status codes, "rate limit" / "quota" in the message.
   */
  isRateLimitError(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')) {
        return true;
      }
    }
    if (typeof error === 'object' && error !== null) {
      const e = error as Record<string, unknown>;
      if (e['status'] === 429 || e['statusCode'] === 429 || e['code'] === 429) return true;
    }
    return false;
  }

  /**
   * Computes the clamped delay (ms) for the given attempt index (0-based).
   * Applies ±jitterFactor random jitter.
   */
  computeDelay(attempt: number): number {
    const base = Math.min(this.initialDelay * Math.pow(2, attempt), this.maxDelay);
    const jitter = base * this.jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }

  /**
   * Executes `operation`, retrying automatically on rate-limit errors.
   * Stops retrying after maxRetries attempts or when the raw (uncapped) delay
   * would equal or exceed maxDelay, whichever comes first.
   */
  async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!this.isRateLimitError(error)) throw error;
        if (attempt >= this.maxRetries) throw error;

        // Raw (uncapped) delay for the next attempt
        const rawDelay = this.initialDelay * Math.pow(2, attempt);
        if (rawDelay >= this.maxDelay) throw error;

        lastError = error;
        const delay = this.computeDelay(attempt);
        await this.sleep(delay);
      }
    }

    throw lastError;
  }
}

/**
 * Convenience wrapper: applies rate-limit retry to any async operation.
 * Optionally accepts a pre-configured RateLimiter instance.
 */
export function withRetry<T>(
  operation: () => Promise<T>,
  rateLimiter: RateLimiter = new RateLimiter(),
): Promise<T> {
  return rateLimiter.withRetry(operation);
}
