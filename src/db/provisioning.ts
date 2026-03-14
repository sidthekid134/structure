import { Pool, PoolClient } from 'pg';
import { LockTimeoutError } from '../credentials/operation-lock';

let _pool: Pool | null = null;

export function initPool(pool: Pool): void {
  _pool = pool;
}

function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

interface LockEntry {
  client: PoolClient;
  appId: string;
  environment: string;
}

const activeLocks = new Map<string, LockEntry>();

function generateLockKey(appId: string, environment: string): number {
  let hash = 5381;
  const str = `${appId}:${environment}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export async function acquireLock(
  appId: string,
  environment: string,
  timeoutMs: number
): Promise<string> {
  const lockKey = generateLockKey(appId, environment);
  const lockId = lockKey.toString();
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${timeoutMs}ms'`);
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey]);
    activeLocks.set(lockId, { client, appId, environment });
    return lockId;
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    client.release();
    if (error.code === '55P03') {
      throw new LockTimeoutError(appId);
    }
    throw error;
  }
}

export async function releaseLock(lockId: string): Promise<void> {
  const entry = activeLocks.get(lockId);
  if (!entry) return;

  activeLocks.delete(lockId);
  const { client, appId, environment } = entry;

  try {
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  // Trigger queue processing: advance next queued item for this app+environment
  const pool = getPool();
  const queueClient = await pool.connect();
  try {
    await queueClient.query(
      `UPDATE provisioning_queue
       SET status = 'processing', updated_at = NOW()
       WHERE id = (
         SELECT pq.id
         FROM provisioning_queue pq
         JOIN provisioning_operations po ON pq.operation_id = po.id
         WHERE po.app_id = $1
           AND po.environment = $2
           AND pq.status = 'queued'
         ORDER BY pq.position ASC
         LIMIT 1
       )`,
      [appId, environment]
    );
  } finally {
    queueClient.release();
  }
}

export async function queueOperation(
  operationId: string,
  adapterName: string,
  position: number,
  dependencies: string[]
): Promise<void> {
  const client = await getPool().connect();
  try {
    const now = new Date();

    await client.query(
      `INSERT INTO provisioning_queue (id, operation_id, adapter_name, position, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'queued', $4, $4)`,
      [operationId, adapterName, position, now]
    );

    for (const dep of dependencies) {
      await client.query(
        `INSERT INTO provisioning_dependencies (id, operation_id, adapter_name, depends_on_adapter, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [operationId, adapterName, dep, now]
      );
    }
  } finally {
    client.release();
  }
}
