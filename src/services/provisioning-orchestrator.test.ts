import { LockTimeoutError } from '../credentials/operation-lock';

// Mock pg before importing modules that depend on it
const mockRelease = jest.fn();
const mockQuery = jest.fn();
const mockConnect = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ connect: mockConnect })),
}));

// Mock the provisioning db module
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

// Mock vault
jest.mock('../credentials/vault');

import { Pool } from 'pg';
import { Vault } from '../credentials/vault';
import { CredentialResolver } from './credential-resolver';
import { AdapterExecutor } from './adapter-executor';
import { ProvisioningOrchestrator, AdapterDefinition } from './provisioning-orchestrator';

function makeMockClient(queryResponses: Array<any> = []): {
  query: jest.Mock;
  release: jest.Mock;
} {
  let callIndex = 0;
  const query = jest.fn().mockImplementation(() => {
    const response = queryResponses[callIndex] ?? { rows: [] };
    callIndex++;
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  });
  const release = jest.fn();
  return { query, release };
}

describe('ProvisioningOrchestrator', () => {
  let pool: Pool;
  let mockVault: jest.Mocked<Vault>;
  let credentialResolver: CredentialResolver;
  let adapterExecutor: AdapterExecutor;
  let orchestrator: ProvisioningOrchestrator;

  beforeEach(() => {
    jest.clearAllMocks();
    pool = new Pool() as Pool;
    mockVault = new (Vault as jest.MockedClass<typeof Vault>)('password') as jest.Mocked<Vault>;
    mockVault.list.mockReturnValue(['api_key']);
    mockVault.retrieve.mockReturnValue('test-value');
    credentialResolver = new CredentialResolver(mockVault);
    adapterExecutor = new AdapterExecutor();
    orchestrator = new ProvisioningOrchestrator(pool, credentialResolver, adapterExecutor);
    mockReleaseLock.mockResolvedValue(undefined);
    mockQueueOperation.mockResolvedValue(undefined);
  });

  describe('validateAdapterSequence (via executeProvisioning)', () => {
    it('throws when adapter sequence is empty', async () => {
      await expect(
        orchestrator.executeProvisioning('app1', 'dev', [], 5000)
      ).rejects.toThrow('Adapter sequence must not be empty');
    });

    it('throws when an adapter is not registered', async () => {
      const sequence: AdapterDefinition[] = [
        { name: 'unknown-adapter', providerName: 'openai', dependencies: [] },
      ];
      await expect(
        orchestrator.executeProvisioning('app1', 'dev', sequence, 5000)
      ).rejects.toThrow('Unknown adapter: unknown-adapter');
    });

    it('throws on circular dependency', async () => {
      adapterExecutor.registerAdapter('a', async () => ({}));
      adapterExecutor.registerAdapter('b', async () => ({}));
      const sequence: AdapterDefinition[] = [
        { name: 'a', providerName: 'openai', dependencies: ['b'] },
        { name: 'b', providerName: 'github', dependencies: ['a'] },
      ];
      await expect(
        orchestrator.executeProvisioning('app1', 'dev', sequence, 5000)
      ).rejects.toThrow('Circular dependency detected');
    });
  });

  describe('executeProvisioning - success path', () => {
    it('creates operation, acquires lock, executes adapters, and completes', async () => {
      adapterExecutor.registerAdapter('github', async () => ({ repoId: 'r-1' }));

      // createOperation -> INSERT RETURNING id
      const insertClient = makeMockClient([{ rows: [{ id: 'op-123' }] }]);
      // updateOperationStatus(in_progress)
      const updateInProgressClient = makeMockClient([{ rows: [] }]);
      // updateQueueItemStatus(processing)
      const queueProcessingClient = makeMockClient([{ rows: [] }]);
      // updateQueueItemStatus(completed)
      const queueCompletedClient = makeMockClient([{ rows: [] }]);
      // updateOperationStatus(completed)
      const updateCompletedClient = makeMockClient([{ rows: [] }]);
      // processQueue SELECT
      const processQueueClient = makeMockClient([{ rows: [] }]);

      mockConnect
        .mockResolvedValueOnce(insertClient)
        .mockResolvedValueOnce(updateInProgressClient)
        .mockResolvedValueOnce(queueProcessingClient)
        .mockResolvedValueOnce(queueCompletedClient)
        .mockResolvedValueOnce(updateCompletedClient)
        .mockResolvedValueOnce(processQueueClient);

      mockAcquireLock.mockResolvedValue('lock-id-1');

      const sequence: AdapterDefinition[] = [
        { name: 'github', providerName: 'github', dependencies: [] },
      ];

      const result = await orchestrator.executeProvisioning('my-app', 'dev', sequence, 5000);

      expect(result.status).toBe('completed');
      expect(result.operationId).toBe('op-123');
      expect(result.adapterResults).toHaveLength(1);
      expect(result.adapterResults[0].success).toBe(true);
      expect(mockAcquireLock).toHaveBeenCalledWith('my-app', 'dev', 5000);
      expect(mockReleaseLock).toHaveBeenCalledWith('lock-id-1');
    });

    it('marks operation as failed when an adapter fails', async () => {
      adapterExecutor.registerAdapter('github', async () => {
        throw new Error('GitHub API error');
      });

      const insertClient = makeMockClient([{ rows: [{ id: 'op-456' }] }]);
      const updateInProgressClient = makeMockClient([{ rows: [] }]);
      const queueProcessingClient = makeMockClient([{ rows: [] }]);
      const queueFailedClient = makeMockClient([{ rows: [] }]);
      const updateFailedClient = makeMockClient([{ rows: [] }]);
      const processQueueClient = makeMockClient([{ rows: [] }]);

      mockConnect
        .mockResolvedValueOnce(insertClient)
        .mockResolvedValueOnce(updateInProgressClient)
        .mockResolvedValueOnce(queueProcessingClient)
        .mockResolvedValueOnce(queueFailedClient)
        .mockResolvedValueOnce(updateFailedClient)
        .mockResolvedValueOnce(processQueueClient);

      mockAcquireLock.mockResolvedValue('lock-id-2');

      const sequence: AdapterDefinition[] = [
        { name: 'github', providerName: 'github', dependencies: [] },
      ];

      const result = await orchestrator.executeProvisioning('my-app', 'production', sequence, 5000);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('GitHub API error');
      expect(mockReleaseLock).toHaveBeenCalled();

      // Verify failed status update
      const failedUpdateCall = updateFailedClient.query.mock.calls[0];
      expect(failedUpdateCall[0]).toContain("status = $1");
      expect(failedUpdateCall[1][0]).toBe('failed');
    });
  });

  describe('executeProvisioning - lock timeout / queuing', () => {
    it('queues operation and returns queued status on lock timeout', async () => {
      adapterExecutor.registerAdapter('openai', async () => ({}));

      const insertClient = makeMockClient([{ rows: [{ id: 'op-queued' }] }]);
      mockConnect.mockResolvedValueOnce(insertClient);

      mockAcquireLock.mockRejectedValue(new LockTimeoutError('my-app'));

      const sequence: AdapterDefinition[] = [
        { name: 'openai', providerName: 'openai', dependencies: [] },
      ];

      const result = await orchestrator.executeProvisioning('my-app', 'dev', sequence, 1000);

      expect(result.status).toBe('queued');
      expect(result.operationId).toBe('op-queued');
      expect(mockQueueOperation).toHaveBeenCalledWith('op-queued', 'openai', 0, []);
      expect(mockReleaseLock).not.toHaveBeenCalled();
    });
  });

  describe('executeAdapterSequence', () => {
    it('executes adapters in dependency order', async () => {
      const executionOrder: string[] = [];
      adapterExecutor.registerAdapter('a', async () => {
        executionOrder.push('a');
        return { fromA: true };
      });
      adapterExecutor.registerAdapter('b', async () => {
        executionOrder.push('b');
        return { fromB: true };
      });
      adapterExecutor.registerAdapter('c', async () => {
        executionOrder.push('c');
        return {};
      });

      // b depends on a, c depends on b
      const adapters: AdapterDefinition[] = [
        { name: 'c', providerName: 'p1', dependencies: ['b'] },
        { name: 'b', providerName: 'p2', dependencies: ['a'] },
        { name: 'a', providerName: 'p3', dependencies: [] },
      ];

      // Each updateQueueItemStatus call needs a client (processing + completed for each adapter = 6)
      for (let i = 0; i < 6; i++) {
        mockConnect.mockResolvedValueOnce(makeMockClient([{ rows: [] }]));
      }

      await orchestrator.executeAdapterSequence('op-order', adapters);

      expect(executionOrder).toEqual(['a', 'b', 'c']);
    });

    it('passes outputs from previous adapters as inputs to dependents', async () => {
      const bInputs: Record<string, unknown> = {};
      adapterExecutor.registerAdapter('a', async () => ({ repoId: 'r-42' }));
      adapterExecutor.registerAdapter('b', async (inputs) => {
        Object.assign(bInputs, inputs);
        return {};
      });

      const adapters: AdapterDefinition[] = [
        { name: 'a', providerName: 'openai', dependencies: [] },
        { name: 'b', providerName: 'github', dependencies: ['a'] },
      ];

      for (let i = 0; i < 4; i++) {
        mockConnect.mockResolvedValueOnce(makeMockClient([{ rows: [] }]));
      }

      await orchestrator.executeAdapterSequence('op-pass', adapters);

      expect(bInputs).toMatchObject({ repoId: 'r-42' });
    });

    it('throws and marks adapter failed when execution fails', async () => {
      adapterExecutor.registerAdapter('failing', async () => {
        throw new Error('Adapter error');
      });

      const adapters: AdapterDefinition[] = [
        { name: 'failing', providerName: 'openai', dependencies: [] },
      ];

      // processing + failed status updates
      mockConnect
        .mockResolvedValueOnce(makeMockClient([{ rows: [] }]))
        .mockResolvedValueOnce(makeMockClient([{ rows: [] }]));

      await expect(
        orchestrator.executeAdapterSequence('op-fail', adapters)
      ).rejects.toThrow('Adapter error');
    });
  });

  describe('queue processing', () => {
    it('processes next queued operation after lock release', async () => {
      adapterExecutor.registerAdapter('openai', async () => ({}));

      const insertClient1 = makeMockClient([{ rows: [{ id: 'op-1' }] }]);
      mockConnect.mockResolvedValueOnce(insertClient1);
      mockAcquireLock.mockRejectedValueOnce(new LockTimeoutError('my-app'));

      const sequence: AdapterDefinition[] = [
        { name: 'openai', providerName: 'openai', dependencies: [] },
      ];

      // Queue op-1
      await orchestrator.executeProvisioning('my-app', 'dev', sequence, 1000);

      // Now simulate second call that succeeds and triggers queue processing
      const insertClient2 = makeMockClient([{ rows: [{ id: 'op-2' }] }]);
      const updateInProgressClient = makeMockClient([{ rows: [] }]);
      const queueProcessingClient = makeMockClient([{ rows: [] }]);
      const queueCompletedClient = makeMockClient([{ rows: [] }]);
      const updateCompletedClient = makeMockClient([{ rows: [] }]);
      // processQueue finds op-1 as processing
      const processQueueClient = makeMockClient([{ rows: [{ operation_id: 'op-1' }] }]);
      // Recursive call for op-1 clients
      const insertClient3 = makeMockClient([{ rows: [{ id: 'op-3' }] }]);
      const updateInProgress2 = makeMockClient([{ rows: [] }]);
      const queueProcessing2 = makeMockClient([{ rows: [] }]);
      const queueCompleted2 = makeMockClient([{ rows: [] }]);
      const updateCompleted2 = makeMockClient([{ rows: [] }]);
      const processQueue2 = makeMockClient([{ rows: [] }]);

      mockConnect
        .mockResolvedValueOnce(insertClient2)
        .mockResolvedValueOnce(updateInProgressClient)
        .mockResolvedValueOnce(queueProcessingClient)
        .mockResolvedValueOnce(queueCompletedClient)
        .mockResolvedValueOnce(updateCompletedClient)
        .mockResolvedValueOnce(processQueueClient)
        .mockResolvedValue(makeMockClient([{ rows: [] }]));

      mockAcquireLock.mockResolvedValue('lock-id-2');

      const result = await orchestrator.executeProvisioning('my-app', 'dev', sequence, 5000);

      expect(result.status).toBe('completed');
      // Allow any background async work to complete
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });
});
