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
import * as childProcess from 'child_process';
import * as path from 'path';
import { EventLog, OperationRecord, OperationEvent } from '../orchestration/event-log.js';
import { WsHandler } from './ws-handler.js';
import type { ProviderType } from '../providers/types.js';
import { VaultManager } from '../vault.js';
import {
  ProjectManager,
  IntegrationProvider,
  ProjectInfo,
  IntegrationConfigRecord,
  MobilePlatform,
} from './project-manager.js';

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

interface ExpoConnectionDetails {
  userId: string;
  username: string;
  accountNames: string[];
}

interface EasConnectionStatus {
  available: boolean;
  connected: boolean;
  requires_token: boolean;
  details?: Omit<ExpoConnectionDetails, 'userId'>;
  integration?: IntegrationConfigRecord;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createApiRouter(
  eventLog: EventLog,
  wsHandler: WsHandler,
  storeDir: string,
  devMode = false,
): Router {
  const router = Router();
  const projectManager = new ProjectManager(storeDir);
  const vaultManager = new VaultManager(path.join(storeDir, 'credentials.enc'));
  const validProjectIntegrationProviders = new Set<IntegrationProvider>(
    Object.keys(PROVIDER_SECRET_SCHEMAS) as IntegrationProvider[],
  );
  const validOrganizationIntegrationProviders = new Set<IntegrationProvider>([
    'github',
    'eas',
    'apple',
    'google-play',
  ]);

  function getRunsForProject(projectId: string): OperationRecord[] {
    return eventLog.listOperationsByAppId(projectId, 200);
  }

  function getVaultPassphrase(): string {
    const passphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
    if (!passphrase) {
      throw new Error(
        'STUDIO_VAULT_PASSPHRASE is required to use Studio credential storage for EAS tokens.',
      );
    }
    return passphrase;
  }

  function getStoredExpoToken(): string | undefined {
    return vaultManager.getCredential(getVaultPassphrase(), 'eas', 'expo_token');
  }

  function storeExpoToken(token: string): void {
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error('Expo token is required.');
    }
    vaultManager.setCredential(getVaultPassphrase(), 'eas', 'expo_token', token.trim());
  }

  function storeExpoConnectionDetails(details: ExpoConnectionDetails): void {
    const passphrase = getVaultPassphrase();
    vaultManager.setCredential(passphrase, 'eas', 'expo_user_id', details.userId);
    vaultManager.setCredential(passphrase, 'eas', 'expo_username', details.username);
    vaultManager.setCredential(passphrase, 'eas', 'expo_accounts', JSON.stringify(details.accountNames));
    vaultManager.setCredential(
      passphrase,
      'eas',
      'expo_token_last_validated_at',
      new Date().toISOString(),
    );
  }

  function deleteStoredExpoConnectionDetails(): void {
    const passphrase = getVaultPassphrase();
    vaultManager.deleteCredential(passphrase, 'eas', 'expo_user_id');
    vaultManager.deleteCredential(passphrase, 'eas', 'expo_username');
    vaultManager.deleteCredential(passphrase, 'eas', 'expo_accounts');
    vaultManager.deleteCredential(passphrase, 'eas', 'expo_token_last_validated_at');
  }

  function deleteStoredExpoToken(): boolean {
    return vaultManager.deleteCredential(getVaultPassphrase(), 'eas', 'expo_token');
  }

  function integrationProgress(integrations: Partial<Record<IntegrationProvider, IntegrationConfigRecord>>): {
    configured: number;
    total: number;
  } {
    const list = Object.values(integrations);
    return {
      configured: list.filter((entry) => entry.status === 'configured').length,
      total: list.length,
    };
  }

