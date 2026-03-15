/**
 * Studio UI REST API routes.
 *
 * Endpoints:
 *   GET  /api/health                        — liveness check
 *   GET  /api/provisioning                  — list all provisioning runs
 *   GET  /api/provisioning/:runId           — run detail with events
 *   POST /api/provisioning/:runId/resume    — resume a partial run
 *   GET  /api/secrets                       — secret schema by provider
 *   GET  /api/drift                         — drift status (placeholder)
 *   POST /api/drift/reconcile               — trigger reconciliation
 *   GET  /api/architecture                  — provider dependency graph
 */

import { Router, Request, Response } from 'express';
import { EventLog, OperationRecord, OperationEvent } from '../orchestration/event-log.js';
import { WsHandler } from './ws-handler.js';
import type { ProviderType } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Provider secret schema (mirrors secrets/store.ts PROVIDER_SECRET_SCHEMAS)
// ---------------------------------------------------------------------------

const PROVIDER_SECRET_SCHEMAS: Readonly<Record<ProviderType, string[]>> = {
  firebase: ['service_account_json', 'api_key', 'fcm_key'],
  github: ['token', 'webhook_secret'],
  eas: ['eas_token', 'expo_token'],
  apple: ['certificate_pem', 'apns_key', 'p12_password'],
  'google-play': ['service_account_json', 'keystore_password'],
  cloudflare: ['api_token', 'zone_id'],
  oauth: ['client_id', 'client_secret'],
};

// ---------------------------------------------------------------------------
// Dependency graph for architecture visualization
// ---------------------------------------------------------------------------

