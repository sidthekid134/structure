/**
 * Integration tests for the provisioning orchestration layer.
 *
 * These tests verify end-to-end flows: multi-adapter sequences, database state
 * transitions, error recovery, and concurrent operation handling.
 */

import { LockTimeoutError } from '../credentials/operation-lock';

// Mock pg before any imports that depend on it
const mockConnect = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ connect: mockConnect })),
}));

const mockAcquireLock = jest.fn();
const mockReleaseLock = jest.fn();
const mockQueueOperation = jest.fn();
const mockInitPool = jest.fn();

jest.mock('../db/provisioning', () => ({
  acquireLock: (...args: unknown[]) => mockAcquireLock(...args),
  releaseLock: (...args: unknown[]) => mockReleaseLock(...args),
  queueOperation: (...args: unknown[]) => mockQueueOperation(...args),
  initPool: (...args: unknown[]) => mockInitPool(...args),
}));

jest.mock('../credentials/vault');

import { Pool } from 'pg';
import { Vault } from '../credentials/vault';
import { CredentialResolver } from '../services/credential-resolver';
import { AdapterExecutor } from '../services/adapter-executor';
import { ProvisioningOrchestrator, AdapterDefinition } from '../services/provisioning-orchestrator';
import {
  createMockOperation,
  createMockAdapter,
  createMockCredentials,
  createMockClient,
  createLinearAdapterChain,
  createDiamondAdapterChain,
  createMockQueueEntry,
} from './provisioning-fixtures';

/**
 * Sets up mockConnect to return an insert client (returning operationId) for the
 * first call, and an empty client for all subsequent calls.
 */
function setupMockPool(operationId: string): { insertClient: ReturnType<typeof createMockClient> } {
  const insertClient = createMockClient([{ rows: [{ id: operationId }] }]);
  const emptyClient = () => ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  });

  mockConnect.mockImplementationOnce(() => Promise.resolve(insertClient));
  mockConnect.mockImplementation(() => Promise.resolve(emptyClient()));

  return { insertClient };
}

function buildOrchestrator(): {
  pool: Pool;
  mockVault: jest.Mocked<Vault>;
  credentialResolver: CredentialResolver;
  adapterExecutor: AdapterExecutor;
  orchestrator: ProvisioningOrchestrator;
} {
  const pool = new Pool() as Pool;
  const mockVault = new (Vault as jest.MockedClass<typeof Vault>)('password') as jest.Mocked<Vault>;
  mockVault.list.mockReturnValue(['api_key', 'secret']);
  mockVault.retrieve.mockImplementation((_provider, key) => {
    if (key === 'api_key') return 'test-api-key-abc123';
    if (key === 'secret') return 'test-secret-xyz789';
    return '';
  });
  const credentialResolver = new CredentialResolver(mockVault);
  const adapterExecutor = new AdapterExecutor();
  const orchestrator = new ProvisioningOrchestrator(pool, credentialResolver, adapterExecutor);
  return { pool, mockVault, credentialResolver, adapterExecutor, orchestrator };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Provisioning fixtures: createMockOperation', () => {
  it('returns correct defaults', () => {
    const op = createMockOperation();
    expect(op.id).toBe('op-test-001');
    expect(op.app_id).toBe('test-app');
    expect(op.status).toBe('pending');
    expect(op.environment).toBe('dev');
    expect(op.error_message).toBeNull();
    expect(op.lock_acquired_at).toBeNull();
  });

  it('accepts partial overrides without changing other fields', () => {
    const op = createMockOperation({ id: 'custom-op', status: 'completed', app_id: 'my-app' });
    expect(op.id).toBe('custom-op');
    expect(op.status).toBe('completed');
    expect(op.app_id).toBe('my-app');
    expect(op.environment).toBe('dev'); // unchanged
  });

  it('all valid statuses can be set', () => {
    for (const status of ['pending', 'in_progress', 'completed', 'failed'] as const) {
      const op = createMockOperation({ status });
      expect(op.status).toBe(status);
    }
  });
});

