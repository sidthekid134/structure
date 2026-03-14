import { Pool } from 'pg';
import { NotFoundError } from '../credentials/vault';
import { AdapterExecutor } from '../services/adapter-executor';
import { AdapterDefinition } from '../services/provisioning-orchestrator';

const VALID_ENVIRONMENTS = ['dev', 'preview', 'production'] as const;
type Environment = (typeof VALID_ENVIRONMENTS)[number];

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ProvisioningValidator {
  private pool: Pool;
  private adapterExecutor: AdapterExecutor;

  constructor(pool: Pool, adapterExecutor: AdapterExecutor) {
    this.pool = pool;
    this.adapterExecutor = adapterExecutor;
  }

  validateProvisioningRequest(
    appId: unknown,
    environment: unknown,
    adapterSequence: unknown,
    timeout: unknown
  ): void {
    if (!appId || typeof appId !== 'string' || (appId as string).trim() === '') {
      throw new ValidationError('appId must be a non-empty string');
    }
    if (!VALID_ENVIRONMENTS.includes(environment as Environment)) {
      throw new ValidationError(`environment must be one of: ${VALID_ENVIRONMENTS.join(', ')}`);
    }
    if (!Array.isArray(adapterSequence) || adapterSequence.length === 0) {
      throw new ValidationError('adapterSequence must be a non-empty array');
    }
    if (!Number.isInteger(timeout) || (timeout as number) <= 0) {
      throw new ValidationError('timeout must be a positive integer');
    }
    for (const adapter of adapterSequence as AdapterDefinition[]) {
      if (!this.adapterExecutor.hasAdapter(adapter.name)) {
        throw new ValidationError(`Unknown adapter: ${adapter.name}`);
      }
    }
    this.validateDependencyDAG(adapterSequence as AdapterDefinition[]);
  }

  async validateCredentialsExist(operationId: string, providerName: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT id FROM provisioning_operations WHERE id = $1',
        [operationId]
      );
      if (result.rows.length === 0) {
        throw new NotFoundError(providerName, operationId);
      }
    } finally {
      client.release();
    }
  }

  validateDependencyDAG(adapterSequence: AdapterDefinition[]): void {
    const names = new Set(adapterSequence.map((a) => a.name));

    for (const adapter of adapterSequence) {
      for (const dep of adapter.dependencies) {
        if (!names.has(dep)) {
          throw new ValidationError(`Unknown dependency "${dep}" for adapter "${adapter.name}"`);
        }
      }
    }

    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    for (const adapter of adapterSequence) {
      inDegree.set(adapter.name, 0);
      adjList.set(adapter.name, []);
    }

    for (const adapter of adapterSequence) {
      for (const dep of adapter.dependencies) {
        adjList.get(dep)!.push(adapter.name);
        inDegree.set(adapter.name, (inDegree.get(adapter.name) ?? 0) + 1);
      }
    }

    const queue: string[] = [];
    for (const [name, degree] of inDegree) {
      if (degree === 0) queue.push(name);
    }

    let count = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      count++;
      for (const next of adjList.get(current) ?? []) {
        const degree = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, degree);
        if (degree === 0) queue.push(next);
      }
    }

    if (count !== adapterSequence.length) {
      throw new ValidationError('Circular dependency detected in adapter sequence');
    }
  }
}