const PROVIDER_DEPENDENCIES: Readonly<Record<string, string[]>> = {
  firebase: [],
  github: ['firebase'],
  eas: ['github'],
  apple: ['github'],
  'google-play': ['github'],
  cloudflare: [],
  oauth: ['firebase'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRun(
  record: OperationRecord,
  events: OperationEvent[],
): object {
  return {
    id: record.id,
    app_id: record.app_id,
    status: record.status,
    created_at: new Date(record.created_at).toISOString(),
    updated_at: new Date(record.updated_at).toISOString(),
    events: events.map(e => ({
      id: e.id,
      provider: e.provider,
      step: e.step,
      status: e.status,
      error_message: e.error_message,
      timestamp: new Date(e.timestamp).toISOString(),
      result: e.result_json ? JSON.parse(e.result_json) : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createApiRouter(
  eventLog: EventLog,
  wsHandler: WsHandler,
  _storeDir: string,
): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/health
  // -------------------------------------------------------------------------
  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      websocket_connections: wsHandler.connectionCount,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/provisioning — list all runs
  // -------------------------------------------------------------------------
  router.get('/provisioning', (_req: Request, res: Response) => {
    try {
      const records = eventLog.listOperations(100);
      res.json({
        runs: records.map(r => ({
          id: r.id,
          app_id: r.app_id,
          status: r.status,
          created_at: new Date(r.created_at).toISOString(),
          updated_at: new Date(r.updated_at).toISOString(),
        })),
        total: records.length,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/provisioning/:runId — run detail with events
  // -------------------------------------------------------------------------
  router.get('/provisioning/:runId', (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      const record = eventLog.getOperation(runId);
      if (!record) {
        res.status(404).json({ error: `Run "${runId}" not found` });
        return;
      }
      const events = eventLog.getOperationHistory(runId);
      res.json(formatRun(record, events));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/provisioning/:runId/resume
  // Body: { choice: "full-revalidate" | "trust-log" }
  // -------------------------------------------------------------------------
  router.post('/provisioning/:runId/resume', (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      const choice = req.body?.choice as string | undefined;

      if (choice !== 'full-revalidate' && choice !== 'trust-log') {
        res.status(400).json({
          error: 'Invalid choice. Must be "full-revalidate" or "trust-log".',
        });
        return;
      }

      const record = eventLog.getOperation(runId);
      if (!record) {
        res.status(404).json({ error: `Run "${runId}" not found` });
        return;
      }

      if (record.status !== 'failure' && record.status !== 'partial') {
        res.status(409).json({
          error: `Run is in status "${record.status}" and cannot be resumed. Only "failure" or "partial" runs can be resumed.`,
        });
        return;
      }

      // Broadcast start of resume via WebSocket
      wsHandler.broadcastStatusUpdate(runId, 'resuming', `User chose: ${choice}`);

      // Simulate async resume (in production this would call Orchestrator.provision with resume=true)
      // We update status to 'running' to indicate resumption is in progress
      eventLog.updateOperationStatus(runId, 'running');
      wsHandler.broadcastProgress(runId, 'system', 'resume', 'running', { choice });

      res.json({
        runId,
        choice,
        status: 'resuming',
        message: `Resume initiated with strategy: ${choice}. Monitor progress via WebSocket /ws/provisioning/${runId}`,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/secrets — list secret schema by provider
  // -------------------------------------------------------------------------
  router.get('/secrets', (_req: Request, res: Response) => {
    try {
      const providers = Object.entries(PROVIDER_SECRET_SCHEMAS).map(
        ([provider, secretNames]) => ({
          provider,
          secrets: secretNames.map(name => ({
            name,
            status: 'unknown',
            last_updated: null,
          })),
        }),
      );
      res.json({ providers });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/secrets/:appId — secret status for a specific app
  // -------------------------------------------------------------------------
  router.get('/secrets/:appId', (req: Request, res: Response) => {
    try {
      const { appId } = req.params;
      // Returns the schema with unknown status — real status requires passphrase
      const providers = Object.entries(PROVIDER_SECRET_SCHEMAS).map(
        ([provider, secretNames]) => ({
          provider,
          app_id: appId,
          secrets: secretNames.map(name => ({
            name,
            status: 'unknown' as const,
            last_updated: null as string | null,
          })),
        }),
      );
      res.json({ app_id: appId, providers });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/drift — aggregate drift status across recent operations
  // -------------------------------------------------------------------------
  router.get('/drift', (_req: Request, res: Response) => {
    try {
      const recentRuns = eventLog.listOperations(20);
      const failedRuns = recentRuns.filter(r => r.status === 'failure' || r.status === 'partial');

      res.json({
        last_checked: new Date().toISOString(),
        status: failedRuns.length > 0 ? 'drift_possible' : 'unknown',
        requires_user_decision: failedRuns.length > 0,
        recent_failures: failedRuns.map(r => ({
          run_id: r.id,
          app_id: r.app_id,
          status: r.status,
          failed_at: new Date(r.updated_at).toISOString(),
        })),
        message:
          failedRuns.length > 0
            ? 'Some provisioning runs failed. Run drift detection to check provider state.'
            : 'No recent failures detected. Run drift detection to verify provider state.',
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/drift/reconcile
  // Body: { direction: "manifest-to-live" | "live-to-manifest", runId?: string }
  // -------------------------------------------------------------------------
  router.post('/drift/reconcile', (req: Request, res: Response) => {
    try {
      const direction = req.body?.direction as string | undefined;
      const runId = (req.body?.runId as string | undefined) ?? `reconcile-${Date.now()}`;

      if (direction !== 'manifest-to-live' && direction !== 'live-to-manifest') {
        res.status(400).json({
          error: 'Invalid direction. Must be "manifest-to-live" or "live-to-manifest".',
        });
        return;
      }

      // Broadcast reconciliation start
      wsHandler.broadcastStatusUpdate(runId, 'reconciling', `Direction: ${direction}`);

      // Simulate broadcasting progress for each provider in dependency order
      const providerOrder: ProviderType[] = [
        'firebase',
        'github',
        'eas',
        'apple',
        'google-play',
        'cloudflare',
        'oauth',
      ];

      let delay = 0;
      for (const provider of providerOrder) {
        const capturedProvider = provider;
        setTimeout(() => {
          wsHandler.broadcastReconcileProgress(runId, capturedProvider, true);
        }, delay);
        delay += 200;
      }

      setTimeout(() => {
        wsHandler.broadcastStatusUpdate(runId, 'complete', 'Reconciliation complete');
      }, delay + 100);

      res.json({
        runId,
        direction,
        status: 'reconciling',
        message: `Reconciliation started (${direction}). Monitor progress via WebSocket /ws/provisioning/${runId}`,
        websocket_url: `/ws/provisioning/${runId}`,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/architecture — provider dependency graph for visualization
  // -------------------------------------------------------------------------
  router.get('/architecture', (_req: Request, res: Response) => {
    try {
      const nodes = Object.keys(PROVIDER_DEPENDENCIES).map(provider => ({
        id: provider,
        label: provider.charAt(0).toUpperCase() + provider.slice(1),
        dependencies: PROVIDER_DEPENDENCIES[provider],
      }));

      const edges: Array<{ from: string; to: string }> = [];
      for (const [provider, deps] of Object.entries(PROVIDER_DEPENDENCIES)) {
        for (const dep of deps) {
          edges.push({ from: dep, to: provider });
        }
      }

      res.json({ nodes, edges });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
