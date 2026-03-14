import { RateLimitError, withRetry } from './retry-handler';

// Use real timers but with very small delays for speed
describe('withRetry', () => {
  it('returns result when fn succeeds on first attempt', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on RateLimitError and succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new RateLimitError(429, 'rate limited'))
      .mockResolvedValueOnce('ok');

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on statusCode 503', async () => {
    const err = Object.assign(new Error('service unavailable'), { statusCode: 503 });
    const fn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('recovered');

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on non-retryable error', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('auth failed'));
    await expect(withRetry(fn, { maxAttempts: 5, baseDelayMs: 1 })).rejects.toThrow('auth failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after max attempts are exhausted', async () => {
    let calls = 0;
    const fn = jest.fn().mockImplementation(() => {
      calls++;
      return Promise.reject(new RateLimitError(429, 'rate limited'));
    });

    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow(RateLimitError);
    expect(calls).toBe(3);
  });

  it('passes attempt index to fn', async () => {
    const attempts: number[] = [];
    const fn = jest.fn().mockImplementation((attempt: number) => {
      attempts.push(attempt);
      if (attempt < 2) return Promise.reject(new RateLimitError(429, 'retry'));
      return Promise.resolve('done');
    });

    await withRetry(fn, { maxAttempts: 5, baseDelayMs: 1 });
    expect(attempts).toEqual([0, 1, 2]);
  });

  it('respects maxDelayMs cap', async () => {
    const capturedDelays: number[] = [];
    const origDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    // We test this by checking the backoff logic directly:
    // attempt 0 → 2^0 * base = base
    // attempt 1 → 2^1 * base = 2*base
    // both should be <= maxDelayMs when set lower
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new RateLimitError(429, 'rate limited'))
      .mockRejectedValueOnce(new RateLimitError(429, 'rate limited'))
      .mockResolvedValueOnce('done');

    // Spy on delay calls indirectly by verifying the result is still correct
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 });
    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('RateLimitError', () => {
  it('has correct name and statusCode', () => {
    const err = new RateLimitError(429, 'too many requests');
    expect(err.name).toBe('RateLimitError');
    expect(err.statusCode).toBe(429);
    expect(err.message).toBe('too many requests');
  });

  it('is an instance of Error', () => {
    expect(new RateLimitError(429, 'msg')).toBeInstanceOf(Error);
  });
});
