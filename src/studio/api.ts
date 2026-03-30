/**
 * Studio UI REST API routes.
 *
 * Core provisioning endpoints:
 *   POST /api/projects/:projectId/oauth/:providerId/start         — start unified OAuth session
 *   GET  /api/projects/:projectId/oauth/:providerId/sessions/:sid — poll OAuth session status
 *   POST /api/projects/:projectId/oauth/:providerId/discover      — GCP project discovery
 *   POST /api/projects/:projectId/oauth/:providerId/validate      — validate provider connection
 *   DELETE /api/projects/:projectId/oauth/:providerId/connection  — revoke provider connection
 *   GET  /api/projects/:projectId/provisioning/plan               — get/create provisioning plan
 *   POST /api/projects/:projectId/provisioning/plan/sync          — reconcile plan with real-world state
 *   POST /api/projects/:projectId/provisioning/plan/run           — execute full plan
 *   POST /api/projects/:projectId/provisioning/plan/run/nodes     — execute specific nodes
 *   POST /api/projects/:projectId/provisioning/plan/node/reset    — revert a node (with real cleanup)
 *   POST /api/projects/:projectId/provisioning/plan/node/revalidate — re-check a completed node
 *   POST /api/projects/:projectId/provisioning/teardown           — build teardown plan
 *   POST /api/projects/:projectId/provisioning/teardown/run       — execute teardown
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
import { globalStepHandlerRegistry } from '../provisioning/step-handler-registry.js';
import { FIREBASE_STEP_HANDLERS } from '../core/gcp/gcp-step-handlers.js';
import { createVaultReader } from './api-helpers.js';

// Register all step handlers at startup
globalStepHandlerRegistry.registerAll(FIREBASE_STEP_HANDLERS);

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
  const SERVER_STARTED_AT = Date.now();
  const projectManager = new ProjectManager(storeDir);
  const vaultManager = new VaultManager(path.join(storeDir, 'credentials.enc'), () => { /* vault logs suppressed */ });
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

  // NOTE: POST /firebase/steps/sync was removed (redundant — oauth_consent status is
  // available via /oauth/gcp/validate and /provisioning/plan/sync handles infra steps).

  // =========================================================================
  // Unified OAuth session routes (provider-agnostic)
  // Frontend should prefer these over the firebase-specific paths above.
  // =========================================================================

  // POST /api/projects/:projectId/oauth/:providerId/start
  router.post('/projects/:projectId/oauth/:providerId/start', async (req: Request, res: Response) => {
    try {
      const { projectId, providerId } = req.params;
      if (providerId !== 'gcp') {
        res.status(400).json({ error: `Unsupported OAuth provider: "${providerId}". Currently only "gcp" is supported.` });
        return;
      }
      const session = await gcpConnectionService.startProjectOAuthFlow(projectId);
      res.json(session);
    } catch (err) {
      const message = (err as Error).message;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(502).json({ error: `Failed to start ${req.params.providerId} OAuth flow: ${message}` });
    }
  });

  // GET /api/projects/:projectId/oauth/:providerId/sessions/:sessionId
  router.get('/projects/:projectId/oauth/:providerId/sessions/:sessionId', (req: Request, res: Response) => {
    try {
      const { projectId, providerId, sessionId } = req.params;
      if (providerId !== 'gcp') {
        res.status(400).json({ error: `Unsupported OAuth provider: "${providerId}".` });
        return;
      }
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
  });

  // POST /api/projects/:projectId/oauth/:providerId/discover
  router.post('/projects/:projectId/oauth/:providerId/discover', async (req: Request, res: Response) => {
    try {
      const { projectId, providerId } = req.params;
      if (providerId !== 'gcp') {
        res.status(400).json({ error: `Unsupported OAuth provider: "${providerId}".` });
        return;
      }
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
  });

  // POST /api/projects/:projectId/oauth/:providerId/validate
  router.post('/projects/:projectId/oauth/:providerId/validate', async (req: Request, res: Response) => {
    try {
      const { projectId, providerId } = req.params;
      if (providerId !== 'gcp') {
        res.status(400).json({ error: `Unsupported OAuth provider: "${providerId}".` });
        return;
      }
      const result = await gcpConnectionService.validateStep(projectId, 'oauth_consent');
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(502).json({ error: `Validation failed: ${message}` });
    }
  });

  // DELETE /api/projects/:projectId/oauth/:providerId/connection — revoke tokens + disconnect
  router.delete('/projects/:projectId/oauth/:providerId/connection', (req: Request, res: Response) => {
    try {
      const { projectId, providerId } = req.params;
      if (providerId !== 'gcp') {
        res.status(400).json({ error: `Unsupported OAuth provider: "${providerId}".` });
        return;
      }
      const result = gcpConnectionService.disconnectProject(projectId);
      console.log(`[studio-api] OAuth/GCP disconnected for Studio project "${projectId}".`);
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(502).json({ error: `Failed to disconnect ${req.params.providerId}: ${message}` });
    }
  });

  // POST /api/projects/:projectId/oauth/gcp/delete-linked-project
  // Deletes the GCP project linked to this studio project using the stored OAuth token.
  // Useful for cleaning up orphaned GCP projects (e.g. created under a different console account).
  router.post('/projects/:projectId/oauth/gcp/delete-linked-project', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const result = await gcpConnectionService.deleteLinkedGcpProject(projectId);
      res.json({ deleted: true, ...result });
    } catch (err) {
      const message = (err as Error).message;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(502).json({ error: message });
    }
  });

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
      const vaultRead = createVaultReader(vaultManager);

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

      const vaultRead = createVaultReader(vaultManager);

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
  // Runs specific node keys from the plan.  Does NOT reset the plan.
  //
  // Steps with a registered StepHandler (firebase/* steps) are executed
  // directly via handler.create(context) — this calls the real GCP APIs.
  //
  // Steps without a registered handler (github/*, eas/*) are forwarded to
  // the orchestrator which uses its provider adapter system.
  //
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

      // Expand per-environment steps sent as base keys (e.g. "firebase:enable-services")
      // into their env-specific variants ("firebase:enable-services@dev", etc.) so state
      // is written to the correct per-env keys that the UI reads.
      const expandedNodeKeys: string[] = [];
      for (const nk of nodeKeys) {
        if (nk.includes('@')) {
          expandedNodeKeys.push(nk);
          continue;
        }
        const planNode = plan.nodes.find((n) => n.key === nk);
        if (planNode?.type === 'step' && (planNode as any).environmentScope === 'per-environment' && plan.environments.length > 0) {
          for (const env of plan.environments) {
            expandedNodeKeys.push(`${nk}@${env}`);
          }
        } else {
          expandedNodeKeys.push(nk);
        }
      }
      const effectiveNodeKeys = expandedNodeKeys;

      // Clear any in-progress states that are definitively stuck:
      //   1. Started before this server process launched (can't survive a restart), or
      //   2. Older than 10 minutes (handler crash / no handler registered).
      const STALE_THRESHOLD_MS = 10 * 60 * 1000;
      const now = Date.now();
      let clearedStale = false;
      for (const [key, state] of plan.nodeStates.entries()) {
        if (state.status === 'in-progress') {
          const startedAt = state.startedAt ?? 0;
          const preStartup = startedAt < SERVER_STARTED_AT;
          const age = now - startedAt;
          if (preStartup || age > STALE_THRESHOLD_MS) {
            const reason = preStartup
              ? 'Step was in-progress when the server last restarted.'
              : `Step timed out (stuck in-progress for ${Math.round(age / 1000)}s).`;
            console.warn(
              `[plan/run/nodes] studio="${projectId}" | Clearing stale in-progress node "${key}" — ${reason}`,
            );
            plan.nodeStates.set(key, { ...state, status: 'failed', error: reason });
            clearedStale = true;
          }
        }
      }
      if (clearedStale) savePersistedPlan(projectId, plan);

      const isAlreadyRunning = Array.from(plan.nodeStates.values()).some((s) => s.status === 'in-progress');
      if (isAlreadyRunning) {
        res.status(409).json({ error: 'Provisioning is already running. Wait for it to finish before starting a targeted run.' });
        return;
      }

      // Separate handler-backed keys (firebase/*) from orchestrator-backed keys (github/*, eas/*).
      // Strip any "@env" suffix to look up the base handler key.
      const handlerBacked = effectiveNodeKeys.filter((k) => {
        const base = k.includes('@') ? k.split('@')[0]! : k;
        return globalStepHandlerRegistry.has(base);
      });
      const orchestratorBacked = effectiveNodeKeys.filter((k) => {
        const base = k.includes('@') ? k.split('@')[0]! : k;
        return !globalStepHandlerRegistry.has(base);
      });

      // Pre-flight GCP token check for any handler-backed GCP steps.
      // Try to obtain an actual token (not just check if a refresh token exists in vault)
      // to catch expired/revoked credentials before work starts.
      const gcpHandlerKeys = handlerBacked.filter((k) => {
        const base = k.includes('@') ? k.split('@')[0]! : k;
        return globalStepHandlerRegistry.get(base)?.requiredAuth === 'gcp';
      });
      if (gcpHandlerKeys.length > 0) {
        try {
          await gcpConnectionService.getAccessToken(projectId, 'pre-flight');
          console.log(`[plan/run/nodes] studio="${projectId}" | Pre-flight GCP token check passed.`);
        } catch {
          // Neither OAuth refresh nor SA key produced a valid token — prompt re-auth.
          const oauthResult = await gcpConnectionService.startProjectOAuthFlow(projectId);
          console.log(
            `[plan/run/nodes] studio="${projectId}" | Pre-flight failed — no valid GCP credentials. ` +
            `Returning needsReauth (session ${oauthResult.sessionId}).`,
          );
          res.json({ needsReauth: true, sessionId: oauthResult.sessionId, authUrl: oauthResult.authUrl, projectId });
          return;
        }
      }

      // Require GitHub token only when the requested nodes include GitHub steps.
      const githubToken = gitHubConnectionService.getStoredGitHubToken();
      if (orchestratorBacked.some((k) => k.startsWith('github:')) && !githubToken) {
        res.status(400).json({
          error: 'GitHub is not connected. Connect a GitHub PAT via the organization settings before running GitHub provisioning steps.',
        });
        return;
      }

      const vaultPassphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim() ?? '';

      // Pre-mark ALL requested step nodes as in-progress immediately so the
      // frontend reflects activity the moment this request returns.
      for (const nk of effectiveNodeKeys) {
        const baseKey = nk.includes('@') ? nk.split('@')[0]! : nk;
        const planNode = plan.nodes.find((n) => n.key === baseKey || n.key === nk);
        if (planNode?.type === 'step') {
          const existing = plan.nodeStates.get(nk);
          if (existing?.status !== 'completed' && existing?.status !== 'skipped') {
            plan.nodeStates.set(nk, { nodeKey: baseKey, status: 'in-progress', startedAt: Date.now() });
            wsHandler.broadcastStepProgress(
              projectId,
              baseKey,
              'step',
              'running',
              nk.includes('@') ? nk.split('@')[1] : undefined,
            );
          }
        }
      }
      savePersistedPlan(projectId, plan);
      res.json({ started: true, projectId, nodeKeys: effectiveNodeKeys });

      // ── Background execution ───────────────────────────────────────────────
      void (async () => {
        const currentPlan = loadPersistedPlan(projectId);
        if (!currentPlan) return;

        wsHandler.broadcastStepProgress(projectId, 'run', 'step', 'running');

        // Collect upstream artifacts from all currently-completed nodes so each
        // handler context has access to resources produced by earlier steps.
        const upstreamArtifacts: Record<string, string> = {};
        for (const state of currentPlan.nodeStates.values()) {
          if (state.status === 'completed' && state.resourcesProduced) {
            Object.assign(upstreamArtifacts, state.resourcesProduced);
          }
        }

        // ── Handler-direct execution for firebase/* steps ──────────────────
        for (const nk of handlerBacked) {
          const baseKey = nk.includes('@') ? nk.split('@')[0]! : nk;
          const environment = nk.includes('@') ? nk.split('@')[1] : undefined;
          const handler = globalStepHandlerRegistry.get(baseKey);
          if (!handler) continue;

          const stateKey = environment ? `${baseKey}@${environment}` : baseKey;

          // Per-step token cache: avoids multiple OAuth refresh round-trips
          // within a single handler call.  The access token is valid for 1h.
          const tokenCache = new Map<string, string>();

          const context = {
            projectId,
            upstreamArtifacts: { ...upstreamArtifacts },
            async getToken(providerId: string): Promise<string> {
              const cached = tokenCache.get(providerId);
              if (cached) return cached;
              if (providerId === 'gcp') {
                const token = await gcpConnectionService.getAccessToken(projectId, `run:${baseKey}`);
                tokenCache.set(providerId, token);
                return token;
              }
              throw new Error(`No token provider for "${providerId}" in step "${baseKey}".`);
            },
            hasToken: (providerId: string) =>
              providerId === 'gcp' ? gcpConnectionService.hasStoredUserOAuthRefreshToken(projectId) : false,
            vaultManager,
            passphrase: vaultPassphrase,
            projectManager,
          };

          console.log(
            `[plan/run/nodes] studio="${projectId}" | → Executing handler "${baseKey}"` +
            (environment ? ` env="${environment}"` : '') + '...',
          );

          try {
            const result = await handler.create(context);

            if (result.reconciled) {
              const resources = result.resourcesProduced ?? {};
              Object.assign(upstreamArtifacts, resources);
              currentPlan.nodeStates.set(stateKey, {
                nodeKey: baseKey,
                status: 'completed',
                environment,
                completedAt: Date.now(),
                resourcesProduced: resources,
              });
              wsHandler.broadcastStepProgress(projectId, baseKey, 'step', 'success', environment, resources);
              console.log(`[plan/run/nodes] studio="${projectId}" | ✓ "${baseKey}" completed.`);
            } else {
              // reconciled=false, suggestsReauth=true means the GCP token is invalid.
              // Since we are in an async background block we cannot return needsReauth
              // over HTTP — mark the step failed with a clear message so the UI can
              // detect it and show the re-auth button.
              const errMsg = result.suggestsReauth
                ? `Re-authentication required: ${result.message ?? 'GCP OAuth token invalid or expired.'}`
                : (result.message ?? 'Step failed without a specific error message.');
              currentPlan.nodeStates.set(stateKey, {
                nodeKey: baseKey,
                status: 'failed',
                environment,
                error: errMsg,
              });
              wsHandler.broadcastStepProgress(projectId, baseKey, 'step', 'failure', environment, undefined, errMsg);
              console.log(`[plan/run/nodes] studio="${projectId}" | ✗ "${baseKey}" failed: ${errMsg}`);
            }
          } catch (err) {
            const errMsg = (err as Error).message;
            currentPlan.nodeStates.set(stateKey, { nodeKey: baseKey, status: 'failed', environment, error: errMsg });
            wsHandler.broadcastStepProgress(projectId, baseKey, 'step', 'failure', environment, undefined, errMsg);
            console.error(`[plan/run/nodes] studio="${projectId}" | ✗ "${baseKey}" threw: ${errMsg}`);
          }

          savePersistedPlan(projectId, currentPlan);
        }

        // ── Orchestrator path for github/*, eas/* steps ────────────────────
        if (orchestratorBacked.length > 0 && githubToken) {
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

          const githubManifestConfig: GitHubManifestConfig = {
            provider: 'github',
            owner: githubOwner,
            repo_name: module.project.slug,
            branch_protection_rules: [
              { branch: 'main', require_reviews: true, dismiss_stale_reviews: true, require_status_checks: true },
              { branch: 'develop', require_reviews: false, dismiss_stale_reviews: false, require_status_checks: true },
            ],
            environments: currentPlan.environments as Array<'dev' | 'preview' | 'prod'>,
            workflow_templates: ['build', 'deploy'],
          };

          const manifest: ProviderManifest = {
            version: PLATFORM_CORE_VERSION,
            app_id: projectId,
            providers: [githubManifestConfig],
          };

          const registry = new ProviderRegistry();
          registry.register('github', new GitHubAdapter(new HttpGitHubApiClient(githubToken)));

          const orchestrator = new Orchestrator(registry, eventLog);
          const vaultRead = createVaultReader(vaultManager);
          const nodeKeysFilter = new Set(orchestratorBacked);

          try {
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
                status:
                  event.status === 'success' ? 'completed' :
                  event.status === 'failure' ? 'failed' :
                  event.status === 'waiting-on-user' ? 'waiting-on-user' :
                  event.status === 'resolving' ? 'resolving' :
                  event.status === 'skipped' ? 'skipped' :
                  event.status === 'blocked' ? 'blocked' : 'in-progress',
                environment: event.environment,
                error: event.error,
                resourcesProduced: event.resourcesProduced,
                completedAt: event.status === 'success' || event.status === 'skipped' ? Date.now() : undefined,
              });
              wsHandler.broadcastStepProgress(
                projectId, event.nodeKey, event.nodeType, event.status,
                event.environment, event.resourcesProduced, event.error, event.userPrompt,
              );
              savePersistedPlan(projectId, currentPlan);
            }
          } catch (err) {
            const errMsg = (err as Error).message;
            console.error(`[plan/run/nodes] studio="${projectId}" | Orchestrator error: ${errMsg}`);
            for (const nk of orchestratorBacked) {
              const s = currentPlan.nodeStates.get(nk);
              if (s?.status === 'in-progress') {
                currentPlan.nodeStates.set(nk, { nodeKey: nk, status: 'failed', error: errMsg });
                wsHandler.broadcastStepProgress(projectId, nk, 'step', 'failure', undefined, undefined, errMsg);
              }
            }
            savePersistedPlan(projectId, currentPlan);
          }
        }
      })();
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

      // Determine which nodes have registered StepHandlers (e.g. firebase:*)
      // and require GCP API calls for deletion (need a live OAuth token).
      const GCP_DELETE_STEPS = new Set([
        'firebase:bind-provisioner-iam',
        'firebase:create-provisioner-sa',
      ]);
      const handlerKeysToDelete = allKeysToReset.filter(
        (k) => globalStepHandlerRegistry.has(k),
      );
      const needsGcpApiCalls = handlerKeysToDelete.some((k) => GCP_DELETE_STEPS.has(k));

      // Gate: if GCP API calls are needed and we have no OAuth token, prompt re-auth first.
      if (needsGcpApiCalls && !gcpConnectionService.hasStoredUserOAuthRefreshToken(projectId)) {
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

      // Execute delete() on each registered handler in reverse provisioning order
      // (dependents were collected in dependency order so reversing is correct).
      const vaultPassphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim() ?? '';
      let revertWarnings: string[] = [];

      if (handlerKeysToDelete.length > 0) {
        // Delete from leaf to root (reverse order so dependents are torn down first)
        const deleteOrder = [...handlerKeysToDelete].reverse();
        console.log(`[studio-api] node/reset: deleting GCP resources for ${projectId}: ${deleteOrder.join(', ')}`);

        for (const stepKey of deleteOrder) {
          const handler = globalStepHandlerRegistry.get(stepKey);
          if (!handler) continue;

          const handlerContext = {
            projectId,
            upstreamArtifacts: {},
            getToken: async (providerId: string) => {
              if (providerId === 'gcp') return gcpConnectionService.getAccessToken(projectId, `reset:${stepKey}`);
              throw new Error(`No token provider for "${providerId}".`);
            },
            hasToken: (providerId: string) =>
              providerId === 'gcp' ? gcpConnectionService.hasStoredUserOAuthRefreshToken(projectId) : false,
            vaultManager,
            passphrase: vaultPassphrase,
            projectManager,
          };

          try {
            const result = await handler.delete(handlerContext);
            if (!result.reconciled && result.message) {
              // gcp_project and enable-firebase deletion are intentionally not automated.
              const INFORMATIONAL = new Set(['firebase:create-gcp-project', 'firebase:enable-firebase']);
              if (!INFORMATIONAL.has(stepKey)) {
                revertWarnings.push(`${stepKey}: ${result.message}`);
              }
            }
          } catch (err) {
            revertWarnings.push(`${stepKey}: ${(err as Error).message}`);
          }
        }

        if (revertWarnings.length > 0) {
          console.warn(`[studio-api] node/reset: partial revert for ${projectId}: ${revertWarnings.join('; ')}`);
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

      // Check StepHandlerRegistry first (Firebase and any other registered handlers)
      const stepHandler = globalStepHandlerRegistry.get(nodeKey);

      const registry = new ProviderRegistry();
      if (githubToken) {
        registry.register('github', new GitHubAdapter(new HttpGitHubApiClient(githubToken)));
      }

      if (!stepHandler && !registry.hasAdapter(node.provider)) {
        res.json({
          supported: false,
          message: `Provider "${node.provider}" has no revalidation hook in Studio yet.`,
          plan: StepResolver.enrichPlanSnapshot(plan),
        });
        return;
      }

      const adapter = stepHandler ? null : registry.getAdapter(node.provider);
      if (!stepHandler && (!adapter || !adapter.checkStep)) {
        res.json({
          supported: false,
          message: `Step checks are not implemented for provider "${node.provider}".`,
          plan: StepResolver.enrichPlanSnapshot(plan),
        });
        return;
      }

      const vaultRead = createVaultReader(vaultManager);

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

      const vaultPassphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim() ?? '';

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
          let stillValid = false;
          let resourcesProduced: Record<string, string> | undefined;

          if (stepHandler) {
            // Use StepHandlerRegistry for Firebase and other registered steps
            const handlerContext = {
              projectId,
              upstreamArtifacts: { ...upstream },
              getToken: async (providerId: string) => {
                if (providerId === 'gcp') return gcpConnectionService.getAccessToken(projectId, `revalidate:${nodeKey}`);
                throw new Error(`No token provider for "${providerId}".`);
              },
              hasToken: (providerId: string) => providerId === 'gcp' ? gcpConnectionService.hasStoredUserOAuthRefreshToken(projectId) : false,
              vaultManager,
              passphrase: vaultPassphrase,
              projectManager,
            };
            const handlerResult = await stepHandler.validate(handlerContext);
            stillValid = handlerResult.reconciled;
            resourcesProduced = handlerResult.resourcesProduced;
          } else if (adapter?.checkStep) {
            const result = await adapter.checkStep(nodeKey, configForProvider, context);
            stillValid = result.status === 'completed';
            resourcesProduced = result.resourcesProduced;
          }

          checked++;
          if (stillValid) {
            plan.nodeStates.set(stateKey, {
              nodeKey,
              status: 'completed',
              environment: item.environment,
              completedAt: Date.now(),
              resourcesProduced: resourcesProduced ?? existing?.resourcesProduced,
            });
            if (resourcesProduced) Object.assign(upstream, resourcesProduced);
            results.push({ environment: item.environment, stillValid: true });
          } else {
            plan.nodeStates.set(stateKey, { nodeKey, status: 'not-started', environment: item.environment });
            results.push({ environment: item.environment, stillValid: false });
          }
        } catch {
          checked++;
          plan.nodeStates.set(stateKey, { nodeKey, status: 'not-started', environment: item.environment });
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

      // GitHub is optional for sync — Firebase steps sync independently of GitHub.
      // Register the GitHub adapter only when a token is available so GitHub steps
      // can also be checked; if not available, GitHub steps are left as-is.
      const githubToken = gitHubConnectionService.getStoredGitHubToken();

      const registry = new ProviderRegistry();
      if (githubToken) {
        const org = projectManager.getOrganization();
        const orgGithubConfig = org.integrations.github?.config ?? {};
        const githubOwner =
          _module.project.githubOrg?.trim() ||
          orgGithubConfig['owner_default']?.trim() ||
          orgGithubConfig['username']?.trim() ||
          _module.project.slug;

        const githubManifestConfig: GitHubManifestConfig = {
          provider: 'github',
          owner: githubOwner,
          repo_name: _module.project.slug,
          branch_protection_rules: [
            { branch: 'main', require_reviews: true, dismiss_stale_reviews: true, require_status_checks: true },
            { branch: 'develop', require_reviews: false, dismiss_stale_reviews: false, require_status_checks: true },
          ],
          environments: plan.environments as Array<'dev' | 'preview' | 'prod'>,
          workflow_templates: ['build', 'deploy'],
        };
        registry.register('github', new GitHubAdapter(new HttpGitHubApiClient(githubToken)));
      }

      const vaultRead = createVaultReader(vaultManager);

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

            // Firebase steps with registered handlers always attempt sync regardless of
            // upstream gate status — sync's purpose is to discover real-world state,
            // not to enforce logical prerequisites like billing setup gates.
            const isHandlerBacked =
              node.provider === 'firebase' &&
              node.type === 'step' &&
              globalStepHandlerRegistry.has(item.nodeKey.includes('@') ? item.nodeKey.split('@')[0]! : item.nodeKey);

            if (!isHandlerBacked) {
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

            // configForProvider is provider-specific manifest config.
            const configForProvider = {} as ProviderConfig;

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