describe('Provisioning fixtures: createMockAdapter', () => {
  it('returns correct structure', () => {
    const adapter = createMockAdapter('github', 'github', ['setup']);
    expect(adapter.name).toBe('github');
    expect(adapter.providerName).toBe('github');
    expect(adapter.dependencies).toEqual(['setup']);
  });

  it('uses empty dependencies by default', () => {
    const adapter = createMockAdapter('openai', 'openai');
    expect(adapter.dependencies).toEqual([]);
  });
});

describe('Provisioning fixtures: createMockCredentials', () => {
  it('returns default credential fields', () => {
    const creds = createMockCredentials();
    expect(creds.api_key).toBe('test-api-key-abc123');
    expect(creds.secret).toBe('test-secret-xyz789');
  });

  it('accepts overrides and merges with defaults', () => {
    const creds = createMockCredentials({ api_key: 'custom-key', extra: 'value' });
    expect(creds.api_key).toBe('custom-key');
    expect(creds.extra).toBe('value');
    expect(creds.secret).toBe('test-secret-xyz789');
  });
});

describe('Provisioning fixtures: createMockQueueEntry', () => {
  it('returns correct defaults', () => {
    const entry = createMockQueueEntry();
    expect(entry.id).toBe('queue-entry-001');
    expect(entry.operation_id).toBe('op-test-001');
    expect(entry.status).toBe('queued');
    expect(entry.position).toBe(0);
  });

  it('accepts overrides', () => {
    const entry = createMockQueueEntry({ status: 'processing', position: 2 });
    expect(entry.status).toBe('processing');
    expect(entry.position).toBe(2);
  });
});

describe('Provisioning fixtures: createLinearAdapterChain', () => {
  it('builds correct dependency chain for 3 adapters', () => {
    const chain = createLinearAdapterChain([
      { name: 'a', providerName: 'p1' },
      { name: 'b', providerName: 'p2' },
      { name: 'c', providerName: 'p3' },
    ]);
    expect(chain[0].dependencies).toEqual([]);
    expect(chain[1].dependencies).toEqual(['a']);
    expect(chain[2].dependencies).toEqual(['b']);
  });

  it('single adapter chain has no dependencies', () => {
    const chain = createLinearAdapterChain([{ name: 'solo', providerName: 'p' }]);
    expect(chain[0].dependencies).toEqual([]);
  });
});

