import { RateLimiter, withRetry } from './rate-limiter';

// A fast no-op sleep so tests don't wait for real delays.
const noSleep = () => Promise.resolve();

function makeLimiter(overrides?: ConstructorParameters<typeof RateLimiter>[0]) {
  return new RateLimiter({ sleep: noSleep, ...overrides });
}

// ---------------------------------------------------------------------------
// isRateLimitError
// ---------------------------------------------------------------------------
describe('RateLimiter.isRateLimitError', () => {
  const rl = makeLimiter();

  it('detects "429" in error message', () => {
    expect(rl.isRateLimitError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
  });

  it('detects "rate limit" in error message (case-insensitive)', () => {
    expect(rl.isRateLimitError(new Error('Rate Limit exceeded'))).toBe(true);
  });

  it('detects "quota" in error message', () => {
    expect(rl.isRateLimitError(new Error('quota exceeded for this project'))).toBe(true);
  });

  it('detects status === 429 on object errors', () => {
    expect(rl.isRateLimitError({ status: 429, message: 'Too Many Requests' })).toBe(true);
  });

  it('detects statusCode === 429 on object errors', () => {
    expect(rl.isRateLimitError({ statusCode: 429 })).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(rl.isRateLimitError(new Error('Connection refused'))).toBe(false);
  });

  it('returns false for non-Error primitives', () => {
    expect(rl.isRateLimitError('something went wrong')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeDelay
// ---------------------------------------------------------------------------
describe('RateLimiter.computeDelay', () => {
  it('attempt 0 is close to initialDelay (within jitter)', () => {
    const rl = makeLimiter({ initialDelay: 1000, jitterFactor: 0.1 });
    const delay = rl.computeDelay(0);
    expect(delay).toBeGreaterThanOrEqual(900);
    expect(delay).toBeLessThanOrEqual(1100);
  });

  it('doubles with each attempt (exponential growth)', () => {
    // With jitter=0 we get exact values
    const rl = makeLimiter({ initialDelay: 1000, jitterFactor: 0 });
    expect(rl.computeDelay(0)).toBe(1000);
    expect(rl.computeDelay(1)).toBe(2000);
    expect(rl.computeDelay(2)).toBe(4000);
  });

  it('is clamped to maxDelay', () => {
    const rl = makeLimiter({ initialDelay: 1000, maxDelay: 5000, jitterFactor: 0 });
    expect(rl.computeDelay(10)).toBe(5000);
  });

  it('is never negative', () => {
    const rl = makeLimiter({ initialDelay: 1000, jitterFactor: 0.1 });
    for (let i = 0; i < 10; i++) {
      expect(rl.computeDelay(i)).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// withRetry (method)
// ---------------------------------------------------------------------------
describe('RateLimiter.withRetry', () => {
  it('returns the result immediately when no error occurs', async () => {
    const rl = makeLimiter();
    const result = await rl.withRetry(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('retries on rate-limit error and eventually succeeds', async () => {
    const rl = makeLimiter({ maxRetries: 3 });
    let calls = 0;
    const result = await rl.withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('HTTP 429 rate limit');
      return 'success';
    });
    expect(result).toBe('success');
    expect(calls).toBe(3);
  });

  it('throws immediately on non-rate-limit errors', async () => {
    const rl = makeLimiter();
    let calls = 0;
    await expect(
      rl.withRetry(async () => {
        calls++;
        throw new Error('Internal server error');
      }),
    ).rejects.toThrow('Internal server error');
    expect(calls).toBe(1);
  });

  it('stops after maxRetries attempts', async () => {
    const maxRetries = 3;
    const rl = makeLimiter({ maxRetries, initialDelay: 1, maxDelay: 60_000 });
    let calls = 0;
    await expect(
      rl.withRetry(async () => {
        calls++;
        throw new Error('HTTP 429');
      }),
    ).rejects.toThrow('HTTP 429');
    // initial call + maxRetries retries
    expect(calls).toBe(maxRetries + 1);
  });

  it('stops when raw delay reaches maxDelay', async () => {
    // initialDelay=1000, maxDelay=2000 → raw delays: 1000, 2000 (stops)
    // attempt 0: raw=1000 (<2000) → retry
    // attempt 1: raw=2000 (>=2000) → stop
    const rl = makeLimiter({ initialDelay: 1000, maxDelay: 2000, maxRetries: 10 });
    let calls = 0;
    await expect(
      rl.withRetry(async () => {
        calls++;
        throw new Error('HTTP 429');
      }),
    ).rejects.toThrow('HTTP 429');
    // initial + 1 retry (attempt 0 retries; attempt 1 raw>=maxDelay → throw)
    expect(calls).toBe(2);
  });

  it('calls sleep between retries', async () => {
    const sleepCalls: number[] = [];
    const rl = new RateLimiter({
      initialDelay: 1000,
      maxDelay: 60_000,
      maxRetries: 2,
      jitterFactor: 0,
      sleep: async (ms) => { sleepCalls.push(ms); },
    });

    let calls = 0;
    await expect(
      rl.withRetry(async () => {
        calls++;
        throw new Error('HTTP 429');
      }),
    ).rejects.toThrow();

    // Two sleeps before giving up (attempts 0 and 1)
    expect(sleepCalls).toHaveLength(2);
    expect(sleepCalls[0]).toBe(1000); // attempt 0: 1000*2^0
    expect(sleepCalls[1]).toBe(2000); // attempt 1: 1000*2^1
  });
});

// ---------------------------------------------------------------------------
// withRetry (standalone function)
// ---------------------------------------------------------------------------
describe('withRetry (standalone)', () => {
  it('passes through to RateLimiter.withRetry', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw new Error('HTTP 429');
      return 'done';
    }, new RateLimiter({ sleep: noSleep }));
    expect(result).toBe('done');
    expect(calls).toBe(2);
  });
});
