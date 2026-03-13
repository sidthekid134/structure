import { ProviderAdapter } from './provider-adapter';
import { RateLimiter } from './rate-limiter';
import { Database, ProviderConfig, ProvisioningResult } from './types';

// ---------------------------------------------------------------------------
// Test double: in-memory Database
// ---------------------------------------------------------------------------

interface DbRow extends Record<string, any> {}

/**
 * Minimal in-memory database that tracks every query for assertions.
 * Uses simple array filtering to simulate SELECT/INSERT/UPDATE.
 */
class InMemoryDb implements Database {
  operations: DbRow[] = [];
  logs: DbRow[] = [];
  queries: Array<{ sql: string; params: any[] }> = [];

  async query<T extends Record<string, any> = Record<string, any>>(
    sql: string,
    params: any[] = [],
  ): Promise<{ rows: T[] }> {
    this.queries.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/SELECT id, status\s+FROM provisioning_operations/i.test(s)) {
      const [appId, provider, idempotencyKey] = params;
      const rows = this.operations.filter(
        (o) => o.app_id === appId && o.provider === provider && o.idempotency_key === idempotencyKey,
      );
      return { rows: rows as T[] };
    }

    if (/INSERT INTO provisioning_operations/i.test(s)) {
      const [appId, provider, idempotencyKey] = params;
      const existing = this.operations.find((o) => o.idempotency_key === idempotencyKey);
      if (existing) {
        return { rows: [{ id: existing.id }] as unknown as T[] };
      }
      const id = `op-${this.operations.length + 1}`;
      this.operations.push({ id, app_id: appId, provider, status: 'pending', idempotency_key: idempotencyKey });
      return { rows: [{ id }] as unknown as T[] };
    }

    if (/UPDATE provisioning_operations\s+SET status = 'in_progress'/i.test(s)) {
      const [opId] = params;
      const op = this.operations.find((o) => o.id === opId);
      if (op) op.status = 'in_progress';
      return { rows: [] };
    }

    if (/UPDATE provisioning_operations\s+SET status = 'success'/i.test(s)) {
      const [opId] = params;
      const op = this.operations.find((o) => o.id === opId);
      if (op) op.status = 'success';
      return { rows: [] };
    }

    if (/UPDATE provisioning_operations\s+SET status = 'failed'/i.test(s)) {
      const [opId, errorMessage] = params;
      const op = this.operations.find((o) => o.id === opId);
      if (op) { op.status = 'failed'; op.error_message = errorMessage; }
      return { rows: [] };
    }

    if (/INSERT INTO provisioning_operation_logs/i.test(s)) {
      const [operationId, step, result] = params;
      this.logs.push({ operation_id: operationId, step, result, timestamp: new Date() });
      return { rows: [] };
    }

    if (/SELECT result\s+FROM provisioning_operation_logs/i.test(s)) {
      const [opId] = params;
      const rows = this.logs
        .filter((l) => l.operation_id === opId && l.step === 'provision_result')
        .sort((a, b) => b.timestamp - a.timestamp);
      return { rows: rows as T[] };
    }

    return { rows: [] };
  }
}

// ---------------------------------------------------------------------------
// Concrete test adapter
// ---------------------------------------------------------------------------

const MOCK_RESULT: ProvisioningResult = {
  success: true,
  resourceId: 'res-123',
  credentials: { token: 'abc' },
  metadata: { region: 'us-east-1' },
  error: null,
};

class MockAdapter extends ProviderAdapter {
  protected get providerName() { return 'mock'; }

  provisionImpl: () => Promise<ProvisioningResult> = async () => MOCK_RESULT;

  async authenticate(_creds: Record<string, string>): Promise<ProvisioningResult> {
    return MOCK_RESULT;
  }
  async provision(_config: ProviderConfig): Promise<ProvisioningResult> {
    return this.provisionImpl();
  }
  async verify(_resourceId: string): Promise<ProvisioningResult> {
    return { ...MOCK_RESULT };
  }
  async rollback(_resourceId: string): Promise<ProvisioningResult> {
    return { ...MOCK_RESULT, success: false, error: null };
  }
}

const CONFIG: ProviderConfig = {
  apiKey: 'key-123',
  baseUrl: 'https://api.example.com',
  timeout: 5000,
};

const noSleep = () => Promise.resolve();

