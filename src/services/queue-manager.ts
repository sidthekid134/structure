import { Pool } from 'pg';

export interface QueuedOperationInfo {
  operationId: string;
  position: number;
  createdAt: Date;
  estimatedWaitMs: number | null;
}

export interface QueueStatus {
  queueDepth: number;
  currentOperation: {
    operationId: string;
    status: string;
    lockAcquiredAt: Date | null;
  } | null;
  queuedOperations: QueuedOperationInfo[];
}

export class QueueManager {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async getQueueStatus(appId: string, environment: string): Promise<QueueStatus> {
    const client = await this.pool.connect();
    try {
      const currentResult = await client.query(
        `SELECT id, status, lock_acquired_at
         FROM provisioning_operations
         WHERE app_id = $1 AND environment = $2 AND status = 'in_progress'
         ORDER BY created_at DESC
         LIMIT 1`,
        [appId, environment]
      );

      const queuedResult = await client.query(
        `SELECT po.id AS operation_id, MIN(pq.position) AS position, po.created_at
         FROM provisioning_operations po
         JOIN provisioning_queue pq ON pq.operation_id = po.id
         WHERE po.app_id = $1 AND po.environment = $2 AND pq.status = 'queued'
         GROUP BY po.id, po.created_at
         ORDER BY po.created_at ASC`,
        [appId, environment]
      );

      const currentRow = currentResult.rows[0] ?? null;
      const queuedRows = queuedResult.rows;

      const currentOperation = currentRow
        ? {
            operationId: currentRow.id as string,
            status: currentRow.status as string,
            lockAcquiredAt: currentRow.lock_acquired_at as Date | null,
          }
        : null;

      const queuedOperations: QueuedOperationInfo[] = queuedRows.map((row, idx) => ({
        operationId: row.operation_id as string,
        position: idx + 1,
        createdAt: row.created_at as Date,
        estimatedWaitMs: null,
      }));

      return {
        queueDepth: queuedOperations.length,
        currentOperation,
        queuedOperations,
      };
    } finally {
      client.release();
    }
  }
}
