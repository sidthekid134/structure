import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { ProvisioningOrchestrator, AdapterDefinition } from '../services/provisioning-orchestrator';
import { QueueManager } from '../services/queue-manager';
import { LockTimeoutError } from '../credentials/operation-lock';
import { ProvisioningValidator } from '../validation/provisioning-validator';

const VALID_ENVIRONMENTS = ['dev', 'preview', 'production'] as const;
type Environment = (typeof VALID_ENVIRONMENTS)[number];

interface StartRequestBody {
  appId: string;
  environment: Environment;
  adapterSequence: AdapterDefinition[];
  timeout: number;
}

function validateStartRequest(body: unknown): StartRequestBody {
  const b = body as Record<string, unknown>;

  if (!b.appId || typeof b.appId !== 'string' || b.appId.trim() === '') {
    throw new Error('appId must be a non-empty string');
  }
  if (!VALID_ENVIRONMENTS.includes(b.environment as Environment)) {
    throw new Error(`environment must be one of: ${VALID_ENVIRONMENTS.join(', ')}`);
  }
  if (!Array.isArray(b.adapterSequence) || b.adapterSequence.length === 0) {
    throw new Error('adapterSequence must be a non-empty array');
  }
  if (!Number.isInteger(b.timeout) || (b.timeout as number) <= 0) {
    throw new Error('timeout must be a positive integer');
  }

  return {
    appId: (b.appId as string).trim(),
    environment: b.environment as Environment,
    adapterSequence: b.adapterSequence as AdapterDefinition[],
    timeout: b.timeout as number,
  };
}

export function createProvisioningRouter(
  orchestrator: ProvisioningOrchestrator,
  queueManager: QueueManager,
  pool: Pool,
  validator?: ProvisioningValidator
): Router {
  const router = Router();

  router.post('/start', async (req: Request, res: Response) => {
    let params: StartRequestBody;
    try {
      params = validateStartRequest(req.body);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
        code: 'VALIDATION_ERROR',
      });
    }

    const { appId, environment, adapterSequence, timeout } = params;

    if (validator) {
      try {
        validator.validateProvisioningRequest(appId, environment, adapterSequence, timeout);
      } catch (err) {
        return res.status(400).json({
          error: err instanceof Error ? err.message : String(err),
          code: 'VALIDATION_ERROR',
          context: { appId },
        });
      }
    }

    console.log(
      `[provisioning] Starting operation: appId=${appId}, environment=${environment}, adapterCount=${adapterSequence.length}`
    );

    try {
      const result = await orchestrator.executeProvisioning(
        appId,
        environment,
        adapterSequence,
        timeout
      );
      console.log(`[provisioning] Operation created: operationId=${result.operationId}`);
      return res.status(202).json({ operation_id: result.operationId, status: result.status });
    } catch (err) {
      if (err instanceof LockTimeoutError) {
        return res.status(409).json({
          error: 'Another operation is in progress',
          code: 'LOCK_TIMEOUT',
          context: { appId },
        });
      }
      return res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        code: 'INTERNAL_ERROR',
        context: { appId },
      });
    }
  });

  // Must be declared before /:operationId to avoid route conflict
  router.get('/app/:appId/queue', async (req: Request, res: Response) => {
    const { appId } = req.params;
    const { environment } = req.query;

    if (!environment || !VALID_ENVIRONMENTS.includes(environment as Environment)) {
      return res.status(400).json({
        error: `environment query param must be one of: ${VALID_ENVIRONMENTS.join(', ')}`,
      });
    }

    try {
      const queueStatus = await queueManager.getQueueStatus(appId, environment as string);
      return res.status(200).json(queueStatus);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/:operationId', async (req: Request, res: Response) => {
    const { operationId } = req.params;
    const client = await pool.connect();
    try {
      const opResult = await client.query(
        `SELECT id, app_id, status, environment, created_at, updated_at, error_message
         FROM provisioning_operations
         WHERE id = $1`,
        [operationId]
      );

      if (opResult.rows.length === 0) {
        return res.status(404).json({ error: 'Operation not found' });
      }

      const op = opResult.rows[0];

      const completedAdaptersResult = await client.query(
        `SELECT adapter_name
         FROM provisioning_queue
         WHERE operation_id = $1 AND status = 'completed'
         ORDER BY position ASC`,
        [operationId]
      );

      const body = {
        operation_id: op.id as string,
        app_id: op.app_id as string,
        status: op.status as string,
        environment: op.environment as string,
        created_at: op.created_at as Date,
        updated_at: op.updated_at as Date,
        error_message: (op.error_message as string | null) ?? null,
        completed_adapters: completedAdaptersResult.rows.map((r) => r.adapter_name as string),
      };

      if (op.status === 'in_progress') {
        return res.status(202).json(body);
      } else if (op.status === 'failed') {
        return res.status(400).json(body);
      } else {
        return res.status(200).json(body);
      }
    } finally {
      client.release();
    }
  });

  return router;
}
