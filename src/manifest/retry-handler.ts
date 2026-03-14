export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export class RateLimitError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  if (err && typeof err === 'object') {
    const e = err as { statusCode?: number; status?: number; code?: string };
    const status = e.statusCode ?? e.status;
    if (status === 429 || status === 503) return true;
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 60_000;

  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts - 1) {
        throw err;
      }
      const backoff = Math.min(Math.pow(2, attempt) * baseDelayMs, maxDelayMs);
      console.warn(
        `[retry] Attempt ${attempt + 1}/${maxAttempts} failed with retryable error. Retrying in ${backoff}ms...`,
      );
      await delay(backoff);
    }
  }

  throw lastErr;
}