function makeAdapter(db: Database, rl?: RateLimiter) {
  return new MockAdapter(db, rl ?? new RateLimiter({ sleep: noSleep }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProviderAdapter abstract methods', () => {
  it('authenticate returns a ProvisioningResult', async () => {
    const db = new InMemoryDb();
    const adapter = makeAdapter(db);
    const result = await adapter.authenticate({ token: 'x' });
    expect(result.success).toBe(true);
    expect(result.resourceId).toBe('res-123');
  });

  it('verify returns a ProvisioningResult', async () => {
    const db = new InMemoryDb();
    const adapter = makeAdapter(db);
    const result = await adapter.verify('res-123');
    expect(result.success).toBe(true);
  });

  it('rollback returns a ProvisioningResult', async () => {
    const db = new InMemoryDb();
    const adapter = makeAdapter(db);
    const result = await adapter.rollback('res-123');
    expect(result.success).toBe(false);
    expect(result.error).toBeNull();
  });
});

describe('ProviderAdapter.provisionIdempotent – happy path', () => {
  it('calls provision and returns its result', async () => {
    const db = new InMemoryDb();
    const adapter = makeAdapter(db);
    const result = await adapter.provisionIdempotent('app-1', 'key-1', CONFIG);
    expect(result.success).toBe(true);
    expect(result.resourceId).toBe('res-123');
    expect(result.credentials).toEqual({ token: 'abc' });
  });

  it('inserts operation row with pending status before provisioning', async () => {
    const db = new InMemoryDb();
    const adapter = makeAdapter(db);
    await adapter.provisionIdempotent('app-1', 'key-1', CONFIG);
    const op = db.operations.find((o) => o.idempotency_key === 'key-1');
    expect(op).toBeDefined();
    // After success, status should be 'success'
    expect(op!.status).toBe('success');
  });

  it('transitions state pending → in_progress → success', async () => {
    const db = new InMemoryDb();
    const adapter = makeAdapter(db);
    await adapter.provisionIdempotent('app-1', 'key-1', CONFIG);

    const steps = db.logs.map((l) => l.step);
    expect(steps).toContain('state:pending');
    expect(steps).toContain('state:in_progress');
    expect(steps).toContain('state:success');
    // Order: pending before in_progress before success
    expect(steps.indexOf('state:pending')).toBeLessThan(steps.indexOf('state:in_progress'));
    expect(steps.indexOf('state:in_progress')).toBeLessThan(steps.indexOf('state:success'));
  });

  it('logs provision_result to provisioning_operation_logs', async () => {
    const db = new InMemoryDb();
    const adapter = makeAdapter(db);
    await adapter.provisionIdempotent('app-1', 'key-1', CONFIG);

    const resultLog = db.logs.find((l) => l.step === 'provision_result');
    expect(resultLog).toBeDefined();
    expect(resultLog!.result.resourceId).toBe('res-123');
    expect(resultLog!.result.credentials).toEqual({ token: 'abc' });
  });
});

describe('ProviderAdapter.provisionIdempotent – idempotency', () => {
  it('returns cached result for duplicate idempotency key', async () => {
    const db = new InMemoryDb();
    const adapter = makeAdapter(db);

    // First call
    await adapter.provisionIdempotent('app-1', 'key-1', CONFIG);

    // Track provision calls
    let secondProvisionCalled = false;
    adapter.provisionImpl = async () => {
      secondProvisionCalled = true;
      return { ...MOCK_RESULT, resourceId: 'NEW-resource' };
    };

    // Second call with same key
    const result = await adapter.provisionIdempotent('app-1', 'key-1', CONFIG);
    expect(secondProvisionCalled).toBe(false);
    expect(result.success).toBe(true);
    expect(result.resourceId).toBe('res-123'); // original cached value
    expect(result.metadata.cached).toBe(true);
  });

  it('does not retry provision when idempotency cache hit', async () => {
    const db = new InMemoryDb();
    let provisionCalls = 0;
    const adapter = makeAdapter(db);
    adapter.provisionImpl = async () => {
      provisionCalls++;
      return MOCK_RESULT;
    };

    await adapter.provisionIdempotent('app-1', 'key-abc', CONFIG);
    expect(provisionCalls).toBe(1);

    await adapter.provisionIdempotent('app-1', 'key-abc', CONFIG);
    // Provision should NOT be called again
    expect(provisionCalls).toBe(1);
  });
});

describe('ProviderAdapter.provisionIdempotent – failure handling', () => {
  it('transitions to failed state on provision error', async () => {
    const db = new InMemoryDb();
    const adapter = makeAdapter(db);
    adapter.provisionImpl = async () => {
      throw new Error('API unavailable');
    };

    const result = await adapter.provisionIdempotent('app-1', 'key-fail', CONFIG);
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('API unavailable');

    const op = db.operations.find((o) => o.idempotency_key === 'key-fail');
    expect(op!.status).toBe('failed');
  });

  it('logs state:failed transition on error', async () => {
    const db = new InMemoryDb();
    const adapter = makeAdapter(db);
    adapter.provisionImpl = async () => { throw new Error('boom'); };

    await adapter.provisionIdempotent('app-1', 'key-fail', CONFIG);

    const failLog = db.logs.find((l) => l.step === 'state:failed');
    expect(failLog).toBeDefined();
    expect(failLog!.result.error).toBe('boom');
  });

  it('retries on rate-limit errors before failing', async () => {
    const db = new InMemoryDb();
    const rl = new RateLimiter({ sleep: noSleep, maxRetries: 2, initialDelay: 1, maxDelay: 60_000 });
    const adapter = makeAdapter(db, rl);

    let calls = 0;
    adapter.provisionImpl = async () => {
      calls++;
      if (calls < 3) throw new Error('HTTP 429 Too Many Requests');
      return MOCK_RESULT;
    };

    const result = await adapter.provisionIdempotent('app-1', 'key-retry', CONFIG);
    expect(result.success).toBe(true);
    expect(calls).toBe(3);
  });
});

describe('ProviderConfig defaults', () => {
  it('accepts ProviderConfig with optional apiSecret', () => {
    const config: ProviderConfig = {
      apiKey: 'key',
      baseUrl: 'https://example.com',
      timeout: 30_000,
    };
    expect(config.apiSecret).toBeUndefined();
  });

  it('accepts ProviderConfig with null apiSecret', () => {
    const config: ProviderConfig = {
      apiKey: 'key',
      apiSecret: null,
      baseUrl: 'https://example.com',
      timeout: 30_000,
    };
    expect(config.apiSecret).toBeNull();
  });
});
