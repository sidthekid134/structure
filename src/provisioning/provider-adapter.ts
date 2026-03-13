import { Database, ProviderConfig, ProvisioningResult } from './types';
import { RateLimiter } from './rate-limiter';

interface OperationRow {
  id: string;
  status: 'pending' | 'in_progress' | 'success' | 'failed';
}

interface LogRow {
  result: Record<string, any>;
}

/**
 * Abstract base class for all provider-specific provisioning adapters.
 *
 * Concrete adapters must implement:
 *   authenticate  – validate and exchange credentials
 *   provision     – create the provider resource
 *   verify        – confirm the resource exists and is healthy
 *   rollback      – tear down the resource on failure
 *
 * The base class supplies:
 *   - Idempotency: `provisionIdempotent` checks the DB before calling provision
 *   - State machine: pending → in_progress → success | failed, persisted in DB
 *   - Audit logging: every state transition is written to provisioning_operation_logs
 *   - Automatic retry: provision calls are wrapped with exponential-backoff retry
 */
export abstract class ProviderAdapter {
  protected readonly db: Database;
  protected readonly rateLimiter: RateLimiter;

  constructor(db: Database, rateLimiter?: RateLimiter) {
    this.db = db;
    this.rateLimiter = rateLimiter ?? new RateLimiter();
  }

  /** Provider name used as the `provider` column in the database. */
  protected abstract get providerName(): string;

  abstract authenticate(credentials: Record<string, string>): Promise<ProvisioningResult>;
  abstract provision(config: ProviderConfig): Promise<ProvisioningResult>;
  abstract verify(resourceId: string): Promise<ProvisioningResult>;
  abstract rollback(resourceId: string): Promise<ProvisioningResult>;

  // ---------------------------------------------------------------------------
  // Idempotent provisioning with state machine
  // ---------------------------------------------------------------------------

  /**
   * Provisions a resource with idempotency and state-machine tracking.
   *
   * If a successful operation already exists for (appId, provider, idempotencyKey),
   * the cached result is returned immediately without calling provision() again.
   *
   * State transitions:  (none) → pending → in_progress → success | failed
   * Each transition is recorded in provisioning_operation_logs.
   */
  async provisionIdempotent(
    appId: string,
    idempotencyKey: string,
    config: ProviderConfig,
  ): Promise<ProvisioningResult> {
    const existing = await this.db.query<OperationRow>(
      `SELECT id, status
         FROM provisioning_operations
        WHERE app_id = $1
          AND provider = $2
          AND idempotency_key = $3
        LIMIT 1`,
      [appId, this.providerName, idempotencyKey],
    );

    if (existing.rows.length > 0) {
      const op = existing.rows[0];

      if (op.status === 'success') {
        return this.fetchCachedResult(op.id);
      }
    }

    // Create a new operation record in 'pending' state
    const insertResult = await this.db.query<{ id: string }>(
      `INSERT INTO provisioning_operations
         (app_id, provider, status, idempotency_key)
       VALUES ($1, $2, 'pending', $3)
       ON CONFLICT (idempotency_key) DO UPDATE
         SET status = provisioning_operations.status
       RETURNING id`,
      [appId, this.providerName, idempotencyKey],
    );

    const operationId = insertResult.rows[0].id;

    await this.logTransition(operationId, 'state:pending', { status: 'pending' });

    // Transition → in_progress
    await this.db.query(
      `UPDATE provisioning_operations
          SET status = 'in_progress'
        WHERE id = $1`,
      [operationId],
    );
    await this.logTransition(operationId, 'state:in_progress', { status: 'in_progress' });

    try {
      const result = await this.rateLimiter.withRetry(() => this.provision(config));

      // Transition → success
      await this.db.query(
        `UPDATE provisioning_operations
            SET status = 'success', completed_at = NOW()
          WHERE id = $1`,
        [operationId],
      );
      await this.logTransition(operationId, 'state:success', { status: 'success' });
      await this.logTransition(operationId, 'provision_result', {
        resourceId: result.resourceId,
        credentials: result.credentials,
        metadata: result.metadata,
      });

      return result;
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);

      // Transition → failed
      await this.db.query(
        `UPDATE provisioning_operations
            SET status = 'failed', completed_at = NOW(), error_message = $2
          WHERE id = $1`,
        [operationId, message],
      );
      await this.logTransition(operationId, 'state:failed', {
        status: 'failed',
        error: message,
      });

      return {
        success: false,
        resourceId: '',
        credentials: {},
        metadata: {},
        error: err instanceof Error ? err : new Error(message),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async logTransition(
    operationId: string,
    step: string,
    result: Record<string, any>,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO provisioning_operation_logs (operation_id, step, result)
       VALUES ($1, $2, $3)`,
      [operationId, step, result],
    );
  }

  private async fetchCachedResult(operationId: string): Promise<ProvisioningResult> {
    const logs = await this.db.query<LogRow>(
      `SELECT result
         FROM provisioning_operation_logs
        WHERE operation_id = $1
          AND step = 'provision_result'
        ORDER BY timestamp DESC
        LIMIT 1`,
      [operationId],
    );

    if (logs.rows.length === 0) {
      return {
        success: true,
        resourceId: '',
        credentials: {},
        metadata: { cached: true },
        error: null,
      };
    }

    const { resourceId, credentials, metadata } = logs.rows[0].result;
    return {
      success: true,
      resourceId: resourceId ?? '',
      credentials: credentials ?? {},
      metadata: { ...(metadata ?? {}), cached: true },
      error: null,
    };
  }
}
