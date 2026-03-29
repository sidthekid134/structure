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
import {
  buildProvisioningPlan,
  buildProvisioningPlanForModules,
  buildTeardownPlan,
  recomputePlanForModules,
} from '../provisioning/step-registry.js';
import { StepResolver } from '../provisioning/step-resolver.js';
import { buildPlanViewModel } from '../provisioning/journey-phases.js';
import type { ProvisioningPlan, ProvisioningNode, NodeState } from '../provisioning/graph.types.js';
import type {
  ProviderType,
  GitHubManifestConfig,
  FirebaseManifestConfig,
  BranchProtectionRule,
  ProviderManifest,
  ProviderConfig,
  StepContext,
} from '../providers/types.js';
import { PLATFORM_CORE_VERSION } from '../providers/types.js';
import { formatRun, integrationProgress } from '../core/formatting.js';
import { EasConnectionService } from '../core/eas-connection.js';
import { GitHubConnectionService } from '../core/github-connection.js';
import {
  GcpConnectionService,
  buildStudioGcpProjectId,
  GCP_PROVISIONER_SERVICE_ACCOUNT_ID,
  type GcpBootstrapPhaseId,
} from '../core/gcp-connection.js';
import { resumeProvisioningRun } from '../core/provisioning.js';
import { getDriftStatus, startDriftReconcile } from '../core/drift.js';
import { GitHubAdapter, HttpGitHubApiClient } from '../providers/github.js';
import { FirebaseAdapter, StubFirebaseApiClient } from '../providers/firebase.js';
import { ProviderRegistry } from '../providers/registry.js';
import { Orchestrator } from '../orchestration/orchestrator.js';
import type { ModuleId } from '../provisioning/module-catalog.js';
import { getProvidersForModules, resolveModuleDependencies } from '../provisioning/module-catalog.js';
import { buildProvisioningGateResolver } from '../provisioning/gate-resolvers.js';

const GCP_BOOTSTRAP_PHASE_IDS: readonly GcpBootstrapPhaseId[] = [
  'oauth_consent',
  'gcp_project',
  'service_account',
  'iam_binding',
  'vault',
];

