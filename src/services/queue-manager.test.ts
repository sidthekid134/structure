import { QueueManager } from './queue-manager';
import { Pool, PoolClient } from 'pg';

function makeClient(queryImpl: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>): PoolClient {
  return {
    query: jest.fn().mockImplementation(queryImpl),
    release: jest.fn(),
  } as unknown as PoolClient;
}

function makePool(client: PoolClient): Pool {
  return {
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as Pool;
}

describe('QueueManager.getQueueStatus', () => {
  const now = new Date('2024-01-01T00:00:00Z');

  it('returns empty queue when no operations exist', async () => {
    const client = makeClient(async () => ({ rows: [] }));
    const pool = makePool(client);
    const manager = new QueueManager(pool);

    const result = await manager.getQueueStatus('app1', 'dev');

    expect(result.queueDepth).toBe(0);
    expect(result.currentOperation).toBeNull();
    expect(result.queuedOperations).toEqual([]);
    expect(client.release).toHaveBeenCalled();
  });

  it('returns current in_progress operation', async () => {
    const queries: { rows: unknown[] }[] = [
      {
        rows: [
          { id: 'op-1', status: 'in_progress', lock_acquired_at: now },
        ],
      },
      { rows: [] },
    ];
    let callCount = 0;
    const client = makeClient(async () => queries[callCount++]);
    const pool = makePool(client);
    const manager = new QueueManager(pool);

    const result = await manager.getQueueStatus('app1', 'dev');

    expect(result.currentOperation).toEqual({
      operationId: 'op-1',
      status: 'in_progress',
      lockAcquiredAt: now,
    });
    expect(result.queueDepth).toBe(0);
  });

  it('returns queued operations with correct position', async () => {
    const queries: { rows: unknown[] }[] = [
      { rows: [] },
      {
        rows: [
          { operation_id: 'op-2', position: 1, created_at: now },
          { operation_id: 'op-3', position: 2, created_at: new Date('2024-01-01T01:00:00Z') },
        ],
      },
    ];
    let callCount = 0;
    const client = makeClient(async () => queries[callCount++]);
    const pool = makePool(client);
    const manager = new QueueManager(pool);

    const result = await manager.getQueueStatus('app1', 'dev');

    expect(result.queueDepth).toBe(2);
    expect(result.queuedOperations[0]).toMatchObject({ operationId: 'op-2', position: 1 });
    expect(result.queuedOperations[1]).toMatchObject({ operationId: 'op-3', position: 2 });
  });

  it('releases client even on query error', async () => {
    const client = makeClient(async () => {
      throw new Error('DB error');
    });
    const pool = makePool(client);
    const manager = new QueueManager(pool);

    await expect(manager.getQueueStatus('app1', 'dev')).rejects.toThrow('DB error');
    expect(client.release).toHaveBeenCalled();
  });
});