  async function fetchExpoConnectionDetails(token: string): Promise<ExpoConnectionDetails> {
    const stdout = await new Promise<string>((resolve, reject) => {
      childProcess.execFile(
        'npx',
        ['eas-cli', 'whoami', '--non-interactive'],
        {
          env: {
            ...process.env,
            EXPO_TOKEN: token,
          },
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
        (error, out, stderr) => {
          if (error) {
            const details = stderr?.trim() || out?.trim() || error.message;
            reject(new Error(`eas-cli whoami failed: ${details}`));
            return;
          }
          resolve(out);
        },
      );
    });

    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const username = lines.find(
      (line) =>
        line !== 'Accounts:' &&
        !line.startsWith('★') &&
        !line.startsWith('To upgrade') &&
        !line.startsWith('Proceeding with outdated version'),
    );
    if (!username) {
      throw new Error(`Unable to parse username from eas-cli output: ${stdout}`);
    }

    const accountNames = lines
      .map((line) => {
        const match = line.match(/^[•*-]\s*(.+?)\s+\(Role:/);
        return match?.[1]?.trim() ?? null;
      })
      .filter((value): value is string => Boolean(value));

    return {
      // Use username as stable identifier in Studio since whoami output does not expose UUID.
      userId: username,
      username,
      accountNames,
    };
  }

  async function syncExpoIntegrationFromCredentialStore(
    tokenOverride?: string,
    detailsOverride?: ExpoConnectionDetails,
  ): Promise<EasConnectionStatus> {
    const token = tokenOverride ?? getStoredExpoToken();
    if (!token) {
      console.log('[studio-eas] No stored expo_token in credential vault; EAS org module is blocked.');
      return { available: false, connected: false, requires_token: true };
    }

    console.log('[studio-eas] Expo token found in credential vault; validating Expo connection.');
    const details = detailsOverride ?? await fetchExpoConnectionDetails(token);
    const organization = projectManager.getOrganization();
    if (!organization.integrations.eas) {
      projectManager.addOrganizationIntegration('eas');
    }

    const updatedOrganization = projectManager.updateOrganizationIntegration('eas', {
      status: 'configured',
      notes: `Connected via stored expo_token for ${details.username}. Expo account metadata is encrypted in credential vault.`,
      config: {
        token_source: 'credential_vault',
      },
    });

    return {
      available: true,
      connected: true,
      requires_token: false,
      details: {
        username: details.username,
        accountNames: details.accountNames,
      },
      integration: updatedOrganization.integrations.eas,
    };
  }

  // -------------------------------------------------------------------------
  // GET /api/organization — organization-level integration defaults
  // -------------------------------------------------------------------------
  router.get('/organization', (_req: Request, res: Response) => {
    try {
      res.json(projectManager.getOrganization());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/integrations/eas/connection — validate stored expo_token and sync org module
  // -------------------------------------------------------------------------
  router.get('/integrations/eas/connection', async (_req: Request, res: Response) => {
    try {
      const result = await syncExpoIntegrationFromCredentialStore();
      if (result.connected && result.details) {
        console.log(
          `[studio-eas] Expo connection validated for "${result.details.username}" (${result.details.accountNames.length} accounts).`,
        );
      }
      res.json(result);
    } catch (err) {
      console.error('[studio-eas] Stored expo_token validation failed:', (err as Error).message);
      res.status(502).json({
        error: `Failed to validate stored expo_token with Expo: ${(err as Error).message}`,
      });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/organization/integrations/eas/connect — store token + connect EAS
  // -------------------------------------------------------------------------
  router.post('/organization/integrations/eas/connect', async (req: Request, res: Response) => {
    try {
      const token = req.body?.token as string | undefined;
      if (!token || !token.trim()) {
        res.status(400).json({ error: 'Expo token is required.' });
        return;
      }
      const normalizedToken = token.trim();
      const details = await fetchExpoConnectionDetails(normalizedToken);
      storeExpoToken(normalizedToken);
      storeExpoConnectionDetails(details);
      const result = await syncExpoIntegrationFromCredentialStore(normalizedToken, details);
      if (result.connected && result.details) {
        console.log(
          `[studio-eas] Stored expo_token and connected "${result.details.username}" (${result.details.accountNames.length} accounts).`,
        );
      }
      res.json(result);
    } catch (err) {
      console.error('[studio-eas] Failed to store/connect expo_token:', (err as Error).message);
      res.status(502).json({
        error: `Failed to store/connect expo token: ${(err as Error).message}`,
      });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/organization/integrations/eas/connection — remove token + disconnect
  // -------------------------------------------------------------------------
  router.delete('/organization/integrations/eas/connection', (req: Request, res: Response) => {
    try {
      const removed = deleteStoredExpoToken();
      deleteStoredExpoConnectionDetails();
      const organization = projectManager.getOrganization();
      let integration: IntegrationConfigRecord | undefined;

      if (organization.integrations.eas) {
        const updated = projectManager.updateOrganizationIntegration('eas', {
          status: 'pending',
          notes: 'EAS connection disabled. Reconnect with a token to configure this module.',
          config: {},
          replaceConfig: true,
        });
        integration = updated.integrations.eas;
      }

      console.log('[studio-eas] EAS connection disabled and stored expo_token removed.');
      res.json({
        removed,
        available: false,
        connected: false,
        requires_token: true,
        integration,
      });
    } catch (err) {
      console.error('[studio-eas] Failed to disable EAS connection:', (err as Error).message);
      res.status(502).json({
        error: `Failed to disable EAS connection: ${(err as Error).message}`,
      });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/organization/integrations — add org integration default
  // -------------------------------------------------------------------------
  router.post('/organization/integrations', (req: Request, res: Response) => {
    try {
      const provider = req.body?.provider as IntegrationProvider;
      if (!validOrganizationIntegrationProviders.has(provider)) {
        res.status(400).json({
          error: `Unsupported organization module "${provider}". Allowed: github, eas, apple, google-play.`,
        });
        return;
      }
      const organization = projectManager.addOrganizationIntegration(provider);
      res.status(201).json(organization.integrations[provider]);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // PUT /api/organization/integrations/:provider — update org defaults
  // -------------------------------------------------------------------------
  router.put('/organization/integrations/:provider', (req: Request, res: Response) => {
    try {
      const { provider } = req.params;
      if (!validOrganizationIntegrationProviders.has(provider as IntegrationProvider)) {
        res.status(400).json({
          error: `Unsupported organization module "${provider}". Allowed: github, eas, apple, google-play.`,
        });
        return;
      }
      const configPatch = req.body?.config as Record<string, string> | undefined;
      if (provider === 'eas' && configPatch && (configPatch['expo_token'] || configPatch['eas_token'])) {
        res.status(400).json({
          error: 'EAS tokens cannot be stored in module config. Use /api/organization/integrations/eas/connect.',
        });
        return;
      }
      const organization = projectManager.updateOrganizationIntegration(
        provider as IntegrationProvider,
        {
          status: req.body?.status as IntegrationConfigRecord['status'] | undefined,
          notes: req.body?.notes as string | undefined,
          config: configPatch,
        },
      );
      res.json(organization.integrations[provider as IntegrationProvider]);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/projects — list all project modules
  // -------------------------------------------------------------------------
  router.get('/projects', (_req: Request, res: Response) => {
    try {
      const projects = projectManager.listProjects();
      res.json({
        projects: projects.map((project) => {
          const runs = getRunsForProject(project.id);
          const progress = integrationProgress(projectManager.getProject(project.id).integrations);
          return {
            ...project,
            integration_progress: progress,
            runs: {
              total: runs.length,
              success: runs.filter((run) => run.status === 'success').length,
              failed: runs.filter((run) => run.status === 'failure' || run.status === 'partial').length,
              running: runs.filter((run) => run.status === 'running').length,
            },
          };
        }),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/projects — create a project module
  // -------------------------------------------------------------------------
  router.post('/projects', (req: Request, res: Response) => {
    try {
      const module = projectManager.createProject({
        name: req.body?.name as string,
        slug: req.body?.slug as string,
        bundleId: req.body?.bundleId as string,
        description: req.body?.description as string | undefined,
        repository: req.body?.repository as string | undefined,
        githubOrg: req.body?.githubOrg as string | undefined,
        easAccount: req.body?.easAccount as string | undefined,
        environments: req.body?.environments as string[] | undefined,
        platforms: req.body?.platforms as MobilePlatform[],
        domain: req.body?.domain as string | undefined,
        plugins: req.body?.plugins as IntegrationProvider[],
      });
      res.status(201).json(module);
    } catch (err) {
      if ((err as Error).message.includes('already exists')) {
        res.status(409).json({ error: (err as Error).message });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId — retrieve project module detail
  // -------------------------------------------------------------------------
  router.get('/projects/:projectId', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const module = projectManager.getProject(projectId);
      const runs = getRunsForProject(projectId).map((record) => ({
        id: record.id,
        app_id: record.app_id,
        status: record.status,
        created_at: new Date(record.created_at).toISOString(),
        updated_at: new Date(record.updated_at).toISOString(),
      }));

      res.json({
        ...module,
        provisioning: {
          total: runs.length,
          runs,
        },
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // PATCH /api/projects/:projectId — update project info
  // -------------------------------------------------------------------------
  router.patch('/projects/:projectId', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const module = projectManager.updateProjectInfo(projectId, {
        name: req.body?.name as string | undefined,
        description: req.body?.description as string | undefined,
        repository: req.body?.repository as string | undefined,
        platform: req.body?.platform as ProjectInfo['platform'] | undefined,
      });
      res.json(module);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/projects/:projectId — delete project module
  // -------------------------------------------------------------------------
  router.delete('/projects/:projectId', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      projectManager.deleteProject(projectId);
      res.status(204).send();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/integrations — add integration module
  // -------------------------------------------------------------------------
  router.post('/projects/:projectId/integrations', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const provider = req.body?.provider as IntegrationProvider;
      if (!validProjectIntegrationProviders.has(provider)) {
        res.status(400).json({ error: `Unknown provider "${provider}".` });
        return;
      }

      const module = projectManager.addIntegration(projectId, provider);
      res.status(201).json(module.integrations[provider]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // PUT /api/projects/:projectId/integrations/:provider — update integration
  // -------------------------------------------------------------------------
  router.put('/projects/:projectId/integrations/:provider', (req: Request, res: Response) => {
    try {
      const { projectId, provider } = req.params;
      if (!validProjectIntegrationProviders.has(provider as IntegrationProvider)) {
        res.status(400).json({ error: `Unknown provider "${provider}".` });
        return;
      }

      const module = projectManager.updateIntegration(projectId, provider as IntegrationProvider, {
        status: req.body?.status as IntegrationConfigRecord['status'] | undefined,
        notes: req.body?.notes as string | undefined,
        config: req.body?.config as Record<string, string> | undefined,
      });
      res.json(module.integrations[provider as IntegrationProvider]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/health
  // -------------------------------------------------------------------------
  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      websocket_connections: wsHandler.connectionCount,
      dev_mode: devMode,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/provisioning — list all runs
  // -------------------------------------------------------------------------
  router.get('/provisioning', (req: Request, res: Response) => {
    try {
      const projectId = req.query['projectId'] as string | undefined;
      const records = projectId
        ? eventLog.listOperationsByAppId(projectId, 100)
        : eventLog.listOperations(100);
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
