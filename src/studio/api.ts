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
import * as path from 'path';
import { EventLog, OperationRecord } from '../orchestration/event-log.js';
import { WsHandler } from './ws-handler.js';
import { VaultManager } from '../vault.js';
import {
  ProjectManager,
  IntegrationProvider,
  ProjectInfo,
  IntegrationConfigRecord,
  MobilePlatform,
} from './project-manager.js';
import {
  PROVIDER_SECRET_SCHEMAS,
  PROVIDER_DEPENDENCIES,
  PROVIDER_INTEGRATION_BLUEPRINTS,
} from '../core/provider-schemas.js';
import { formatRun, integrationProgress } from '../core/formatting.js';
import { EasConnectionService } from '../core/eas-connection.js';
import { GitHubConnectionService } from '../core/github-connection.js';
import {
  GcpConnectionService,
  buildStudioGcpProjectId,
  GCP_PROVISIONER_SERVICE_ACCOUNT_ID,
} from '../core/gcp-connection.js';
import { resumeProvisioningRun } from '../core/provisioning.js';
import { getDriftStatus, startDriftReconcile } from '../core/drift.js';

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
  const easConnectionService = new EasConnectionService(vaultManager, projectManager);
  const gitHubConnectionService = new GitHubConnectionService(vaultManager, projectManager);
  const gcpConnectionService = new GcpConnectionService(
    vaultManager,
    projectManager,
    process.env['PLATFORM_GCP_OAUTH_CLIENT_ID'] ?? '',
    process.env['PLATFORM_GCP_OAUTH_CLIENT_SECRET'] ?? '',
  );
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
      const result = await easConnectionService.syncExpoIntegrationFromCredentialStore();
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
      const result = await easConnectionService.connect(token ?? '');
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
  // GET /api/integrations/github/connection — validate stored github token and sync org module
  // -------------------------------------------------------------------------
  router.get('/integrations/github/connection', async (_req: Request, res: Response) => {
    try {
      const result = await gitHubConnectionService.syncGitHubIntegrationFromCredentialStore();
      if (result.connected && result.details) {
        console.log(
          `[studio-github] GitHub connection validated for "${result.details.username}" (${result.details.orgNames.length} org memberships).`,
        );
      }
      res.json(result);
    } catch (err) {
      console.error('[studio-github] Stored GitHub token validation failed:', (err as Error).message);
      res.status(502).json({
        error: `Failed to validate stored GitHub token: ${(err as Error).message}`,
      });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/organization/integrations/github/connect — store token + connect GitHub
  // -------------------------------------------------------------------------
  router.post(
    '/organization/integrations/github/connect',
    async (req: Request, res: Response) => {
      try {
        const token = req.body?.token as string | undefined;
        const result = await gitHubConnectionService.connect(token ?? '');
        if (result.connected && result.details) {
          console.log(
            `[studio-github] Stored token and connected "${result.details.username}" (${result.details.orgNames.length} org memberships).`,
          );
        }
        res.json(result);
      } catch (err) {
        console.error('[studio-github] Failed to store/connect GitHub token:', (err as Error).message);
        res.status(502).json({
          error: `Failed to store/connect GitHub token: ${(err as Error).message}`,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/organization/integrations/github/connection — remove token + disconnect
  // -------------------------------------------------------------------------
  router.delete('/organization/integrations/github/connection', (req: Request, res: Response) => {
    try {
      const result = gitHubConnectionService.disconnect();
      console.log('[studio-github] GitHub connection disabled and stored token removed.');
      res.json(result);
    } catch (err) {
      console.error('[studio-github] Failed to disable GitHub connection:', (err as Error).message);
      res.status(502).json({
        error: `Failed to disable GitHub connection: ${(err as Error).message}`,
      });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/organization/integrations/eas/connection — remove token + disconnect
  // -------------------------------------------------------------------------
  router.delete('/organization/integrations/eas/connection', (req: Request, res: Response) => {
    try {
      const result = easConnectionService.disconnect();
      console.log('[studio-eas] EAS connection disabled and stored expo_token removed.');
      res.json(result);
    } catch (err) {
      console.error('[studio-eas] Failed to disable EAS connection:', (err as Error).message);
      res.status(502).json({
        error: `Failed to disable EAS connection: ${(err as Error).message}`,
      });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/integrations/gcp/capability — org-level GCP capability metadata
  // -------------------------------------------------------------------------
  router.get('/integrations/gcp/capability', (_req: Request, res: Response) => {
    try {
      res.json(gcpConnectionService.getCapability());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId/integrations/firebase/connection — project GCP status
  // -------------------------------------------------------------------------
  router.get('/projects/:projectId/integrations/firebase/connection', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const result = gcpConnectionService.getProjectConnectionStatus(projectId);
      if (result.connected && result.details) {
        console.log(
          `[studio-gcp] Firebase connection active for Studio project "${projectId}" -> GCP "${result.details.projectId}" (SA: ${result.details.serviceAccountEmail}).`,
        );
      }
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(502).json({ error: `Failed to check Firebase/GCP connection: ${message}` });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/integrations/firebase/connect/oauth/start
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/integrations/firebase/connect/oauth/start',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const session = await gcpConnectionService.startProjectOAuthFlow(projectId);
        console.log(
          `[studio-gcp] OAuth flow started for Studio project "${projectId}" (session ${session.sessionId}).`,
        );
        res.json(session);
      } catch (err) {
        const message = (err as Error).message;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
          return;
        }
        res.status(502).json({ error: `Failed to start GCP OAuth flow: ${message}` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId/integrations/firebase/connect/oauth/:sessionId
  // -------------------------------------------------------------------------
  router.get(
    '/projects/:projectId/integrations/firebase/connect/oauth/:sessionId',
    (req: Request, res: Response) => {
      try {
        const { projectId, sessionId } = req.params;
        const status = gcpConnectionService.getProjectOAuthStatus(projectId, sessionId);
        res.json(status);
      } catch (err) {
        const message = (err as Error).message;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
          return;
        }
        if (message.includes('not found')) {
          res.status(404).json({ error: message });
          return;
        }
        res.status(400).json({ error: message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/integrations/firebase/connect — manual SA key connect
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/integrations/firebase/connect',
    (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const saKeyJson = req.body?.serviceAccountJson as string | undefined;
        if (!saKeyJson || !saKeyJson.trim()) {
          res.status(400).json({ error: 'Service account JSON is required.' });
          return;
        }
        const result = gcpConnectionService.connectProjectWithServiceAccountKey(
          projectId,
          saKeyJson.trim(),
        );
        if (result.connected && result.details) {
          console.log(
            `[studio-gcp] Manual SA key connected for Studio project "${projectId}" -> GCP "${result.details.projectId}".`,
          );
        }
        res.json(result);
      } catch (err) {
        const message = (err as Error).message;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
          return;
        }
        res.status(400).json({ error: `Failed to connect with SA key: ${message}` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/projects/:projectId/integrations/firebase/connection
  // -------------------------------------------------------------------------
  router.delete('/projects/:projectId/integrations/firebase/connection', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const result = gcpConnectionService.disconnectProject(projectId);
      console.log(`[studio-gcp] Firebase/GCP disconnected for Studio project "${projectId}".`);
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(502).json({ error: `Failed to disconnect Firebase/GCP: ${message}` });
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
          error: `Unsupported organization module "${provider}". Allowed: github, eas, apple, google-play. Firebase/GCP is project-scoped and must be configured per project.`,
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
          error: `Unsupported organization module "${provider}". Allowed: github, eas, apple, google-play. Firebase/GCP is project-scoped and must be configured per project.`,
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
  // GET /api/projects/:projectId/integrations/dependencies
  // Returns dependency + standardized provisioning plan per integration
  // -------------------------------------------------------------------------
  router.get('/projects/:projectId/integrations/dependencies', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const module = projectManager.getProject(projectId);
      const organization = projectManager.getOrganization();
      const defaultGcpProjectId = buildStudioGcpProjectId(projectId);
      const firebaseConfig = (module.integrations.firebase?.config ?? {}) as Record<string, string>;
      const gcpProjectId = firebaseConfig['gcp_project_id']?.trim() || defaultGcpProjectId;
      const gcpProvisionerEmail =
        firebaseConfig['service_account_email']?.trim() ||
        `${GCP_PROVISIONER_SERVICE_ACCOUNT_ID}@${gcpProjectId}.iam.gserviceaccount.com`;

      const providers = Object.entries(PROVIDER_INTEGRATION_BLUEPRINTS).map(
        ([provider, blueprint]) => ({
          provider,
          scope: blueprint.scope,
          dependencies: blueprint.dependencies.map((dependency) => {
            let value: string | null = null;
            if (dependency.key === 'bundle_id') {
              value = module.project.bundleId || null;
            } else if (dependency.key === 'project_slug') {
              value = module.project.slug || null;
            } else if (dependency.key === 'github_pat') {
              const github = organization.integrations.github;
              value =
                github?.status === 'configured'
                  ? 'Configured in organization credential vault'
                  : null;
            } else if (dependency.key === 'expo_token') {
              const eas = organization.integrations.eas;
              value =
                eas?.status === 'configured'
                  ? 'Configured in organization credential vault'
                  : null;
            } else if (dependency.key === 'gcp_auth_method') {
              const firebase = module.integrations.firebase;
              value =
                firebase?.status === 'configured'
                  ? 'Existing Firebase/GCP project connection'
                  : 'OAuth bootstrap or manual service-account JSON';
            }
            return {
              ...dependency,
              value,
              status: dependency.required && !value ? 'missing' : 'ready',
            };
          }),
          plannedResources: blueprint.plannedResources.map((resource) => {
            if (provider !== 'firebase') {
              return {
                ...resource,
                standardized_name: resource.naming,
              };
            }

            if (resource.key === 'gcp_project') {
              return {
                ...resource,
                standardized_name: gcpProjectId,
              };
            }
            if (resource.key === 'provisioner_service_account') {
              return {
                ...resource,
                standardized_name: gcpProvisionerEmail,
              };
            }
            if (resource.key === 'provisioner_service_account_key') {
              return {
                ...resource,
                standardized_name: `${projectId}/service_account_json`,
              };
            }
            return {
              ...resource,
              standardized_name: resource.naming,
            };
          }),
        }),
      );

      res.json({
        project: {
          id: module.project.id,
          slug: module.project.slug,
          bundleId: module.project.bundleId,
        },
        providers,
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
      const result = resumeProvisioningRun(runId, choice, eventLog, wsHandler);
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'Invalid choice. Must be "full-revalidate" or "trust-log".') {
        res.status(400).json({ error: message });
        return;
      }
      if (message.endsWith('not found')) {
        res.status(404).json({ error: message });
        return;
      }
      if (message.includes('cannot be resumed')) {
        res.status(409).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
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
      res.json(getDriftStatus(eventLog));
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
      const runId = req.body?.runId as string | undefined;
      const result = startDriftReconcile(direction, runId, wsHandler);
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'Invalid direction. Must be "manifest-to-live" or "live-to-manifest".') {
        res.status(400).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/architecture — provider dependency graph for visualization
  // -------------------------------------------------------------------------
  router.get('/architecture', (_req: Request, res: Response) => {
    try {
      const providers = Object.keys(PROVIDER_DEPENDENCIES) as Array<keyof typeof PROVIDER_DEPENDENCIES>;
      const nodes = providers.map((provider) => ({
        id: provider,
        label: provider.charAt(0).toUpperCase() + provider.slice(1),
        dependencies: PROVIDER_DEPENDENCIES[provider] as string[],
      }));

      const edges: Array<{ from: string; to: string }> = [];
      for (const [provider, deps] of Object.entries(PROVIDER_DEPENDENCIES) as Array<[string, string[]]>) {
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