function isGcpBootstrapPhaseId(value: string): value is GcpBootstrapPhaseId {
  return (GCP_BOOTSTRAP_PHASE_IDS as readonly string[]).includes(value);
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

  function collectDependentNodeKeys(rootKey: string, nodes: ProvisioningNode[]): Set<string> {
    const dependents = new Set<string>();
    let frontier = new Set<string>([rootKey]);
    while (frontier.size > 0) {
      const nextFrontier = new Set<string>();
      for (const n of nodes) {
        if (dependents.has(n.key)) continue;
        if (n.dependencies.some((d) => d.required && frontier.has(d.nodeKey))) {
          dependents.add(n.key);
          nextFrontier.add(n.key);
        }
      }
      frontier = nextFrontier;
    }
    return dependents;
  }

  function clearLogicalNodeState(plan: ProvisioningPlan, node: ProvisioningNode): void {
    if (node.type === 'step' && node.environmentScope === 'per-environment') {
      for (const env of plan.environments) {
        plan.nodeStates.set(`${node.key}@${env}`, {
          nodeKey: node.key,
          status: 'not-started',
          environment: env,
        });
      }
    } else {
      plan.nodeStates.set(node.key, {
        nodeKey: node.key,
        status: 'not-started',
      });
    }
  }

  function logicalNodeInProgress(node: ProvisioningNode, plan: ProvisioningPlan): boolean {
    if (node.type === 'step' && node.environmentScope === 'per-environment') {
      return plan.environments.some(
        (env) => plan.nodeStates.get(`${node.key}@${env}`)?.status === 'in-progress',
      );
    }
    return plan.nodeStates.get(node.key)?.status === 'in-progress';
  }

  /** Mark non-terminal instances of a logical node as skipped; returns touched keys for WS. */
  function applySkipToNode(plan: ProvisioningPlan, node: ProvisioningNode): Array<{ environment?: string }> {
    const now = Date.now();
    const touched: Array<{ environment?: string }> = [];

    if (node.type === 'step' && node.environmentScope === 'per-environment') {
      for (const env of plan.environments) {
        const key = `${node.key}@${env}`;
        const prev = plan.nodeStates.get(key);
        const st = prev?.status ?? 'not-started';
        if (st === 'completed' || st === 'skipped') continue;
        plan.nodeStates.set(key, {
          nodeKey: node.key,
          environment: env,
          status: 'skipped',
          completedAt: now,
          resourcesProduced: prev?.resourcesProduced ?? {},
        });
        touched.push({ environment: env });
      }
    } else {
      const prev = plan.nodeStates.get(node.key);
      const st = prev?.status ?? 'not-started';
      if (st === 'completed' || st === 'skipped') {
        return touched;
      }
      plan.nodeStates.set(node.key, {
        nodeKey: node.key,
        status: 'skipped',
        completedAt: now,
        resourcesProduced: prev?.resourcesProduced ?? {},
      });
      touched.push({});
    }
    return touched;
  }

  const loadPersistedPlan = (projectId: string): ProvisioningPlan | null => {
    const snapshot = projectManager.loadPlan(projectId);
    if (!snapshot) return null;
    return StepResolver.restorePlan(snapshot as {
      projectId: string;
      environments: string[];
      selectedModules?: string[];
      nodes: ProvisioningPlan['nodes'];
      nodeStates: Record<string, NodeState>;
    });
  };

  const savePersistedPlan = (projectId: string, plan: ProvisioningPlan): void => {
    projectManager.savePlan(projectId, StepResolver.snapshotPlan(plan));
  };

  function buildFirebaseManifestConfig(projectId: string): FirebaseManifestConfig {
    const module = projectManager.getProject(projectId);
    return {
      provider: 'firebase',
      project_name: module.project.slug || projectId,
      billing_account_id: '[connected via OAuth]',
      services: ['auth', 'firestore', 'storage', 'fcm'],
      environment: 'prod',
    };
  }

  function planUsesFirebaseProvider(plan: ProvisioningPlan): boolean {
    return plan.nodes.some((n) => n.provider === 'firebase');
  }

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
  // POST /api/projects/:projectId/integrations/firebase/connect/discover-gcp-project
  // Uses stored Google OAuth token to find the Studio GCP project (expected id or display name
  // "Studio <projectId>"), persist gcp_project_id when missing, refresh Firebase integration.
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/integrations/firebase/connect/discover-gcp-project',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const result = await gcpConnectionService.discoverStudioGcpProjectWithStoredOAuth(projectId);
        res.json(result);
      } catch (err) {
        const message = (err as Error).message;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
          return;
        }
        res.status(502).json({ error: `GCP project discover failed: ${message}` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/integrations/firebase/steps/sync
  // OAuth session UI: refresh `oauth_consent` from vault (use plan/sync for infra graph).
  // Must be registered before /steps/:stepId/* so "sync" is not captured as stepId.
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/integrations/firebase/steps/sync',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const steps = await gcpConnectionService.syncOAuthPipelineFromLiveState(projectId);
        const connected = steps.length > 0 && steps.every((s) => s.status === 'completed');
        res.json({ steps, connected });
      } catch (err) {
        const message = (err as Error).message;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
          return;
        }
        res.status(502).json({ error: `Pipeline sync failed: ${message}` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/integrations/firebase/steps/:stepId/validate
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/integrations/firebase/steps/:stepId/validate',
    async (req: Request, res: Response) => {
      try {
        const { projectId, stepId } = req.params;
        if (!isGcpBootstrapPhaseId(stepId)) {
          res.status(400).json({ error: `Unknown OAuth step: ${stepId}` });
          return;
        }
        const result = await gcpConnectionService.validateStep(projectId, stepId);
        res.json(result);
      } catch (err) {
        const message = (err as Error).message;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
          return;
        }
        res.status(502).json({ error: `Validation failed: ${message}` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/integrations/firebase/steps/:stepId/revert
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/integrations/firebase/steps/:stepId/revert',
    async (req: Request, res: Response) => {
      try {
        const { projectId, stepId } = req.params;
        if (!isGcpBootstrapPhaseId(stepId)) {
          res.status(400).json({ error: `Unknown OAuth step: ${stepId}` });
          return;
        }
        const cascadedSteps = GcpConnectionService.getCascadeSteps(stepId);
        const results = await gcpConnectionService.revertSteps(projectId, cascadedSteps);
        res.json({ results, cascadedSteps });
      } catch (err) {
        const message = (err as Error).message;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
          return;
        }
        if (message.includes('Unknown OAuth step')) {
          res.status(400).json({ error: message });
          return;
        }
        res.status(502).json({ error: `Revert failed: ${message}` });
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
  // GET /api/projects/:projectId/provisioning/plan
  // Returns the ProvisioningPlan (nodes + nodeStates snapshot) for the project.
  // Creates a new plan if one does not yet exist.
  // -------------------------------------------------------------------------
  router.get('/projects/:projectId/provisioning/plan', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const module = projectManager.getProject(projectId);
      const selectedProviders = (req.query['providers'] as string | undefined)
        ?.split(',')
        .filter(Boolean) as ProviderType[] | undefined;
      const environments = module.project.environments ?? ['qa', 'production'];

      let plan = loadPersistedPlan(projectId);
      if (!plan) {
        // Build a default plan using all configured providers
        const providers: ProviderType[] = selectedProviders ?? ['firebase', 'github', 'eas'];
        plan = buildProvisioningPlan(projectId, providers, environments);
        savePersistedPlan(projectId, plan);
      }

      // Pre-mark credential gates as completed when the org tokens are already stored,
      // so the UI reflects the actual state without requiring a run first.
      const githubTokenForPlan = gitHubConnectionService.getStoredGitHubToken();
      if (githubTokenForPlan) {
        const gateState = plan.nodeStates.get('user:provide-github-pat');
        if (gateState && gateState.status === 'not-started') {
          plan.nodeStates.set('user:provide-github-pat', {
            nodeKey: 'user:provide-github-pat',
            status: 'completed',
            completedAt: Date.now(),
            resourcesProduced: { github_token: '[stored in vault]' },
          });
        }
      }

      const expoTokenForPlan = easConnectionService.getStoredExpoToken();
      if (expoTokenForPlan) {
        const gateState = plan.nodeStates.get('user:provide-expo-token');
        if (gateState && gateState.status === 'not-started') {
          plan.nodeStates.set('user:provide-expo-token', {
            nodeKey: 'user:provide-expo-token',
            status: 'completed',
            completedAt: Date.now(),
            resourcesProduced: { expo_token: '[stored in vault]' },
          });
        }
      }

      savePersistedPlan(projectId, plan);
      res.json(StepResolver.enrichPlanSnapshot(plan));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/provisioning/plan/reset
  // Rebuilds the provisioning plan (clears all node states).
  // Body: { providers?: string[], environments?: string[] }
  // -------------------------------------------------------------------------
  router.post('/projects/:projectId/provisioning/plan/reset', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const module = projectManager.getProject(projectId);
      const providers: ProviderType[] = (req.body?.providers as ProviderType[] | undefined) ?? ['firebase', 'github', 'eas'];
      const environments: string[] = (req.body?.environments as string[] | undefined) ?? module.project.environments ?? ['qa', 'production'];

      const plan = buildProvisioningPlan(projectId, providers, environments);
      savePersistedPlan(projectId, plan);

      res.json(StepResolver.enrichPlanSnapshot(plan));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/provisioning/plan/modules
  // Recompute plan from selected modules while preserving existing state.
  // Body: { modules: string[] }
  // -------------------------------------------------------------------------
  router.post('/projects/:projectId/provisioning/plan/modules', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const moduleRecord = projectManager.getProject(projectId);
      const environments = moduleRecord.project.environments ?? ['qa', 'production'];
      const modules = (req.body?.modules as ModuleId[] | undefined) ?? [];
      const resolvedModules = resolveModuleDependencies(modules);

      const previousPlan = loadPersistedPlan(projectId);
      const nextPlan = previousPlan
        ? recomputePlanForModules(previousPlan, resolvedModules)
        : buildProvisioningPlanForModules(projectId, resolvedModules, environments);

      savePersistedPlan(projectId, nextPlan);
      res.json(StepResolver.enrichPlanSnapshot(nextPlan));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/provisioning/teardown
  // Creates teardown plan from selected modules or existing provisioning plan.
  // Body: { modules?: string[] }
  // -------------------------------------------------------------------------
  router.post('/projects/:projectId/provisioning/teardown', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const moduleRecord = projectManager.getProject(projectId);
      const environments = moduleRecord.project.environments ?? ['qa', 'production'];
      const persistedPlan = loadPersistedPlan(projectId);
      const requestModules = (req.body?.modules as ModuleId[] | undefined) ?? [];
      const selectedModules = resolveModuleDependencies(
        requestModules.length > 0
          ? requestModules
          : (persistedPlan?.selectedModules as ModuleId[] | undefined) ?? [],
      );
      const providers = getProvidersForModules(selectedModules);
      const teardownPlan = buildTeardownPlan(projectId, providers, environments, selectedModules);

      savePersistedPlan(projectId, teardownPlan);
      res.json(StepResolver.enrichPlanSnapshot(teardownPlan));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/provisioning/teardown/run
  // Execute teardown plan (step-level) and stream progress.
  // -------------------------------------------------------------------------
  router.post('/projects/:projectId/provisioning/teardown/run', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const plan = loadPersistedPlan(projectId);
      if (!plan) {
        res.status(404).json({ error: `No persisted plan found for project "${projectId}".` });
        return;
      }

      const module = projectManager.getProject(projectId);
      const githubToken = gitHubConnectionService.getStoredGitHubToken();
      if (!githubToken) {
        res.status(400).json({
          error:
            'GitHub is not connected. Connect a GitHub PAT via the organization settings before running teardown.',
        });
        return;
      }

      const org = projectManager.getOrganization();
      const orgGithubConfig = org.integrations.github?.config ?? {};
      const githubOwner =
        module.project.githubOrg?.trim() ||
        orgGithubConfig['owner_default']?.trim() ||
        orgGithubConfig['username']?.trim() ||
        module.project.slug;

      const defaultBranchRules: BranchProtectionRule[] = [
        { branch: 'main', require_reviews: true, dismiss_stale_reviews: true, require_status_checks: true },
        { branch: 'develop', require_reviews: false, dismiss_stale_reviews: false, require_status_checks: true },
      ];
      const githubManifestConfig: GitHubManifestConfig = {
        provider: 'github',
        owner: githubOwner,
        repo_name: module.project.slug,
        branch_protection_rules: defaultBranchRules,
        environments: (plan.environments as Array<'dev' | 'preview' | 'prod'>),
        workflow_templates: ['build', 'deploy'],
      };
      const manifestProviders: ProviderConfig[] = [githubManifestConfig];
      if (planUsesFirebaseProvider(plan)) {
        manifestProviders.push(buildFirebaseManifestConfig(projectId));
      }
      const manifest: ProviderManifest = {
        version: PLATFORM_CORE_VERSION,
        app_id: projectId,
        providers: manifestProviders,
      };

      const registry = new ProviderRegistry();
      const httpClient = new HttpGitHubApiClient(githubToken);
      registry.register('github', new GitHubAdapter(httpClient));
      if (planUsesFirebaseProvider(plan)) {
        registry.register('firebase', new FirebaseAdapter(new StubFirebaseApiClient(), gcpConnectionService));
      }
      const orchestrator = new Orchestrator(registry, eventLog);

      const vaultPassphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
      const vaultRead = async (key: string): Promise<string | null> => {
        if (!vaultPassphrase) return null;
        try {
          const firebaseValue = vaultManager.getCredential(vaultPassphrase, 'firebase', key);
          if (firebaseValue) return firebaseValue;
          const githubValue = vaultManager.getCredential(vaultPassphrase, 'github', key);
          if (githubValue) return githubValue;
          const easValue = vaultManager.getCredential(vaultPassphrase, 'eas', key);
          return easValue ?? null;
        } catch {
          return null;
        }
      };

      void (async () => {
        const currentPlan = loadPersistedPlan(projectId);
        if (!currentPlan) return;

        for await (const event of orchestrator.teardownBySteps(currentPlan, manifest, {}, vaultRead)) {
          const stateKey = event.environment ? `${event.nodeKey}@${event.environment}` : event.nodeKey;
          currentPlan.nodeStates.set(stateKey, {
            nodeKey: event.nodeKey,
            status:
              event.status === 'success'
                ? 'completed'
                : event.status === 'failure'
                  ? 'failed'
                  : event.status === 'waiting-on-user'
                    ? 'waiting-on-user'
                    : event.status === 'skipped'
                      ? 'skipped'
                      : event.status === 'blocked'
                        ? 'blocked'
                        : 'in-progress',
            environment: event.environment,
            error: event.error,
            resourcesProduced: event.resourcesProduced,
            completedAt: event.status === 'success' || event.status === 'skipped' ? Date.now() : undefined,
          });
          savePersistedPlan(projectId, currentPlan);

          wsHandler.broadcastStepProgress(
            projectId,
            event.nodeKey,
            event.nodeType,
            event.status,
            event.environment,
            event.resourcesProduced,
            event.error,
            event.userPrompt,
          );
        }
      })();

      res.json({ started: true, projectId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId/provisioning/plan/status
  // Returns current nodeStates only (lightweight polling endpoint).
  // -------------------------------------------------------------------------
  router.get('/projects/:projectId/provisioning/plan/status', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const plan = loadPersistedPlan(projectId);
      if (!plan) {
        res.json({ nodeStates: {} });
        return;
      }
      res.json({ nodeStates: Object.fromEntries(plan.nodeStates) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/provisioning/plan/user-action/:nodeKey/complete
  // Marks a user action node as completed.
  // Body: { resourcesProduced?: Record<string, string> }
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/provisioning/plan/user-action/:nodeKey/complete',
    (req: Request, res: Response) => {
      try {
        const { projectId, nodeKey } = req.params;
        const plan = loadPersistedPlan(projectId);
        if (!plan) {
          res.status(404).json({ error: `No active provisioning plan for project "${projectId}".` });
          return;
        }

        const state = plan.nodeStates.get(nodeKey);
        if (!state) {
          res.status(404).json({ error: `Node "${nodeKey}" not found in plan.` });
          return;
        }

        const resourcesProduced = req.body?.resourcesProduced as Record<string, string> | undefined;

        const updated: NodeState = {
          ...state,
          status: 'completed',
          completedAt: Date.now(),
          resourcesProduced: resourcesProduced ?? state.resourcesProduced ?? {},
        };
        plan.nodeStates.set(nodeKey, updated);
        savePersistedPlan(projectId, plan);

        // Broadcast the status change to any connected WS clients
        wsHandler.broadcastStepProgress(
          projectId,
          nodeKey,
          'user-action',
          'success',
          undefined,
          resourcesProduced,
        );

        res.json({ nodeKey, status: 'completed', resourcesProduced });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/provisioning/plan/run
  // Starts step-level provisioning via provisionBySteps(). Responds immediately;
  // step progress is streamed to the WS channel for the project.
  // Body: { providers?: string[] }
  // -------------------------------------------------------------------------
  router.post('/projects/:projectId/provisioning/plan/run', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const module = projectManager.getProject(projectId);
      const planProviders: ProviderType[] =
        (req.body?.providers as ProviderType[] | undefined) ?? ['firebase', 'github', 'eas'];
      const environments = module.project.environments ?? ['qa', 'production'];

      // Reset the plan whenever it is not actively running so every new "Run"
      // click starts from a clean state rather than reusing stale stub data.
      const existingPlan = loadPersistedPlan(projectId);
      const planIsRunning = existingPlan
        ? Array.from(existingPlan.nodeStates.values()).some((s) => s.status === 'in-progress')
        : false;

      let plan: ProvisioningPlan;
      if (planIsRunning) {
        plan = existingPlan!;
      } else {
        plan = buildProvisioningPlan(projectId, planProviders, environments);
        savePersistedPlan(projectId, plan);
      }

      // Read the stored GitHub PAT from the credential vault
      const githubToken = gitHubConnectionService.getStoredGitHubToken();

      // Build the gate resolver — handles GCP auth, GitHub PAT, Expo token
      // auto-completion during orchestration instead of ad-hoc pre-marking.
      const gateResolver = buildProvisioningGateResolver({
        gcpConnectionService,
        easConnectionService,
        getGitHubToken: () => gitHubConnectionService.getStoredGitHubToken(),
      });

      // Determine GitHub owner: project's githubOrg, or org's default owner, or project slug
      const org = projectManager.getOrganization();
      const orgGithubConfig = org.integrations.github?.config ?? {};
      const githubOwner =
        module.project.githubOrg?.trim() ||
        orgGithubConfig['owner_default']?.trim() ||
        orgGithubConfig['username']?.trim() ||
        module.project.slug;
      const repoName = module.project.slug;

      // Build provider manifest for GitHub
      const defaultBranchRules: BranchProtectionRule[] = [
        { branch: 'main', require_reviews: true, dismiss_stale_reviews: true, require_status_checks: true },
        { branch: 'develop', require_reviews: false, dismiss_stale_reviews: false, require_status_checks: true },
      ];
      const githubManifestConfig: GitHubManifestConfig = {
        provider: 'github',
        owner: githubOwner,
        repo_name: repoName,
        branch_protection_rules: defaultBranchRules,
        environments: (plan.environments as Array<'dev' | 'preview' | 'prod'>),
        workflow_templates: ['build', 'deploy'],
      };
      const manifestProviders: ProviderConfig[] = [githubManifestConfig];
      if (planUsesFirebaseProvider(plan)) {
        manifestProviders.push(buildFirebaseManifestConfig(projectId));
      }
      const manifest: ProviderManifest = {
        version: PLATFORM_CORE_VERSION,
        app_id: projectId,
        providers: manifestProviders,
      };

      // Require a real GitHub token — refuse to run with stubs.
      if (!githubToken) {
        res.status(400).json({
          error: 'GitHub is not connected. Connect a GitHub PAT via the organization settings before running provisioning.',
        });
        return;
      }

      const registry = new ProviderRegistry();
      const httpClient = new HttpGitHubApiClient(githubToken);
      registry.register('github', new GitHubAdapter(httpClient));
      if (planUsesFirebaseProvider(plan)) {
        registry.register('firebase', new FirebaseAdapter(new StubFirebaseApiClient(), gcpConnectionService));
      }

      // Build a real vaultRead that reads from VaultManager
      const vaultPassphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
      const vaultRead = async (key: string): Promise<string | null> => {
        if (!vaultPassphrase) return null;
        try {
          // Firebase SA JSON is stored as provider='firebase', key='${projectId}/service_account_json'
          const firebaseValue = vaultManager.getCredential(vaultPassphrase, 'firebase', key);
          if (firebaseValue) return firebaseValue;
          const githubValue = vaultManager.getCredential(vaultPassphrase, 'github', key);
          if (githubValue) return githubValue;
          const easValue = vaultManager.getCredential(vaultPassphrase, 'eas', key);
          return easValue ?? null;
        } catch {
          return null;
        }
      };

      const orchestrator = new Orchestrator(registry, eventLog);

      // Run provisionBySteps in the background — do not await
      void (async () => {
        try {
          // Broadcast run start
          wsHandler.broadcastStepProgress(projectId, 'run', 'step', 'running');

          const currentPlan = loadPersistedPlan(projectId);
          if (!currentPlan) return;

          // Patch the plan's StepContext vaultRead by running through orchestrator
          // We override the context factory by wrapping provisionBySteps
          for await (const event of orchestrator.provisionBySteps(
            currentPlan,
            manifest,
            {},
            vaultRead,
            undefined,
            undefined,
            gateResolver,
          )) {
            const stateKey = event.environment
              ? `${event.nodeKey}@${event.environment}`
              : event.nodeKey;

            currentPlan.nodeStates.set(stateKey, {
              nodeKey: event.nodeKey,
              status: event.status === 'success'
                ? 'completed'
                : event.status === 'failure'
                  ? 'failed'
                  : event.status === 'waiting-on-user'
                    ? 'waiting-on-user'
                    : event.status === 'resolving'
                      ? 'resolving'
                      : event.status === 'skipped'
                        ? 'skipped'
                        : event.status === 'blocked'
                          ? 'blocked'
                          : 'in-progress',
              environment: event.environment,
              error: event.error,
              resourcesProduced: event.resourcesProduced,
              completedAt: event.status === 'success' || event.status === 'skipped' ? Date.now() : undefined,
            });

            wsHandler.broadcastStepProgress(
              projectId,
              event.nodeKey,
              event.nodeType,
              event.status,
              event.environment,
              event.resourcesProduced,
              event.error,
              event.userPrompt,
            );
            savePersistedPlan(projectId, currentPlan);
          }
        } catch (err) {
          console.error(`[plan/run] Error running provisionBySteps for ${projectId}:`, (err as Error).message);
        }
      })();

      res.json({ started: true, projectId });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/provisioning/plan/run/nodes
  // Runs only the specified node keys. Does NOT reset the plan.
  // Body: { nodeKeys: string[] }
  // -------------------------------------------------------------------------
  router.post('/projects/:projectId/provisioning/plan/run/nodes', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const nodeKeys: string[] = (req.body?.nodeKeys as string[] | undefined) ?? [];
      if (!nodeKeys.length) {
        res.status(400).json({ error: 'nodeKeys must be a non-empty array.' });
        return;
      }

      const plan = loadPersistedPlan(projectId);
      if (!plan) {
        res.status(404).json({ error: `No active provisioning plan for project "${projectId}". Load the plan first.` });
        return;
      }

      const isAlreadyRunning = Array.from(plan.nodeStates.values()).some((s) => s.status === 'in-progress');
      if (isAlreadyRunning) {
        res.status(409).json({ error: 'Provisioning is already running. Wait for it to finish before starting a targeted run.' });
        return;
      }

      const githubToken = gitHubConnectionService.getStoredGitHubToken();
      if (!githubToken) {
        res.status(400).json({
          error: 'GitHub is not connected. Connect a GitHub PAT via the organization settings before running provisioning.',
        });
        return;
      }

      const nodesGateResolver = buildProvisioningGateResolver({
        gcpConnectionService,
        easConnectionService,
        getGitHubToken: () => gitHubConnectionService.getStoredGitHubToken(),
      });

      const module = projectManager.getProject(projectId);
      const org = projectManager.getOrganization();
      const orgGithubConfig = org.integrations.github?.config ?? {};
      const githubOwner =
        module.project.githubOrg?.trim() ||
        orgGithubConfig['owner_default']?.trim() ||
        orgGithubConfig['username']?.trim() ||
        module.project.slug;

      const defaultBranchRules: BranchProtectionRule[] = [
        { branch: 'main', require_reviews: true, dismiss_stale_reviews: true, require_status_checks: true },
        { branch: 'develop', require_reviews: false, dismiss_stale_reviews: false, require_status_checks: true },
      ];
      const githubManifestConfig: GitHubManifestConfig = {
        provider: 'github',
        owner: githubOwner,
        repo_name: module.project.slug,
        branch_protection_rules: defaultBranchRules,
        environments: (plan.environments as Array<'dev' | 'preview' | 'prod'>),
        workflow_templates: ['build', 'deploy'],
      };
      const manifestProviders: ProviderConfig[] = [githubManifestConfig];
      if (planUsesFirebaseProvider(plan)) {
        manifestProviders.push(buildFirebaseManifestConfig(projectId));
      }
      const manifest: ProviderManifest = {
        version: PLATFORM_CORE_VERSION,
        app_id: projectId,
        providers: manifestProviders,
      };

      const registry = new ProviderRegistry();
      const httpClient = new HttpGitHubApiClient(githubToken);
      registry.register('github', new GitHubAdapter(httpClient));
      if (planUsesFirebaseProvider(plan)) {
        registry.register('firebase', new FirebaseAdapter(new StubFirebaseApiClient(), gcpConnectionService));
      }

      const vaultPassphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
      const vaultRead = async (key: string): Promise<string | null> => {
        if (!vaultPassphrase) return null;
        try {
          const firebaseValue = vaultManager.getCredential(vaultPassphrase, 'firebase', key);
          if (firebaseValue) return firebaseValue;
          const githubValue = vaultManager.getCredential(vaultPassphrase, 'github', key);
          if (githubValue) return githubValue;
          const easValue = vaultManager.getCredential(vaultPassphrase, 'eas', key);
          return easValue ?? null;
        } catch {
          return null;
        }
      };

      const orchestrator = new Orchestrator(registry, eventLog);
      const nodeKeysFilter = new Set(nodeKeys);

      void (async () => {
        try {
          wsHandler.broadcastStepProgress(projectId, 'run', 'step', 'running');

          const currentPlan = loadPersistedPlan(projectId);
          if (!currentPlan) return;
          for await (const event of orchestrator.provisionBySteps(
            currentPlan,
            manifest,
            {},
            vaultRead,
            undefined,
            nodeKeysFilter,
            nodesGateResolver,
          )) {
            const stateKey = event.environment ? `${event.nodeKey}@${event.environment}` : event.nodeKey;
            currentPlan.nodeStates.set(stateKey, {
              nodeKey: event.nodeKey,
              status: event.status === 'success'
                ? 'completed'
                : event.status === 'failure'
                  ? 'failed'
                  : event.status === 'waiting-on-user'
                    ? 'waiting-on-user'
                    : event.status === 'resolving'
                      ? 'resolving'
                      : event.status === 'skipped'
                        ? 'skipped'
                        : event.status === 'blocked'
                          ? 'blocked'
                          : 'in-progress',
              environment: event.environment,
              error: event.error,
              resourcesProduced: event.resourcesProduced,
              completedAt: event.status === 'success' || event.status === 'skipped' ? Date.now() : undefined,
            });

            wsHandler.broadcastStepProgress(
              projectId,
              event.nodeKey,
              event.nodeType,
              event.status,
              event.environment,
              event.resourcesProduced,
              event.error,
              event.userPrompt,
            );
            savePersistedPlan(projectId, currentPlan);
          }
        } catch (err) {
          console.error(`[plan/run/nodes] Error for ${projectId}:`, (err as Error).message);
        }
      })();

      res.json({ started: true, projectId, nodeKeys });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/provisioning/plan/node/reset
  // Resets one logical node (all env instances if per-environment) and every
  // transitive dependent to not-started. For Firebase nodes this also
  // performs real GCP cleanup (delete SA, remove IAM bindings, clear vault).
  // Body: { nodeKey: string }
  // -------------------------------------------------------------------------
  router.post('/projects/:projectId/provisioning/plan/node/reset', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const nodeKey = req.body?.nodeKey as string | undefined;
      if (!nodeKey || typeof nodeKey !== 'string') {
        res.status(400).json({ error: 'nodeKey is required.' });
        return;
      }

      const plan = loadPersistedPlan(projectId);
      if (!plan) {
        res.status(404).json({ error: `No active provisioning plan for project "${projectId}".` });
        return;
      }

      const anyInProgress = Array.from(plan.nodeStates.values()).some((s) => s.status === 'in-progress');
      if (anyInProgress) {
        res.status(409).json({ error: 'Wait for in-progress provisioning to finish before reverting a step.' });
        return;
      }

      const node = plan.nodes.find((n) => n.key === nodeKey);
      if (!node) {
        res.status(404).json({ error: `Unknown node "${nodeKey}".` });
        return;
      }

      if (logicalNodeInProgress(node, plan)) {
        res.status(409).json({ error: 'Cannot revert a step that is currently in progress.' });
        return;
      }

      const dependents = collectDependentNodeKeys(nodeKey, plan.nodes);
      const allKeysToReset = [nodeKey, ...dependents];

      const GRAPH_TO_BOOTSTRAP: Record<string, GcpBootstrapPhaseId> = {
        'firebase:create-gcp-project': 'gcp_project',
        'firebase:enable-firebase': 'gcp_project',
        'firebase:create-provisioner-sa': 'service_account',
        'firebase:bind-provisioner-iam': 'iam_binding',
        'firebase:generate-sa-key': 'vault',
      };

      const BOOTSTRAP_REVERT_ORDER: GcpBootstrapPhaseId[] = [
        'oauth_consent',
        'gcp_project',
        'service_account',
        'iam_binding',
        'vault',
      ];

      const oauthStepsToRevert = new Set<GcpBootstrapPhaseId>();
      for (const key of allKeysToReset) {
        const mapped = GRAPH_TO_BOOTSTRAP[key];
        if (!mapped) continue;
        for (const stepId of GcpConnectionService.getCascadeSteps(mapped)) {
          oauthStepsToRevert.add(stepId);
        }
      }

      let revertWarnings: string[] = [];
      if (oauthStepsToRevert.size > 0) {
        const cascadeIds = BOOTSTRAP_REVERT_ORDER.filter((id) => oauthStepsToRevert.has(id));

        // iam_binding and service_account require a live OAuth token to call GCP APIs.
        // If we don't have one, return needsReauth so the UI can re-authenticate before retrying.
        const needsGcpApiCalls = cascadeIds.some((id) => id === 'iam_binding' || id === 'service_account');
        if (needsGcpApiCalls) {
          const hasToken = await gcpConnectionService.hasGcpOAuthToken(projectId);
          if (!hasToken) {
            const oauthResult = await gcpConnectionService.startProjectOAuthFlow(projectId);
            console.log(
              `[studio-api] node/reset: no GCP OAuth token for ${projectId} — returning needsReauth (session ${oauthResult.sessionId})`,
            );
            res.json({
              needsReauth: true,
              sessionId: oauthResult.sessionId,
              authUrl: oauthResult.authUrl,
            });
            return;
          }
        }

        console.log(
          `[studio-api] node/reset: reverting GCP resources for ${projectId}: ${cascadeIds.join(', ')}`,
        );
        const results = await gcpConnectionService.revertSteps(projectId, cascadeIds);
        // gcp_project: intentionally never deleted via provisioner — informational, not a failure.
        // vault/oauth_consent: "kept for retry" is a secondary consequence of GCP failures already reported above.
        const INFORMATIONAL_STEP_IDS = new Set(['gcp_project', 'vault', 'oauth_consent']);
        revertWarnings = results
          .filter((r) => !r.reverted && !INFORMATIONAL_STEP_IDS.has(r.stepId))
          .map((r) => `${r.stepId}: ${r.message}`);
        if (revertWarnings.length > 0) {
          console.warn(
            `[studio-api] node/reset: partial GCP revert for ${projectId}: ${revertWarnings.join('; ')}`,
          );
        }
      }

      clearLogicalNodeState(plan, node);
      for (const depKey of dependents) {
        const n = plan.nodes.find((x) => x.key === depKey);
        if (n) clearLogicalNodeState(plan, n);
      }

      savePersistedPlan(projectId, plan);

      const enriched = StepResolver.enrichPlanSnapshot(plan);
      if (revertWarnings.length > 0) {
        (enriched as any).revertWarnings = revertWarnings;
      }
      res.json(enriched);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/provisioning/plan/node/skip
  // Persists skip for one logical node (all non-terminal per-env instances if applicable).
  // Body: { nodeKey: string }
  // -------------------------------------------------------------------------
  router.post('/projects/:projectId/provisioning/plan/node/skip', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const nodeKey = req.body?.nodeKey as string | undefined;
      if (!nodeKey || typeof nodeKey !== 'string') {
        res.status(400).json({ error: 'nodeKey is required.' });
        return;
      }

      const plan = loadPersistedPlan(projectId);
      if (!plan) {
        res.status(404).json({ error: `No active provisioning plan for project "${projectId}".` });
        return;
      }

      const anyInProgress = Array.from(plan.nodeStates.values()).some((s) => s.status === 'in-progress');
      if (anyInProgress) {
        res.status(409).json({ error: 'Wait for in-progress provisioning to finish before skipping a step.' });
        return;
      }

      const node = plan.nodes.find((n) => n.key === nodeKey);
      if (!node) {
        res.status(404).json({ error: `Unknown node "${nodeKey}".` });
        return;
      }

      if (logicalNodeInProgress(node, plan)) {
        res.status(409).json({ error: 'Cannot skip a step that is currently in progress.' });
        return;
      }

      const touched = applySkipToNode(plan, node);
      const nodeType: 'step' | 'user-action' = node.type === 'user-action' ? 'user-action' : 'step';
      for (const t of touched) {
        wsHandler.broadcastStepProgress(projectId, nodeKey, nodeType, 'skipped', t.environment, {});
      }

      savePersistedPlan(projectId, plan);
      res.json(StepResolver.enrichPlanSnapshot(plan));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/provisioning/plan/node/revalidate
  // Runs adapter.checkStep for a completed automated step (per env instance).
  // Body: { nodeKey: string }
  // -------------------------------------------------------------------------
  router.post('/projects/:projectId/provisioning/plan/node/revalidate', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const nodeKey = req.body?.nodeKey as string | undefined;
      if (!nodeKey || typeof nodeKey !== 'string') {
        res.status(400).json({ error: 'nodeKey is required.' });
        return;
      }

      const plan = loadPersistedPlan(projectId);
      if (!plan) {
        res.status(404).json({ error: `No active provisioning plan for project "${projectId}".` });
        return;
      }

      const anyInProgress = Array.from(plan.nodeStates.values()).some((s) => s.status === 'in-progress');
      if (anyInProgress) {
        res.status(409).json({ error: 'Wait for in-progress work to finish before revalidating.' });
        return;
      }

      const node = plan.nodes.find((n) => n.key === nodeKey);
      if (!node || node.type !== 'step') {
        res.json({
          supported: false,
          message: 'Revalidate applies to completed automated steps only.',
          plan: StepResolver.enrichPlanSnapshot(plan),
        });
        return;
      }

      if (node.direction === 'teardown') {
        res.json({
          supported: false,
          message: 'Teardown steps are not revalidated from here.',
          plan: StepResolver.enrichPlanSnapshot(plan),
        });
        return;
      }

      const projModule = projectManager.getProject(projectId);
      const org = projectManager.getOrganization();
      const orgGithubConfig = org.integrations.github?.config ?? {};
      const githubOwner =
        projModule.project.githubOrg?.trim() ||
        orgGithubConfig['owner_default']?.trim() ||
        orgGithubConfig['username']?.trim() ||
        projModule.project.slug;
      const defaultBranchRules: BranchProtectionRule[] = [
        { branch: 'main', require_reviews: true, dismiss_stale_reviews: true, require_status_checks: true },
        { branch: 'develop', require_reviews: false, dismiss_stale_reviews: false, require_status_checks: true },
      ];
      const githubManifestConfig: GitHubManifestConfig = {
        provider: 'github',
        owner: githubOwner,
        repo_name: projModule.project.slug,
        branch_protection_rules: defaultBranchRules,
        environments: (plan.environments as Array<'dev' | 'preview' | 'prod'>),
        workflow_templates: ['build', 'deploy'],
      };

      const githubToken = gitHubConnectionService.getStoredGitHubToken();
      if (node.provider === 'github' && !githubToken) {
        res.status(400).json({
          error: 'GitHub is not connected. Connect a GitHub PAT before revalidating GitHub steps.',
        });
        return;
      }

      const registry = new ProviderRegistry();
      if (githubToken) {
        registry.register('github', new GitHubAdapter(new HttpGitHubApiClient(githubToken)));
      }

      if (!registry.hasAdapter(node.provider)) {
        res.json({
          supported: false,
          message: `Provider "${node.provider}" has no revalidation hook in Studio yet.`,
          plan: StepResolver.enrichPlanSnapshot(plan),
        });
        return;
      }

      const adapter = registry.getAdapter(node.provider);
      if (!adapter.checkStep) {
        res.json({
          supported: false,
          message: `Step checks are not implemented for provider "${node.provider}".`,
          plan: StepResolver.enrichPlanSnapshot(plan),
        });
        return;
      }

      const vaultPassphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
      const vaultRead = async (key: string): Promise<string | null> => {
        if (!vaultPassphrase) return null;
        try {
          const firebaseValue = vaultManager.getCredential(vaultPassphrase, 'firebase', key);
          if (firebaseValue) return firebaseValue;
          const githubValue = vaultManager.getCredential(vaultPassphrase, 'github', key);
          if (githubValue) return githubValue;
          const easValue = vaultManager.getCredential(vaultPassphrase, 'eas', key);
          return easValue ?? null;
        } catch {
          return null;
        }
      };

      const { sequentialExecutionItems } = buildPlanViewModel(plan.nodes, plan.environments);
      const upstream: Record<string, string> = {};
      for (const item of sequentialExecutionItems) {
        if (item.nodeKey === nodeKey) break;
        const sk = item.environment ? `${item.nodeKey}@${item.environment}` : item.nodeKey;
        const st = plan.nodeStates.get(sk);
        if (st?.resourcesProduced) Object.assign(upstream, st.resourcesProduced);
      }

      const results: Array<{ environment?: string; stillValid: boolean }> = [];
      const targetItems = sequentialExecutionItems.filter((i) => i.nodeKey === nodeKey);
      let checked = 0;

      for (const item of targetItems) {
        const stateKey = item.environment ? `${nodeKey}@${item.environment}` : nodeKey;
        const existing = plan.nodeStates.get(stateKey);
        if (existing?.status !== 'completed' && existing?.status !== 'skipped') continue;

        const context: StepContext = {
          projectId,
          environment: item.environment ?? 'global',
          upstreamResources: { ...upstream },
          vaultRead,
          vaultWrite: async () => { },
        };

        const configForProvider =
          node.provider === 'github' ? githubManifestConfig : ({} as GitHubManifestConfig);

        try {
          const result = await adapter.checkStep(nodeKey, configForProvider, context);
          checked++;
          if (result.status === 'completed') {
            plan.nodeStates.set(stateKey, {
              nodeKey,
              status: 'completed',
              environment: item.environment,
              completedAt: Date.now(),
              resourcesProduced: result.resourcesProduced ?? existing?.resourcesProduced,
            });
            if (result.resourcesProduced) Object.assign(upstream, result.resourcesProduced);
            results.push({ environment: item.environment, stillValid: true });
          } else {
            plan.nodeStates.set(stateKey, {
              nodeKey,
              status: 'not-started',
              environment: item.environment,
            });
            results.push({ environment: item.environment, stillValid: false });
          }
        } catch {
          checked++;
          plan.nodeStates.set(stateKey, {
            nodeKey,
            status: 'not-started',
            environment: item.environment,
          });
          results.push({ environment: item.environment, stillValid: false });
        }
      }

      if (checked === 0) {
        res.json({
          supported: true,
          message: 'No completed instances of this step to revalidate.',
          results: [],
          plan: StepResolver.enrichPlanSnapshot(plan),
        });
        return;
      }

      savePersistedPlan(projectId, plan);
      res.json({
        supported: true,
        results,
        plan: StepResolver.enrichPlanSnapshot(plan),
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
  // POST /api/projects/:projectId/provisioning/plan/sync
  // Walks through every step in topological order, calling checkStep() on
  // the adapter to see if the resource already exists. If a step check
  // fails, all its dependents are marked 'not-started' and skipped.
  // Firebase graph steps use GcpConnectionService live checks. Responds after
  // sync finishes and the plan is saved so clients can GET an up-to-date plan.
  // -------------------------------------------------------------------------
  router.post('/projects/:projectId/provisioning/plan/sync', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const _module = projectManager.getProject(projectId);

      let plan = loadPersistedPlan(projectId);
      if (!plan) {
        const environments = _module.project.environments ?? ['qa', 'production'];
        const providers: ProviderType[] = ['firebase', 'github', 'eas'];
        plan = buildProvisioningPlan(projectId, providers, environments);
        savePersistedPlan(projectId, plan);
      }

      const isAlreadyRunning = Array.from(plan.nodeStates.values()).some(
        (s) => s.status === 'in-progress',
      );
      if (isAlreadyRunning) {
        res.status(409).json({
          error: 'Provisioning is already running. Wait for it to finish before syncing.',
        });
        return;
      }

      const githubToken = gitHubConnectionService.getStoredGitHubToken();
      if (!githubToken) {
        res.status(400).json({
          error: 'GitHub is not connected. Connect a GitHub PAT before syncing.',
        });
        return;
      }

      const org = projectManager.getOrganization();
      const orgGithubConfig = org.integrations.github?.config ?? {};
      const githubOwner =
        _module.project.githubOrg?.trim() ||
        orgGithubConfig['owner_default']?.trim() ||
        orgGithubConfig['username']?.trim() ||
        _module.project.slug;
      const repoName = _module.project.slug;

      const defaultBranchRules: BranchProtectionRule[] = [
        { branch: 'main', require_reviews: true, dismiss_stale_reviews: true, require_status_checks: true },
        { branch: 'develop', require_reviews: false, dismiss_stale_reviews: false, require_status_checks: true },
      ];
      const githubManifestConfig: GitHubManifestConfig = {
        provider: 'github',
        owner: githubOwner,
        repo_name: repoName,
        branch_protection_rules: defaultBranchRules,
        environments: (plan.environments as Array<'dev' | 'preview' | 'prod'>),
        workflow_templates: ['build', 'deploy'],
      };

      const registry = new ProviderRegistry();
      const httpClient = new HttpGitHubApiClient(githubToken);
      registry.register('github', new GitHubAdapter(httpClient));

      const vaultPassphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
      const vaultRead = async (key: string): Promise<string | null> => {
        if (!vaultPassphrase) return null;
        try {
          const firebaseValue = vaultManager.getCredential(vaultPassphrase, 'firebase', key);
          if (firebaseValue) return firebaseValue;
          const githubValue = vaultManager.getCredential(vaultPassphrase, 'github', key);
          if (githubValue) return githubValue;
          const easValue = vaultManager.getCredential(vaultPassphrase, 'eas', key);
          return easValue ?? null;
        } catch {
          return null;
        }
      };

      // Resolve credential gates before sync — uses the same resolver the
      // orchestrator would use so gate resolution logic lives in one place.
      const syncGateResolver = buildProvisioningGateResolver({
        gcpConnectionService,
        easConnectionService,
        getGitHubToken: () => gitHubConnectionService.getStoredGitHubToken(),
      });

      const gateNodeKeys = plan.nodes
        .filter((n) => n.type === 'user-action')
        .map((n) => n.key);
      for (const nodeKey of gateNodeKeys) {
        const existing = plan.nodeStates.get(nodeKey);
        if (existing?.status === 'completed') continue;
        try {
          const gateResult = await syncGateResolver.canResolve(nodeKey, {
            projectId,
            environment: 'global',
            upstreamResources: {},
            vaultRead,
            vaultWrite: async () => { },
          });
          if (gateResult.resolved) {
            plan.nodeStates.set(nodeKey, {
              nodeKey, status: 'completed', completedAt: Date.now(),
              resourcesProduced: gateResult.resourcesProduced,
            });
            if (gateResult.completedSteps) {
              for (const step of gateResult.completedSteps) {
                const stepState = plan.nodeStates.get(step.nodeKey);
                if (!stepState || stepState.status !== 'completed') {
                  plan.nodeStates.set(step.nodeKey, {
                    nodeKey: step.nodeKey, status: 'completed', completedAt: Date.now(),
                    resourcesProduced: step.resourcesProduced,
                  });
                }
              }
            }
          }
        } catch { /* resolver failed — leave gate as-is */ }
      }
      savePersistedPlan(projectId, plan);

      wsHandler.broadcastStepProgress(projectId, 'sync', 'step', 'running');

      const currentPlan = loadPersistedPlan(projectId);
      if (!currentPlan) {
        res.status(500).json({ error: 'Provisioning plan missing after gate sync.' });
        return;
      }

      const firebaseResults: Array<{ nodeKey: string; reconciled: boolean; message: string }> = [];

      try {
        const executionGroups = StepResolver.resolveExecutionPlan(currentPlan.nodes, currentPlan.environments);

        const upstreamResources: Record<string, string> = {};
        const failedNodeKeys = new Set<string>();

        for (const group of executionGroups) {
          for (const item of group.items) {
            const node = currentPlan.nodes.find((n) => n.key === item.nodeKey);
            if (!node) continue;

            const stateKey = item.environment ? `${item.nodeKey}@${item.environment}` : item.nodeKey;

            const existingState = currentPlan.nodeStates.get(stateKey);
            // Firebase steps are always re-validated against live GCP state to detect drift.
            const isFirebaseStep = node.provider === 'firebase' && node.type === 'step';
            if (existingState?.status === 'completed' && !isFirebaseStep) {
              if (existingState.resourcesProduced) {
                Object.assign(upstreamResources, existingState.resourcesProduced);
              }
              wsHandler.broadcastStepProgress(
                projectId, item.nodeKey, node.type === 'user-action' ? 'user-action' : 'step',
                'success', item.environment, existingState.resourcesProduced,
              );
              continue;
            }

            if (node.type === 'user-action') {
              failedNodeKeys.add(item.nodeKey);
              continue;
            }

            const hasFailedDep = node.dependencies.some(
              (dep) => dep.required && failedNodeKeys.has(dep.nodeKey),
            );
            if (hasFailedDep) {
              // Propagate transitively: mark this node as failed too so its own
              // dependents are also skipped in subsequent iterations.
              failedNodeKeys.add(item.nodeKey);
              currentPlan.nodeStates.set(stateKey, {
                nodeKey: item.nodeKey,
                status: 'not-started',
                environment: item.environment,
              });
              wsHandler.broadcastStepProgress(
                projectId, item.nodeKey, 'step', 'ready',
                item.environment,
              );
              continue;
            }

            if (node.provider === 'firebase' && node.type === 'step') {
              const fbSync = await gcpConnectionService.syncProvisioningFirebaseGraphStep(
                projectId,
                item.nodeKey,
              );
              if (fbSync !== null) {
                const fbMsg = fbSync.reconciled ? 'reconciled' : `not matched — ${fbSync.message}`;
                console.log(`[studio-api] plan/sync Firebase "${item.nodeKey}" (${projectId}): ${fbMsg}`);
                firebaseResults.push({ nodeKey: item.nodeKey, reconciled: fbSync.reconciled, message: fbMsg });
                wsHandler.broadcastStepProgress(
                  projectId,
                  item.nodeKey,
                  'step',
                  'running',
                  item.environment,
                );
                if (fbSync.reconciled) {
                  Object.assign(upstreamResources, fbSync.resourcesProduced);
                  currentPlan.nodeStates.set(stateKey, {
                    nodeKey: item.nodeKey,
                    status: 'completed',
                    environment: item.environment,
                    completedAt: Date.now(),
                    resourcesProduced: fbSync.resourcesProduced,
                  });
                  wsHandler.broadcastStepProgress(
                    projectId,
                    item.nodeKey,
                    'step',
                    'success',
                    item.environment,
                    fbSync.resourcesProduced,
                  );
                } else {
                  if (fbSync.suggestsReauth) {
                    savePersistedPlan(projectId, currentPlan);
                    const oauthResult = await gcpConnectionService.startProjectOAuthFlow(projectId);
                    console.log(
                      `[studio-api] plan/sync: Firebase step "${item.nodeKey}" requires re-auth — started OAuth session ${oauthResult.sessionId}`,
                    );
                    res.json({
                      ok: false,
                      needsReauth: true,
                      sessionId: oauthResult.sessionId,
                      authUrl: oauthResult.authUrl,
                      projectId,
                    });
                    return;
                  }
                  failedNodeKeys.add(item.nodeKey);
                  currentPlan.nodeStates.set(stateKey, {
                    nodeKey: item.nodeKey,
                    status: 'not-started',
                    environment: item.environment,
                  });
                  wsHandler.broadcastStepProgress(
                    projectId,
                    item.nodeKey,
                    'step',
                    'ready',
                    item.environment,
                  );
                }
                continue;
              }
            }

            if (!registry.hasAdapter(node.provider)) {
              continue;
            }

            const adapter = registry.getAdapter(node.provider);
            if (!adapter.checkStep) {
              continue;
            }

            wsHandler.broadcastStepProgress(
              projectId, item.nodeKey, 'step', 'running',
              item.environment,
            );

            const configForProvider =
              node.provider === 'github' ? githubManifestConfig : ({} as any);

            const context: StepContext = {
              projectId: currentPlan.projectId,
              environment: item.environment ?? 'global',
              upstreamResources: { ...upstreamResources },
              vaultRead,
              vaultWrite: async () => { },
            };

            try {
              const result = await adapter.checkStep(item.nodeKey, configForProvider, context);

              if (result.status === 'completed') {
                if (result.resourcesProduced) {
                  Object.assign(upstreamResources, result.resourcesProduced);
                }
                currentPlan.nodeStates.set(stateKey, {
                  nodeKey: item.nodeKey,
                  status: 'completed',
                  environment: item.environment,
                  completedAt: Date.now(),
                  resourcesProduced: result.resourcesProduced,
                });
                wsHandler.broadcastStepProgress(
                  projectId, item.nodeKey, 'step', 'success',
                  item.environment, result.resourcesProduced,
                );
              } else {
                failedNodeKeys.add(item.nodeKey);
                currentPlan.nodeStates.set(stateKey, {
                  nodeKey: item.nodeKey,
                  status: 'not-started',
                  environment: item.environment,
                });
                wsHandler.broadcastStepProgress(
                  projectId, item.nodeKey, 'step', 'ready',
                  item.environment,
                );
              }
            } catch {
              failedNodeKeys.add(item.nodeKey);
              currentPlan.nodeStates.set(stateKey, {
                nodeKey: item.nodeKey,
                status: 'not-started',
                environment: item.environment,
              });
              wsHandler.broadcastStepProgress(
                projectId, item.nodeKey, 'step', 'ready',
                item.environment,
              );
            }
          }
        }

        savePersistedPlan(projectId, currentPlan);
        wsHandler.broadcastStepProgress(projectId, 'sync', 'step', 'success');
      } catch (syncErr) {
        console.error(`[plan/sync] Error syncing for ${projectId}:`, (syncErr as Error).message);
        wsHandler.broadcastStepProgress(projectId, 'sync', 'step', 'failure');
        res.status(500).json({ error: (syncErr as Error).message });
        return;
      }

      res.json({ ok: true, projectId, firebaseResults });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
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
