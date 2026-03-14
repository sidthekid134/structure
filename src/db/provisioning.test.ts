import { LockTimeoutError } from '../credentials/operation-lock';

// Mock pg before importing the module under test
const mockRelease = jest.fn();
const mockQuery = jest.fn();
const mockConnect = jest.fn();

jest.mock('pg', () => {
  return {
    Pool: jest.fn().mockImplementation(() => ({
      connect: mockConnect,
    })),
  };
});

import { Pool } from 'pg';
import { initPool, acquireLock, releaseLock, queueOperation } from './provisioning';

function makeMockClient(queryResponses: Array<any> = []): { query: jest.Mock; release: jest.Mock } {
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

describe('provisioning db', () => {
  let mockPool: { connect: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { connect: mockConnect };
    initPool(mockPool as unknown as Pool);
  });

  describe('acquireLock', () => {
    it('acquires lock and returns lockId', async () => {
      const client = makeMockClient([
        { rows: [] }, // BEGIN
        { rows: [] }, // SET LOCAL lock_timeout
        { rows: [] }, // pg_advisory_xact_lock
      ]);
      mockConnect.mockResolvedValue(client);

      const lockId = await acquireLock('my-app', 'dev', 5000);

      expect(typeof lockId).toBe('string');
      expect(client.query).toHaveBeenCalledWith('BEGIN');
      expect(client.query).toHaveBeenCalledWith("SET LOCAL lock_timeout = '5000ms'");
      expect(client.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock($1::bigint)',
        expect.any(Array)
      );
      // Client should NOT be released — it holds the lock
      expect(client.release).not.toHaveBeenCalled();
    });

    it('throws LockTimeoutError on lock_timeout (55P03)', async () => {
      const lockError = Object.assign(new Error('lock timeout'), { code: '55P03' });
      const client = makeMockClient([
        { rows: [] },  // BEGIN
        { rows: [] },  // SET LOCAL lock_timeout
        lockError,     // pg_advisory_xact_lock fails
        { rows: [] },  // ROLLBACK
      ]);
      mockConnect.mockResolvedValue(client);

      await expect(acquireLock('my-app', 'production', 100)).rejects.toThrow(LockTimeoutError);
      expect(client.release).toHaveBeenCalled();
    });

    it('re-throws non-timeout errors', async () => {
      const dbError = Object.assign(new Error('connection refused'), { code: '08006' });
      const client = makeMockClient([
        { rows: [] }, // BEGIN
        { rows: [] }, // SET LOCAL lock_timeout
        dbError,      // pg_advisory_xact_lock fails
        { rows: [] }, // ROLLBACK
      ]);
      mockConnect.mockResolvedValue(client);

      await expect(acquireLock('my-app', 'preview', 1000)).rejects.toThrow('connection refused');
      expect(client.release).toHaveBeenCalled();
    });

    it('generates consistent lock key for same app+environment', async () => {
      const lockIds: string[] = [];
      for (let i = 0; i < 2; i++) {
        const client = makeMockClient([{ rows: [] }, { rows: [] }, { rows: [] }]);
        mockConnect.mockResolvedValue(client);
        const lockId = await acquireLock('stable-app', 'dev', 1000);
        lockIds.push(lockId);
      }
      expect(lockIds[0]).toBe(lockIds[1]);
    });

    it('generates different lock keys for different environments', async () => {
      const lockIds: string[] = [];
      for (const env of ['dev', 'preview', 'production'] as const) {
        const client = makeMockClient([{ rows: [] }, { rows: [] }, { rows: [] }]);
        mockConnect.mockResolvedValue(client);
        lockIds.push(await acquireLock('my-app', env, 1000));
      }
      const unique = new Set(lockIds);
      expect(unique.size).toBe(3);
    });
  });

  describe('releaseLock', () => {
    it('commits transaction and releases client', async () => {
      const lockClient = makeMockClient([{ rows: [] }, { rows: [] }, { rows: [] }]);
      mockConnect.mockResolvedValue(lockClient);
      const lockId = await acquireLock('release-app', 'dev', 1000);

      const queueClient = makeMockClient([{ rows: [] }]); // queue update
      mockConnect.mockResolvedValue(queueClient);

      await releaseLock(lockId);

      expect(lockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(lockClient.release).toHaveBeenCalled();
    });

    it('is a no-op for unknown lockId', async () => {
      await expect(releaseLock('999999')).resolves.toBeUndefined();
    });

    it('triggers queue processing for next queued item', async () => {
      const lockClient = makeMockClient([{ rows: [] }, { rows: [] }, { rows: [] }]);
      mockConnect.mockResolvedValueOnce(lockClient);

      const lockId = await acquireLock('queue-app', 'production', 1000);

      const queueClient = makeMockClient([{ rows: [] }]);
      mockConnect.mockResolvedValueOnce(queueClient);

      await releaseLock(lockId);

      expect(queueClient.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'processing'"),
        ['queue-app', 'production']
      );
      expect(queueClient.release).toHaveBeenCalled();
    });
  });

  describe('queueOperation', () => {
    it('inserts into provisioning_queue', async () => {
      const client = makeMockClient([{ rows: [] }]);
      mockConnect.mockResolvedValue(client);

      await queueOperation('op-123', 'github', 1, []);

      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO provisioning_queue'),
        expect.arrayContaining(['op-123', 'github', 1])
      );
      expect(client.release).toHaveBeenCalled();
    });

    it('inserts dependency rows for each dependency', async () => {
      const client = makeMockClient([
        { rows: [] }, // queue insert
        { rows: [] }, // dep 1
        { rows: [] }, // dep 2
      ]);
      mockConnect.mockResolvedValue(client);

      await queueOperation('op-456', 'firebase', 2, ['github', 'openai']);

      const calls = client.query.mock.calls;
      const depCalls = calls.filter(([sql]: [string]) =>
        sql.includes('INSERT INTO provisioning_dependencies')
      );
      expect(depCalls).toHaveLength(2);
      expect(depCalls[0][1]).toContain('github');
      expect(depCalls[1][1]).toContain('openai');
      expect(client.release).toHaveBeenCalled();
    });

    it('releases client even when no dependencies', async () => {
      const client = makeMockClient([{ rows: [] }]);
      mockConnect.mockResolvedValue(client);

      await queueOperation('op-789', 'anthropic', 0, []);

      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });
});
