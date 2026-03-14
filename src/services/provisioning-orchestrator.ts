import { Pool } from 'pg';
import { acquireLock, releaseLock, queueOperation, initPool } from '../db/provisioning';
import { LockTimeoutError } from '../credentials/operation-lock';
import { CredentialResolver } from './credential-resolver';
import { AdapterExecutor, AdapterResult } from './adapter-executor';

export interface AdapterDefinition {
  name: string;
  providerName: string;
  dependencies: string[];
}

export interface ProvisioningResult {
  operationId: string;
  status: 'completed' | 'failed' | 'queued';
  adapterResults: AdapterResult[];
  error?: string;
}

interface QueuedContext {
  appId: string;
  environment: 'dev' | 'preview' | 'production';
  adapterSequence: AdapterDefinition[];
  timeout: number;
}

function topologicalSort(adapters: AdapterDefinition[]): AdapterDefinition[] {
  const names = new Set(adapters.map((a) => a.name));

  for (const adapter of adapters) {
    for (const dep of adapter.dependencies) {
      if (!names.has(dep)) {
        throw new Error(`Unknown dependency "${dep}" for adapter "${adapter.name}"`);
      }
    }
  }

  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const adapter of adapters) {
    inDegree.set(adapter.name, 0);
    adjList.set(adapter.name, []);
  }

  for (const adapter of adapters) {
    for (const dep of adapter.dependencies) {
      adjList.get(dep)!.push(adapter.name);
      inDegree.set(adapter.name, (inDegree.get(adapter.name) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const next of adjList.get(current) ?? []) {
      const degree = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }

  if (sorted.length !== adapters.length) {
    throw new Error('Circular dependency detected in adapter sequence');
  }

  const nameToAdapter = new Map(adapters.map((a) => [a.name, a]));
  return sorted.map((name) => nameToAdapter.get(name)!);
}

export class ProvisioningOrchestrator {
  private pool: Pool;
  private credentialResolver: CredentialResolver;
  private adapterExecutor: AdapterExecutor;
  private queueRegistry: Map<string, QueuedContext> = new Map();

  constructor(
    pool: Pool,
    credentialResolver: CredentialResolver,
    adapterExecutor: AdapterExecutor
  ) {
    this.pool = pool;
    this.credentialResolver = credentialResolver;
    this.adapterExecutor = adapterExecutor;
    initPool(pool);
  }

  private validateAdapterSequence(adapters: AdapterDefinition[]): void {
    if (adapters.length === 0) {
      throw new Error('Adapter sequence must not be empty');
    }

    for (const adapter of adapters) {
      if (!this.adapterExecutor.hasAdapter(adapter.name)) {
        throw new Error(`Unknown adapter: ${adapter.name}`);
      }
    }

    // Validate DAG (no circular deps) by running topological sort
    topologicalSort(adapters);
  }

  private async createOperation(
    appId: string,
    environment: string
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO provisioning_operations (id, app_id, status, environment, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'pending', $2, NOW(), NOW())
         RETURNING id`,
        [appId, environment]
      );
      return result.rows[0].id as string;
    } finally {
      client.release();
    }
  }

  private async updateOperationStatus(
    operationId: string,
    status: 'in_progress' | 'completed' | 'failed',
    errorMessage?: string | null,
    lockAcquiredAt?: Date | null
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      if (status === 'in_progress') {
        await client.query(
          `UPDATE provisioning_operations
           SET status = $1, lock_acquired_at = $2, updated_at = NOW()
           WHERE id = $3`,
          [status, lockAcquiredAt ?? new Date(), operationId]
        );
      } else if (status === 'failed') {
        await client.query(
          `UPDATE provisioning_operations
           SET status = $1, error_message = $2, updated_at = NOW()
           WHERE id = $3`,
          [status, errorMessage ?? null, operationId]
        );
      } else {
        await client.query(
          `UPDATE provisioning_operations
           SET status = $1, updated_at = NOW()
           WHERE id = $2`,
          [status, operationId]
        );
      }
    } finally {
      client.release();
    }
  }

  private async updateQueueItemStatus(
    operationId: string,
    adapterName: string,
    status: 'processing' | 'completed' | 'failed'
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE provisioning_queue
         SET status = $1, updated_at = NOW()
         WHERE operation_id = $2 AND adapter_name = $3`,
        [status, operationId, adapterName]
      );
    } finally {
      client.release();
    }
  }

  async executeAdapterSequence(
    operationId: string,
    adapters: AdapterDefinition[]
  ): Promise<AdapterResult[]> {
    const sorted = topologicalSort(adapters);
    const results: AdapterResult[] = [];
    const outputs: Record<string, Record<string, unknown>> = {};

    for (const adapter of sorted) {
      await this.updateQueueItemStatus(operationId, adapter.name, 'processing');

      const inputs: Record<string, unknown> = {};
      for (const dep of adapter.dependencies) {
        Object.assign(inputs, outputs[dep] ?? {});
      }

      const credentials = this.credentialResolver.resolveCredentials(
        operationId,
        adapter.providerName
      );

      const result = await this.adapterExecutor.executeAdapter(
        adapter.name,
        inputs,
        credentials
      );
      results.push(result);

      if (!result.success) {
        await this.updateQueueItemStatus(operationId, adapter.name, 'failed');
        throw new Error(result.error ?? `Adapter ${adapter.name} failed`);
      }

      outputs[adapter.name] = result.output;
      await this.updateQueueItemStatus(operationId, adapter.name, 'completed');
    }

    return results;
  }

  private async processQueue(
    appId: string,
    environment: string
  ): Promise<void> {
    const client = await this.pool.connect();
    let operationId: string | null = null;
    try {
      const result = await client.query(
        `SELECT po.id AS operation_id
         FROM provisioning_queue pq
         JOIN provisioning_operations po ON pq.operation_id = po.id
         WHERE po.app_id = $1
           AND po.environment = $2
           AND pq.status = 'processing'
         ORDER BY pq.position ASC
         LIMIT 1`,
        [appId, environment]
      );
      if (result.rows.length > 0) {
        operationId = result.rows[0].operation_id as string;
      }
    } finally {
      client.release();
    }

    if (operationId) {
      const ctx = this.queueRegistry.get(operationId);
      if (ctx) {
        this.queueRegistry.delete(operationId);
        this.executeProvisioning(
          ctx.appId,
          ctx.environment,
          ctx.adapterSequence,
          ctx.timeout
        ).catch(() => {
          /* errors handled internally */
        });
      }
    }
  }

  async executeProvisioning(
    appId: string,
    environment: 'dev' | 'preview' | 'production',
    adapterSequence: AdapterDefinition[],
    timeout: number
  ): Promise<ProvisioningResult> {
    this.validateAdapterSequence(adapterSequence);

    const operationId = await this.createOperation(appId, environment);
    let lockId: string | null = null;

    try {
      lockId = await acquireLock(appId, environment, timeout);
    } catch (err) {
      if (err instanceof LockTimeoutError) {
        // Queue each adapter with its position and dependencies
        for (let i = 0; i < adapterSequence.length; i++) {
          const adapter = adapterSequence[i];
          await queueOperation(operationId, adapter.name, i, adapter.dependencies);
        }
        // Store full context for later execution
        this.queueRegistry.set(operationId, { appId, environment, adapterSequence, timeout });
        return {
          operationId,
          status: 'queued',
          adapterResults: [],
          error: 'Lock timeout - operation queued for later execution',
        };
      }
      await this.updateOperationStatus(
        operationId,
        'failed',
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }

    try {
      await this.updateOperationStatus(operationId, 'in_progress', null, new Date());
      const adapterResults = await this.executeAdapterSequence(operationId, adapterSequence);
      await this.updateOperationStatus(operationId, 'completed');
      return { operationId, status: 'completed', adapterResults };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.updateOperationStatus(operationId, 'failed', errorMessage);
      return { operationId, status: 'failed', adapterResults: [], error: errorMessage };
    } finally {
      await releaseLock(lockId);
      await this.processQueue(appId, environment);
    }
  }
}
