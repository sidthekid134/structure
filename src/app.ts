import express from 'express';
import { Pool } from 'pg';
import { ProvisioningOrchestrator } from './services/provisioning-orchestrator';
import { QueueManager } from './services/queue-manager';
import { createProvisioningRouter } from './routes/provisioning';

export function createApp(
  pool: Pool,
  orchestrator: ProvisioningOrchestrator,
  queueManager: QueueManager
): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/provisioning', createProvisioningRouter(orchestrator, queueManager, pool));
  return app;
}