describe('Provisioning fixtures: createDiamondAdapterChain', () => {
  it('builds diamond dependency structure A -> [B, C] -> D', () => {
    const chain = createDiamondAdapterChain();
    expect(chain).toHaveLength(4);
    expect(chain[0].name).toBe('diamond-a');
    expect(chain[0].dependencies).toEqual([]);
    expect(chain[1].dependencies).toEqual(['diamond-a']);
    expect(chain[2].dependencies).toEqual(['diamond-a']);
    expect(chain[3].dependencies).toContain('diamond-b');
    expect(chain[3].dependencies).toContain('diamond-c');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end multi-adapter flows
// ─────────────────────────────────────────────────────────────────────────────

describe('Provisioning Integration: end-to-end multi-adapter flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReleaseLock.mockResolvedValue(undefined);
    mockQueueOperation.mockResolvedValue(undefined);
  });

  it('executes a 3-adapter linear chain in dependency order', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();
    const executionOrder: string[] = [];

    adapterExecutor.registerAdapter('setup', async () => {
      executionOrder.push('setup');
      return { projectId: 'proj-123' };
    });
    adapterExecutor.registerAdapter('configure', async () => {
      executionOrder.push('configure');
      return { configId: 'cfg-456' };
    });
    adapterExecutor.registerAdapter('deploy', async () => {
      executionOrder.push('deploy');
      return { deployed: true };
    });

    const sequence = createLinearAdapterChain([
      { name: 'setup', providerName: 'github' },
      { name: 'configure', providerName: 'aws' },
      { name: 'deploy', providerName: 'heroku' },
    ]);

    setupMockPool('op-e2e-linear');
    mockAcquireLock.mockResolvedValue('lock-e2e-linear');

    const result = await orchestrator.executeProvisioning('e2e-app', 'dev', sequence, 5000);

    expect(result.status).toBe('completed');
    expect(result.operationId).toBe('op-e2e-linear');
    expect(result.adapterResults).toHaveLength(3);
    expect(result.adapterResults.every((r) => r.success)).toBe(true);
    expect(executionOrder).toEqual(['setup', 'configure', 'deploy']);
  });

  it('passes output data between dependent adapters in the chain', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();

    const configureInputs: Record<string, unknown> = {};
    const deployInputs: Record<string, unknown> = {};

    adapterExecutor.registerAdapter('provision', async () => ({
      instanceId: 'i-abc123',
      region: 'us-east-1',
    }));
    adapterExecutor.registerAdapter('configure', async (inputs) => {
      Object.assign(configureInputs, inputs);
      return { configId: 'cfg-456' };
    });
    adapterExecutor.registerAdapter('deploy', async (inputs) => {
      Object.assign(deployInputs, inputs);
      return { url: 'https://app.example.com' };
    });

    const sequence: AdapterDefinition[] = [
      createMockAdapter('provision', 'aws'),
      createMockAdapter('configure', 'aws', ['provision']),
      createMockAdapter('deploy', 'heroku', ['configure']),
    ];

    setupMockPool('op-data-flow');
    mockAcquireLock.mockResolvedValue('lock-data-flow');

    const result = await orchestrator.executeProvisioning('data-app', 'production', sequence, 5000);

    expect(result.status).toBe('completed');
    expect(configureInputs).toMatchObject({ instanceId: 'i-abc123', region: 'us-east-1' });
    expect(deployInputs).toMatchObject({ configId: 'cfg-456' });
  });

  it('marks operation as failed and releases lock when middle adapter fails', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();
    const executionOrder: string[] = [];

    adapterExecutor.registerAdapter('step1', async () => {
      executionOrder.push('step1');
      return { data: 'step1-output' };
    });
    adapterExecutor.registerAdapter('step2', async () => {
      executionOrder.push('step2');
      throw new Error('step2 deployment failed');
    });
    adapterExecutor.registerAdapter('step3', async () => {
      executionOrder.push('step3');
      return {};
    });

    const sequence: AdapterDefinition[] = [
      createMockAdapter('step1', 'provider1'),
      createMockAdapter('step2', 'provider2', ['step1']),
      createMockAdapter('step3', 'provider3', ['step2']),
    ];

    setupMockPool('op-fail-mid');
    mockAcquireLock.mockResolvedValue('lock-fail-mid');

    const result = await orchestrator.executeProvisioning('fail-app', 'dev', sequence, 5000);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('step2 deployment failed');
    expect(executionOrder).toEqual(['step1', 'step2']); // step3 not executed
    expect(mockReleaseLock).toHaveBeenCalled();
  });

  it('credentials are resolved from vault and passed to each adapter', async () => {
    const { adapterExecutor, orchestrator, mockVault } = buildOrchestrator();

    const receivedCredentials: Array<Record<string, string>> = [];
    adapterExecutor.registerAdapter('adapter1', async (_inputs, creds) => {
      receivedCredentials.push({ ...creds });
      return {};
    });
    adapterExecutor.registerAdapter('adapter2', async (_inputs, creds) => {
      receivedCredentials.push({ ...creds });
      return {};
    });

    mockVault.list.mockImplementation((provider) => {
      if (provider === 'github') return ['token'];
      if (provider === 'aws') return ['access_key', 'secret_key'];
      return [];
    });
    mockVault.retrieve.mockImplementation((provider, key) => {
      if (provider === 'github' && key === 'token') return 'ghp_test123';
      if (provider === 'aws' && key === 'access_key') return 'AKIATEST';
      if (provider === 'aws' && key === 'secret_key') return 'secrettest';
      return '';
    });

    const sequence: AdapterDefinition[] = [
      createMockAdapter('adapter1', 'github'),
      createMockAdapter('adapter2', 'aws'),
    ];

    setupMockPool('op-creds');
    mockAcquireLock.mockResolvedValue('lock-creds');

    const result = await orchestrator.executeProvisioning('creds-app', 'dev', sequence, 5000);

    expect(result.status).toBe('completed');
    expect(receivedCredentials[0]).toEqual({ token: 'ghp_test123' });
    expect(receivedCredentials[1]).toEqual({ access_key: 'AKIATEST', secret_key: 'secrettest' });
  });

  it('marks operation failed when credentials are missing for a provider', async () => {
    const { adapterExecutor, orchestrator, mockVault } = buildOrchestrator();

    mockVault.list.mockReturnValue([]); // No credentials for any provider

    adapterExecutor.registerAdapter('needs-creds', async () => ({}));

    const sequence: AdapterDefinition[] = [createMockAdapter('needs-creds', 'missing-provider')];

    setupMockPool('op-no-creds');
    mockAcquireLock.mockResolvedValue('lock-no-creds');

    const result = await orchestrator.executeProvisioning('no-creds-app', 'dev', sequence, 5000);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('No credentials found for provider "missing-provider"');
    expect(mockReleaseLock).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lock behavior and concurrency
// ─────────────────────────────────────────────────────────────────────────────

describe('Provisioning Integration: lock behavior and concurrency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReleaseLock.mockResolvedValue(undefined);
    mockQueueOperation.mockResolvedValue(undefined);
  });

  it('concurrent operations on the same app queue the second request', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();
    adapterExecutor.registerAdapter('worker', async () => ({}));

    const sequence: AdapterDefinition[] = [createMockAdapter('worker', 'provider')];

    // First operation succeeds
    setupMockPool('op-concurrent-1');
    mockAcquireLock.mockResolvedValueOnce('lock-concurrent-1');

    const result1 = await orchestrator.executeProvisioning('concurrent-app', 'dev', sequence, 5000);
    expect(result1.status).toBe('completed');

    // Second operation times out (same app)
    setupMockPool('op-concurrent-2');
    mockAcquireLock.mockRejectedValueOnce(new LockTimeoutError('concurrent-app'));

    const result2 = await orchestrator.executeProvisioning('concurrent-app', 'dev', sequence, 100);
    expect(result2.status).toBe('queued');
    expect(mockQueueOperation).toHaveBeenCalledWith('op-concurrent-2', 'worker', 0, []);
  });

  it('concurrent operations on different apps both succeed', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();
    adapterExecutor.registerAdapter('task', async () => ({ done: true }));

    const sequence: AdapterDefinition[] = [createMockAdapter('task', 'provider')];

    mockAcquireLock.mockResolvedValue('lock-any');

    // App 1
    setupMockPool('op-app1');
    const result1 = await orchestrator.executeProvisioning('app1', 'dev', sequence, 5000);

    // App 2
    setupMockPool('op-app2');
    const result2 = await orchestrator.executeProvisioning('app2', 'dev', sequence, 5000);

    expect(result1.status).toBe('completed');
    expect(result2.status).toBe('completed');
    expect(mockAcquireLock).toHaveBeenCalledWith('app1', 'dev', 5000);
    expect(mockAcquireLock).toHaveBeenCalledWith('app2', 'dev', 5000);
  });

  it('lock is always released even when adapter sequence fails', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();

    adapterExecutor.registerAdapter('crasher', async () => {
      throw new Error('Unexpected crash');
    });

    const sequence: AdapterDefinition[] = [createMockAdapter('crasher', 'provider')];

    setupMockPool('op-crash');
    mockAcquireLock.mockResolvedValue('lock-crash');

    const result = await orchestrator.executeProvisioning('crash-app', 'dev', sequence, 5000);

    expect(result.status).toBe('failed');
    expect(mockReleaseLock).toHaveBeenCalledWith('lock-crash');
  });

  it('queued operations store all adapters with correct positions and dependencies', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();

    adapterExecutor.registerAdapter('step-a', async () => ({}));
    adapterExecutor.registerAdapter('step-b', async () => ({}));
    adapterExecutor.registerAdapter('step-c', async () => ({}));

    const sequence: AdapterDefinition[] = [
      createMockAdapter('step-a', 'p1'),
      createMockAdapter('step-b', 'p2', ['step-a']),
      createMockAdapter('step-c', 'p3', ['step-b']),
    ];

    setupMockPool('op-queue-all');
    mockAcquireLock.mockRejectedValue(new LockTimeoutError('queue-app'));

    const result = await orchestrator.executeProvisioning('queue-app', 'dev', sequence, 100);

    expect(result.status).toBe('queued');
    expect(mockQueueOperation).toHaveBeenCalledTimes(3);
    expect(mockQueueOperation).toHaveBeenCalledWith('op-queue-all', 'step-a', 0, []);
    expect(mockQueueOperation).toHaveBeenCalledWith('op-queue-all', 'step-b', 1, ['step-a']);
    expect(mockQueueOperation).toHaveBeenCalledWith('op-queue-all', 'step-c', 2, ['step-b']);
  });

  it('returns lock_timeout error message when operation is queued', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();
    adapterExecutor.registerAdapter('any', async () => ({}));

    const sequence: AdapterDefinition[] = [createMockAdapter('any', 'provider')];

    setupMockPool('op-timeout');
    mockAcquireLock.mockRejectedValue(new LockTimeoutError('timeout-app'));

    const result = await orchestrator.executeProvisioning('timeout-app', 'dev', sequence, 100);

    expect(result.status).toBe('queued');
    expect(result.error).toContain('Lock timeout');
    expect(result.adapterResults).toHaveLength(0);
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Database state verification
// ─────────────────────────────────────────────────────────────────────────────

describe('Provisioning Integration: database state verification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReleaseLock.mockResolvedValue(undefined);
    mockQueueOperation.mockResolvedValue(undefined);
  });

  it('creates operation record with correct appId and environment', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();
    adapterExecutor.registerAdapter('check', async () => ({}));

    const sequence: AdapterDefinition[] = [createMockAdapter('check', 'provider')];

    const { insertClient } = setupMockPool('op-db-check');
    mockAcquireLock.mockResolvedValue('lock-db-check');

    await orchestrator.executeProvisioning('db-app', 'production', sequence, 5000);

    const insertCall = insertClient.query.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO provisioning_operations');
    expect(insertCall[1]).toContain('db-app');
    expect(insertCall[1]).toContain('production');
  });

  it('updates operation status to in_progress after lock acquisition', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();
    adapterExecutor.registerAdapter('check', async () => ({}));

    const sequence: AdapterDefinition[] = [createMockAdapter('check', 'provider')];

    // Capture the second connect call (in_progress update)
    const insertClient = createMockClient([{ rows: [{ id: 'op-status-check' }] }]);
    const inProgressClient = createMockClient([{ rows: [] }]);

    mockConnect
      .mockResolvedValueOnce(insertClient)
      .mockResolvedValueOnce(inProgressClient)
      .mockImplementation(() =>
        Promise.resolve({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() })
      );

    mockAcquireLock.mockResolvedValue('lock-status-check');

    await orchestrator.executeProvisioning('status-app', 'dev', sequence, 5000);

    // updateOperationStatus('in_progress') uses parameterized SQL: SET status = $1, lock_acquired_at = $2
    const inProgressCall = inProgressClient.query.mock.calls[0];
    expect(inProgressCall[0]).toContain('provisioning_operations');
    expect(inProgressCall[1][0]).toBe('in_progress');
    expect(inProgressCall[1]).toContain('op-status-check');
  });

  it('stores error message in failed operation record', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();

    adapterExecutor.registerAdapter('error-adapter', async () => {
      throw new Error('Specific error message');
    });

    const sequence: AdapterDefinition[] = [createMockAdapter('error-adapter', 'provider')];

    // Capture clients to inspect the failed update call
    const insertClient = createMockClient([{ rows: [{ id: 'op-err-msg' }] }]);
    const inProgressClient = createMockClient([{ rows: [] }]);
    const queueProcessingClient = createMockClient([{ rows: [] }]);
    const queueFailedClient = createMockClient([{ rows: [] }]);
    const updateFailedClient = createMockClient([{ rows: [] }]);
    const processQueueClient = createMockClient([{ rows: [] }]);

    mockConnect
      .mockResolvedValueOnce(insertClient)
      .mockResolvedValueOnce(inProgressClient)
      .mockResolvedValueOnce(queueProcessingClient)
      .mockResolvedValueOnce(queueFailedClient)
      .mockResolvedValueOnce(updateFailedClient)
      .mockResolvedValueOnce(processQueueClient);

    mockAcquireLock.mockResolvedValue('lock-err-msg');

    const result = await orchestrator.executeProvisioning('err-app', 'dev', sequence, 5000);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Specific error message');

    // updateOperationStatus('failed') uses parameterized SQL: SET status = $1, error_message = $2
    const failedCall = updateFailedClient.query.mock.calls[0];
    expect(failedCall[0]).toContain('provisioning_operations');
    expect(failedCall[1][0]).toBe('failed');
    expect(failedCall[1][1]).toContain('Specific error message');
  });

  it('failed error message includes appId, environment, and operationId for context', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();

    adapterExecutor.registerAdapter('ctx-error', async () => {
      throw new Error('base error');
    });

    const sequence: AdapterDefinition[] = [createMockAdapter('ctx-error', 'provider')];

    setupMockPool('op-ctx');
    mockAcquireLock.mockResolvedValue('lock-ctx');

    const result = await orchestrator.executeProvisioning('ctx-app', 'preview', sequence, 5000);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('ctx-app');
    expect(result.error).toContain('preview');
    expect(result.error).toContain('op-ctx');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error recovery and retry
// ─────────────────────────────────────────────────────────────────────────────

describe('Provisioning Integration: error recovery and retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReleaseLock.mockResolvedValue(undefined);
    mockQueueOperation.mockResolvedValue(undefined);
  });

  it('queued operation is retried when subsequent operation triggers processQueue', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();
    adapterExecutor.registerAdapter('retryable', async () => ({ retried: true }));

    const sequence: AdapterDefinition[] = [createMockAdapter('retryable', 'provider')];

    // First call: times out, operation queued
    setupMockPool('op-retry-queued');
    mockAcquireLock.mockRejectedValueOnce(new LockTimeoutError('retry-app'));

    const result1 = await orchestrator.executeProvisioning('retry-app', 'dev', sequence, 100);
    expect(result1.status).toBe('queued');

    // Second call: succeeds. processQueue finds the queued op and re-runs it
    const insertClient2 = createMockClient([{ rows: [{ id: 'op-retry-second' }] }]);
    const processQueueClient = createMockClient([
      { rows: [{ operation_id: 'op-retry-queued' }] },
    ]);

    mockConnect
      .mockResolvedValueOnce(insertClient2)
      .mockResolvedValueOnce(createMockClient([{ rows: [] }])) // in_progress
      .mockResolvedValueOnce(createMockClient([{ rows: [] }])) // adapter processing
      .mockResolvedValueOnce(createMockClient([{ rows: [] }])) // adapter completed
      .mockResolvedValueOnce(createMockClient([{ rows: [] }])) // completed status
      .mockResolvedValueOnce(processQueueClient)               // processQueue finds queued op
      .mockImplementation(() =>
        Promise.resolve({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() })
      );

    mockAcquireLock.mockResolvedValue('lock-retry-second');

    const result2 = await orchestrator.executeProvisioning('retry-app', 'dev', sequence, 5000);
    expect(result2.status).toBe('completed');
    expect(result2.operationId).toBe('op-retry-second');

    // Allow background processing for the retried queued operation
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('non-LockTimeoutError during lock acquisition propagates and marks operation failed', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();
    adapterExecutor.registerAdapter('any', async () => ({}));

    const sequence: AdapterDefinition[] = [createMockAdapter('any', 'provider')];

    const insertClient = createMockClient([{ rows: [{ id: 'op-db-err' }] }]);
    const updateFailedClient = createMockClient([{ rows: [] }]);

    mockConnect
      .mockResolvedValueOnce(insertClient)
      .mockResolvedValueOnce(updateFailedClient);

    mockAcquireLock.mockRejectedValue(new Error('Connection pool exhausted'));

    await expect(
      orchestrator.executeProvisioning('err-app', 'dev', sequence, 5000)
    ).rejects.toThrow('Connection pool exhausted');

    const failedCall = updateFailedClient.query.mock.calls[0];
    expect(failedCall[1][0]).toBe('failed');
  });

  it('operation error message includes contextual information about which adapter failed', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();

    adapterExecutor.registerAdapter('failing-adapter', async () => {
      throw new Error('adapter-specific failure');
    });

    const sequence: AdapterDefinition[] = [createMockAdapter('failing-adapter', 'provider')];

    setupMockPool('op-ctx-err');
    mockAcquireLock.mockResolvedValue('lock-ctx-err');

    const result = await orchestrator.executeProvisioning('ctx-err-app', 'dev', sequence, 5000);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('adapter-specific failure');
    expect(result.error).toContain('ctx-err-app');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Diamond dependency pattern
// ─────────────────────────────────────────────────────────────────────────────

describe('Provisioning Integration: diamond dependency execution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReleaseLock.mockResolvedValue(undefined);
    mockQueueOperation.mockResolvedValue(undefined);
  });

  it('executes diamond pattern A -> [B, C] -> D in valid topological order', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();
    const executionOrder: string[] = [];

    adapterExecutor.registerAdapter('diamond-a', async () => {
      executionOrder.push('diamond-a');
      return { fromA: true };
    });
    adapterExecutor.registerAdapter('diamond-b', async () => {
      executionOrder.push('diamond-b');
      return { fromB: true };
    });
    adapterExecutor.registerAdapter('diamond-c', async () => {
      executionOrder.push('diamond-c');
      return { fromC: true };
    });
    adapterExecutor.registerAdapter('diamond-d', async () => {
      executionOrder.push('diamond-d');
      return { complete: true };
    });

    const sequence = createDiamondAdapterChain();

    setupMockPool('op-diamond');
    mockAcquireLock.mockResolvedValue('lock-diamond');

    const result = await orchestrator.executeProvisioning('diamond-app', 'dev', sequence, 5000);

    expect(result.status).toBe('completed');
    expect(result.adapterResults).toHaveLength(4);

    // diamond-a must execute first
    expect(executionOrder[0]).toBe('diamond-a');
    // diamond-d must execute last
    expect(executionOrder[3]).toBe('diamond-d');
    // diamond-b and diamond-c must both appear and before diamond-d
    const dIndex = executionOrder.indexOf('diamond-d');
    const bIndex = executionOrder.indexOf('diamond-b');
    const cIndex = executionOrder.indexOf('diamond-c');
    expect(bIndex).toBeGreaterThan(-1);
    expect(cIndex).toBeGreaterThan(-1);
    expect(bIndex).toBeLessThan(dIndex);
    expect(cIndex).toBeLessThan(dIndex);
  });

  it('all 4 adapters in diamond chain report success', async () => {
    const { adapterExecutor, orchestrator } = buildOrchestrator();

    adapterExecutor.registerAdapter('diamond-a', async () => ({}));
    adapterExecutor.registerAdapter('diamond-b', async () => ({}));
    adapterExecutor.registerAdapter('diamond-c', async () => ({}));
    adapterExecutor.registerAdapter('diamond-d', async () => ({}));

    const sequence = createDiamondAdapterChain();

    setupMockPool('op-diamond-success');
    mockAcquireLock.mockResolvedValue('lock-diamond-success');

    const result = await orchestrator.executeProvisioning('diamond-app2', 'preview', sequence, 5000);

    expect(result.adapterResults).toHaveLength(4);
    expect(result.adapterResults.every((r) => r.success)).toBe(true);
    const names = result.adapterResults.map((r) => r.adapterName);
    expect(names).toContain('diamond-a');
    expect(names).toContain('diamond-b');
    expect(names).toContain('diamond-c');
    expect(names).toContain('diamond-d');
  });
});
