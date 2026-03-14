import request from 'supertest';
import express from 'express';
import { Pool, PoolClient } from 'pg';
import { createProvisioningRouter } from './provisioning';
import { ProvisioningOrchestrator } from '../services/provisioning-orchestrator';
import { QueueManager } from '../services/queue-manager';
import { LockTimeoutError } from '../credentials/operation-lock';

function makeApp(
  orchestrator: Partial<ProvisioningOrchestrator>,
  queueManager: Partial<QueueManager>,
  pool: Partial<Pool>
) {
  const app = express();
  app.use(express.json());
  app.use(
    '/provisioning',
    createProvisioningRouter(
      orchestrator as ProvisioningOrchestrator,
      queueManager as QueueManager,
      pool as Pool
    )
  );
  return app;
}

describe('POST /provisioning/start', () => {
  const validBody = {
    appId: 'app1',
    environment: 'dev',
    adapterSequence: [{ name: 'adapterA', providerName: 'prov', dependencies: [] }],
    timeout: 5000,
  };

  it('returns 202 with operation_id on success', async () => {
    const orchestrator = {
      executeProvisioning: jest.fn().mockResolvedValue({ operationId: 'op-1', status: 'completed' }),
    };
    const app = makeApp(orchestrator, {}, {});

    const res = await request(app).post('/provisioning/start').send(validBody);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ operation_id: 'op-1', status: 'completed' });
  });

  it('returns 400 when appId is missing', async () => {
    const app = makeApp({}, {}, {});
    const res = await request(app)
      .post('/provisioning/start')
      .send({ ...validBody, appId: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/appId/);
  });

  it('returns 400 when environment is invalid', async () => {
    const app = makeApp({}, {}, {});
    const res = await request(app)
      .post('/provisioning/start')
      .send({ ...validBody, environment: 'staging' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/environment/);
  });

  it('returns 400 when adapterSequence is empty', async () => {
    const app = makeApp({}, {}, {});
    const res = await request(app)
      .post('/provisioning/start')
      .send({ ...validBody, adapterSequence: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/adapterSequence/);
  });

  it('returns 400 when timeout is not a positive integer', async () => {
    const app = makeApp({}, {}, {});
    const res = await request(app)
      .post('/provisioning/start')
      .send({ ...validBody, timeout: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/timeout/);
  });

  it('returns 409 on LockTimeoutError', async () => {
    const orchestrator = {
      executeProvisioning: jest.fn().mockRejectedValue(new LockTimeoutError('app1')),
    };
    const app = makeApp(orchestrator, {}, {});

    const res = await request(app).post('/provisioning/start').send(validBody);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Another operation is in progress');
  });

  it('returns 500 on unexpected error', async () => {
    const orchestrator = {
      executeProvisioning: jest.fn().mockRejectedValue(new Error('unexpected')),
    };
    const app = makeApp(orchestrator, {}, {});

    const res = await request(app).post('/provisioning/start').send(validBody);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('unexpected');
  });
});

describe('GET /provisioning/:operationId', () => {
  const makePool = (rows: unknown[]) => {
    const client: Partial<PoolClient> = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows })
        .mockResolvedValueOnce({ rows: [] }),
      release: jest.fn(),
    };
    return {
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool;
  };

  it('returns 404 when operation not found', async () => {
    const pool = makePool([]);
    const app = makeApp({}, {}, pool);

    const res = await request(app).get('/provisioning/missing-id');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Operation not found');
  });

  it('returns 202 when operation is in_progress', async () => {
    const pool = makePool([
      {
        id: 'op-1',
        app_id: 'app1',
        status: 'in_progress',
        environment: 'dev',
        created_at: new Date(),
        updated_at: new Date(),
        error_message: null,
      },
    ]);
    const app = makeApp({}, {}, pool);

    const res = await request(app).get('/provisioning/op-1');
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('in_progress');
  });

  it('returns 200 when operation is completed', async () => {
    const client: Partial<PoolClient> = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'op-1',
              app_id: 'app1',
              status: 'completed',
              environment: 'dev',
              created_at: new Date(),
              updated_at: new Date(),
              error_message: null,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [{ adapter_name: 'adapterA' }, { adapter_name: 'adapterB' }],
        }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
    const app = makeApp({}, {}, pool);

    const res = await request(app).get('/provisioning/op-1');
    expect(res.status).toBe(200);
    expect(res.body.completed_adapters).toEqual(['adapterA', 'adapterB']);
  });

  it('returns 400 when operation failed', async () => {
    const pool = makePool([
      {
        id: 'op-1',
        app_id: 'app1',
        status: 'failed',
        environment: 'dev',
        created_at: new Date(),
        updated_at: new Date(),
        error_message: 'something went wrong',
      },
    ]);
    const app = makeApp({}, {}, pool);

    const res = await request(app).get('/provisioning/op-1');
    expect(res.status).toBe(400);
    expect(res.body.error_message).toBe('something went wrong');
  });
});

describe('GET /provisioning/app/:appId/queue', () => {
  it('returns 400 when environment query param is missing', async () => {
    const app = makeApp({}, {}, {});
    const res = await request(app).get('/provisioning/app/app1/queue');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/environment/);
  });

  it('returns 400 when environment is invalid', async () => {
    const app = makeApp({}, {}, {});
    const res = await request(app).get('/provisioning/app/app1/queue?environment=staging');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/environment/);
  });

  it('returns 200 with queue status', async () => {
    const queueManager = {
      getQueueStatus: jest.fn().mockResolvedValue({
        queueDepth: 1,
        currentOperation: null,
        queuedOperations: [{ operationId: 'op-2', position: 1, createdAt: new Date(), estimatedWaitMs: null }],
      }),
    };
    const app = makeApp({}, queueManager, {});

    const res = await request(app).get('/provisioning/app/app1/queue?environment=dev');
    expect(res.status).toBe(200);
    expect(res.body.queueDepth).toBe(1);
    expect(queueManager.getQueueStatus).toHaveBeenCalledWith('app1', 'dev');
  });

  it('returns 500 on unexpected error', async () => {
    const queueManager = {
      getQueueStatus: jest.fn().mockRejectedValue(new Error('db error')),
    };
    const app = makeApp({}, queueManager, {});

    const res = await request(app).get('/provisioning/app/app1/queue?environment=dev');
    expect(res.status).toBe(500);
  });
});
