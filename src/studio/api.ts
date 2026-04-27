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
import JSZip from 'jszip';
import { EventLog, OperationRecord } from '../orchestration/event-log.js';
import { WsHandler } from './ws-handler.js';
import { VaultManager } from '../vault.js';
import {
  ProjectManager,
  IntegrationProvider,
  ProjectInfo,
  IntegrationConfigRecord,
  MobilePlatform,
  normalizeExpoEnvironments,
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
import type { ProvisioningPlan, ProvisioningNode, NodeState, CompletionPortalLink } from '../provisioning/graph.types.js';
import type {
  ProviderType,
  GitHubManifestConfig,
  FirebaseManifestConfig,
  AppleManifestConfig,
  CloudflareManifestConfig,
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
import { EasAdapter } from '../providers/eas.js';
import {
  AppleAdapter,
  verifyAscApiCredentials,
  appleAuthKeysVaultPath,
  validateAppleKeyId,
  type AppleAuthKeyRegistry,
} from '../providers/apple.js';
import { CloudflareAdapter, HttpCloudflareApiClient } from '../providers/cloudflare.js';
import { OAuthAdapter, StudioOAuthApiClient } from '../providers/oauth.js';
import { resolveCloudflareDomainTarget } from '../core/cloudflare-domain-target.js';
import { ExpoGraphqlEasApiClient } from '../providers/expo-graphql-eas-client.js';
import { ProviderRegistry } from '../providers/registry.js';
import { Orchestrator } from '../orchestration/orchestrator.js';
import type { ModuleId } from '../provisioning/module-catalog.js';
import { getProvidersForModules, resolveModuleDependencies } from '../provisioning/module-catalog.js';
import { buildProvisioningGateResolver } from '../provisioning/gate-resolvers.js';
import { globalStepHandlerRegistry } from '../provisioning/step-handler-registry.js';
import { EAS_STEP_HANDLERS } from '../provisioning/eas-step-handlers.js';
import { GITHUB_STEP_HANDLERS } from '../provisioning/github-step-handlers.js';
import { FIREBASE_STEP_HANDLERS } from '../core/gcp/gcp-step-handlers.js';
import {
  createVaultReader,
  createVaultWriter,
  buildGitHubWorkflowTemplates,
  buildEasManifestConfig,
  planUsesEasProvider,
  parseGithubRepoUrl,
  collectCompletedUpstreamArtifacts,
} from './api-helpers.js';
import {
  applyProjectDomainToUpstreamArtifacts,
  buildInitialUpstreamSeed,
  projectPrimaryDomain,
  projectResourceSlug,
} from './project-identity.js';
import { buildPlannedOutputPreviewByNodeKey } from './planned-output-previews.js';
import { buildManualInstructionsByNodeKey } from './manual-step-instructions.js';
import { buildAuthIntegrationKitBundle } from './auth-integration-kit.js';
import { buildProjectEnvBundle } from './project-env-file.js';
import {
  findStepSecretDescriptor,
  getStepSecretDescriptors,
  readStepSecretStatuses,
  readStepSecretValue,
} from './step-vault-secrets.js';
import { globalPluginRegistry } from '../plugins/plugin-registry.js';
import {
  appendExpoManualDeleteIfRobotBlocked,
  type RevertManualAction,
} from './revert-manual-actions.js';
import {
  enableFirebaseIdentityToolkit,
  getFirebaseAuthStatus,
  addAuthorizedDomain,
} from '../handlers/firebase-auth-handler.js';
import {
  downloadFirebaseAndroidAppConfig,
  downloadFirebaseIosAppConfig,
} from '../core/gcp/gcp-api-client.js';
import {
  createOAuthClientHandler,
  listOAuthClients,
  validateRedirectUris,
} from '../handlers/oauth-client-handler.js';
import {
  handleAppleKeyUpload,
  configureAppleSignIn,
} from '../handlers/apple-signin-handler.js';
import {
  bridgeApnsKeyToFirebase,
  bridgePlayFingerprintToFirebase,
} from '../handlers/cross-provider-bridge-handler.js';
import { validateAppleP8Key } from '../validators/apple-key-validator.js';
import { validateTeamId, validateKeyId } from '../validators/firebase-input-validator.js';
import { getBillingSetupInstructions } from '../handlers/billing-gate-handler.js';
import { validatePrerequisites } from '../services/prerequisite-validator.js';
import type { RequiredModule } from '../services/prerequisite-validator.js';
import { CredentialStore } from '../services/credential-store.js';
import { CredentialService } from '../services/credential-service.js';
import type { CredentialType } from '../services/credential-service.js';
import { validateByType } from '../validators/credential-validators.js';
import { GuidedFlowService } from '../services/guided-flow-service.js';
import { AppleSigningHandler } from '../handlers/apple-signing-flow-handler.js';
import { GooglePlayHandler } from '../handlers/google-play-flow-handler.js';
import type { GuidedFlowType } from '../models/guided-flow.js';
import { GuidedFlowError } from '../models/guided-flow.js';
import { CredentialRetrievalService } from '../services/credential-retrieval-service.js';

// Register all step handlers at startup
globalStepHandlerRegistry.registerAll(FIREBASE_STEP_HANDLERS);
globalStepHandlerRegistry.registerAll(EAS_STEP_HANDLERS);
globalStepHandlerRegistry.registerAll(GITHUB_STEP_HANDLERS);

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

function isGitHubAuthFailure(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('github api /user failed (401)') ||
    (message.includes('github api /user failed') && message.includes('bad credentials'))
  );
}

function extractFirebaseApiKeyFromAndroidConfig(jsonText: string): string | null {
  try {
    const parsed = JSON.parse(jsonText) as {
      client?: Array<{ api_key?: Array<{ current_key?: string }> }>;
    };
    const clients = parsed.client ?? [];
    for (const client of clients) {
      const key = client.api_key?.find(
        (entry) => typeof entry.current_key === 'string' && entry.current_key.trim().length > 0,
      )?.current_key;
      if (key) return key.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function extractFirebaseApiKeyFromIosConfig(plistText: string): string | null {
  const match = plistText.match(/<key>\s*API_KEY\s*<\/key>\s*<string>\s*([^<]+)\s*<\/string>/);
  const key = match?.[1]?.trim();
  return key && key.length > 0 ? key : null;
}

/** Structured [studio-api] lines for operator visibility (avoid logging raw secrets). */
function logStudioApiAction(action: string, detail: Record<string, unknown>): void {
  console.log(`[studio-api] ${action}`, JSON.stringify(detail));
}

function summarizeProvisionPlanForLog(plan: ProvisioningPlan): Record<string, unknown> {
  const stateByStatus: Record<string, number> = {};
  const waitingOnUser: string[] = [];
  const failed: Array<{ key: string; error?: string }> = [];
  for (const [k, st] of plan.nodeStates) {
    const s = st.status ?? 'unknown';
    stateByStatus[s] = (stateByStatus[s] ?? 0) + 1;
    if (s === 'waiting-on-user') waitingOnUser.push(k);
    if (s === 'failed') {
      const err = st.error?.slice(0, 400);
      failed.push({ key: k, ...(err ? { error: err } : {}) });
    }
  }
  return {
    projectId: plan.projectId,
    nodeCount: plan.nodes.length,
    environments: plan.environments,
    selectedModules: plan.selectedModules ?? [],
    persistedStateKeys: plan.nodeStates.size,
    stateByStatus,
    waitingOnUser,
    failed,
  };
}

/** Log resource keys and non-sensitive values; redact likely tokens. */
function summarizeResourcesProducedForLog(resources: Record<string, string> | undefined): Record<string, string> {
  if (!resources) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(resources)) {
    const lower = k.toLowerCase();
    const looksSecret =
      lower.includes('token') ||
      lower.includes('secret') ||
      lower.includes('password') ||
      lower.includes('pat') ||
      lower === 'github_token' ||
      lower === 'expo_token';
    if (looksSecret) {
      out[k] = v?.trim() ? `[redacted, ${v.length} chars]` : '[empty]';
    } else {
      const s = String(v);
      out[k] = s.length > 200 ? `${s.slice(0, 200)}…` : s;
    }
  }
  return out;
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
  const credentialStore = new CredentialStore(
    storeDir,
    process.env['STUDIO_VAULT_PASSPHRASE'] ?? 'studio-default-passphrase',
  );
  const credentialService = new CredentialService(
    storeDir,
    process.env['STUDIO_VAULT_PASSPHRASE'] ?? 'studio-default-passphrase',
  );
  const guidedFlowService = new GuidedFlowService(
    storeDir,
    process.env['STUDIO_VAULT_PASSPHRASE'] ?? 'studio-default-passphrase',
  );
  const appleSigningHandler = new AppleSigningHandler(guidedFlowService, credentialService);
  const googlePlayHandler = new GooglePlayHandler(guidedFlowService, credentialService);
  const credentialRetrievalService = new CredentialRetrievalService(
    credentialService,
    guidedFlowService,
    projectManager,
  );

  const validProjectIntegrationProviders = new Set<IntegrationProvider>(
    Object.keys(PROVIDER_SECRET_SCHEMAS) as IntegrationProvider[],
  );
  const validOrganizationIntegrationProviders = new Set<IntegrationProvider>([
    'github',
    'eas',
    'apple',
    'cloudflare',
    'google-play',
  ]);

  const ORGANIZATION_CREDENTIAL_SCOPE_ID = '__organization__';

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
        const prev = plan.nodeStates.get(`${node.key}@${env}`);
        plan.nodeStates.set(`${node.key}@${env}`, {
          nodeKey: node.key,
          status: 'not-started',
          environment: env,
          ...(prev?.userInputs ? { userInputs: prev.userInputs } : {}),
        });
      }
    } else {
      const prev = plan.nodeStates.get(node.key);
      plan.nodeStates.set(node.key, {
        nodeKey: node.key,
        status: 'not-started',
        ...(prev?.userInputs ? { userInputs: prev.userInputs } : {}),
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
    const restored = StepResolver.restorePlan(snapshot as {
      projectId: string;
      environments: string[];
      selectedModules?: string[];
      nodes: ProvisioningPlan['nodes'];
      nodeStates: Record<string, NodeState>;
    });
    pruneConnectedCloudflareTokenGate(restored, projectId);
    return restored;
  };

  const savePersistedPlan = (projectId: string, plan: ProvisioningPlan): void => {
    pruneConnectedCloudflareTokenGate(plan, projectId);
    projectManager.savePlan(projectId, StepResolver.snapshotPlan(plan));
  };

  function pruneConnectedCloudflareTokenGate(plan: ProvisioningPlan, projectId: string): void {
    const hasConnectedCloudflareToken = !!getCloudflareTokenForProject(projectId);
    if (!hasConnectedCloudflareToken) return;

    const gateKey = 'user:provide-cloudflare-token';
    if (!plan.nodes.some((node) => node.key === gateKey)) return;

    plan.nodes = plan.nodes
      .filter((node) => node.key !== gateKey)
      .map((node) => ({
        ...node,
        dependencies: node.dependencies.filter((dep) => dep.nodeKey !== gateKey),
      }));
    plan.nodeStates.delete(gateKey);
  }

  function enrichPlanForResponse(plan: ProvisioningPlan) {
    const mod = projectManager.getProject(plan.projectId);
    const org = projectManager.getOrganization();
    const orgGh = (org.integrations.github?.config ?? {}) as Record<string, string>;
    const projectSlug = projectResourceSlug(mod.project) || plan.projectId;
    const projectName = mod.project.name?.trim() || projectSlug;
    const projectBundleId = mod.project.bundleId?.trim() || '';
    const projectDomain = projectPrimaryDomain(mod.project);
    const expoAccount =
      mod.project.easAccount?.trim() ||
      org.integrations.eas?.config?.['expoAccountSlug']?.trim() ||
      easConnectionService.getStoredExpoUsername() ||
      easConnectionService.getStoredExpoAccountNames()[0] ||
      '';
    const expoGithubLink =
      expoAccount && projectSlug
        ? `https://expo.dev/accounts/${expoAccount}/projects/${projectSlug}/github`
        : '';

    /** Resolve project tokens in inputField defaultValues. */
    function resolveInputFieldDefault(value: string): string {
      return value
        .replace(/\{slug\}/g, projectSlug)
        .replace(/\{name\}/g, projectName)
        .replace(/\{bundleId\}/g, projectBundleId)
        .replace(/\{domain\}/g, projectDomain);
    }

    // Collect every resource produced across this plan's node states so we
    // can resolve {upstream.<key>} placeholders in plugin-supplied portal
    // hrefTemplates BEFORE shipping nodes to the UI. The SetupWizard reads
    // `currentNode.completionPortalLinks` directly and filters out anything
    // without a static `href`, so unresolved hrefTemplate links would be
    // silently dropped on the client side.
    const upstreamResources: Record<string, string> = {};
    for (const state of plan.nodeStates.values()) {
      if (!state.resourcesProduced) continue;
      for (const [key, value] of Object.entries(state.resourcesProduced)) {
        if (typeof value === 'string' && value && !upstreamResources[key]) {
          upstreamResources[key] = value;
        }
      }
    }

    function resolveServerHrefTemplate(template: string): string | null {
      const required = new Set<string>();
      const re = /\{upstream\.([a-z0-9_]+)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(template)) !== null) required.add(m[1]!);
      for (const key of required) {
        if (!upstreamResources[key]) return null;
      }
      return template.replace(
        /\{upstream\.([a-z0-9_]+)\}/g,
        (_, k: string) => upstreamResources[k] ?? '',
      );
    }

    function pluginPortalLinksForNode(nodeKey: string): CompletionPortalLink[] {
      const raw = globalPluginRegistry.getCompletionPortalLinks(nodeKey);
      if (!raw || raw.length === 0) return [];
      const resolved: CompletionPortalLink[] = [];
      for (const link of raw) {
        if (link.href) {
          resolved.push({ label: link.label, href: link.href, hrefTemplate: link.hrefTemplate });
          continue;
        }
        if (link.hrefTemplate) {
          const href = resolveServerHrefTemplate(link.hrefTemplate);
          if (!href) continue; // upstream not yet known — drop until it is
          resolved.push({ label: link.label, href, hrefTemplate: link.hrefTemplate });
        }
      }
      return resolved;
    }

    function mergePortalLinks(
      base: CompletionPortalLink[] | undefined,
      extra: CompletionPortalLink[],
    ): CompletionPortalLink[] {
      const seen = new Set<string>();
      const out: CompletionPortalLink[] = [];
      for (const list of [base ?? [], extra]) {
        for (const link of list) {
          const key = `${link.label}::${link.href ?? link.hrefTemplate ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(link);
        }
      }
      return out;
    }

    const hideCloudflareTokenGate = !!getOrganizationCloudflareToken();
    const hiddenNodeKeys = new Set<string>(
      hideCloudflareTokenGate ? ['user:provide-cloudflare-token'] : [],
    );
    const responsePlanNodes = plan.nodes
      .filter((node) => !hiddenNodeKeys.has(node.key))
      .map((node) => ({
        ...node,
        dependencies: node.dependencies.filter((dep) => !hiddenNodeKeys.has(dep.nodeKey)),
      }));
    const responseNodeStates = new Map(
      Array.from(plan.nodeStates.entries()).filter(([stateKey]) => !hiddenNodeKeys.has(stateKey)),
    );
    const responsePlan: ProvisioningPlan = {
      ...plan,
      nodes: responsePlanNodes,
      nodeStates: responseNodeStates,
    };

    const nodes = responsePlan.nodes.map((node) => {
      const pluginLinks = pluginPortalLinksForNode(node.key);
      if (node.type === 'user-action' && node.key === 'user:install-expo-github-app') {
        return {
          ...node,
          helpUrl: expoGithubLink || node.helpUrl,
          completionPortalLinks: mergePortalLinks(
            [
              ...(expoGithubLink
                ? [{ label: 'Open Expo project GitHub settings', href: expoGithubLink }]
                : []),
              ...(node.completionPortalLinks ?? []),
            ],
            pluginLinks,
          ),
        };
      }
      // Resolve project tokens in inputFields defaultValues
      let next = node;
      if (node.type === 'step' && node.inputFields?.length) {
        next = {
          ...node,
          inputFields: node.inputFields.map((field) => ({
            ...field,
            defaultValue: field.defaultValue ? resolveInputFieldDefault(field.defaultValue) : field.defaultValue,
            placeholder: field.placeholder ? resolveInputFieldDefault(field.placeholder) : field.placeholder,
          })),
        };
      }
      if (pluginLinks.length === 0) return next;
      return {
        ...next,
        completionPortalLinks: mergePortalLinks(next.completionPortalLinks, pluginLinks),
      };
    });
    const enriched = StepResolver.enrichPlanSnapshot({ ...responsePlan, nodes });
    const allNodeKeys = enriched.nodes
      .map((n) => n.key)
      .concat(
        enriched.nodes
          .filter((n) => n.type === 'step' && n.environmentScope === 'per-environment')
          .flatMap((n) => responsePlan.environments.map((env) => `${n.key}@${env}`)),
      );
    const stepKeys = enriched.nodes.map((n) => n.key);

    return {
      ...enriched,
      plannedOutputPreviewByNodeKey: buildPlannedOutputPreviewByNodeKey(responsePlan, mod, orgGh),
      manualInstructionsByNodeKey: buildManualInstructionsByNodeKey(responsePlan, mod),
      stepCapabilities: globalPluginRegistry.getAllStepCapabilities(stepKeys),
      stepActions: globalPluginRegistry.getAllStepActions(stepKeys),
      pluginDisplayMeta: globalPluginRegistry.getAllPluginDisplayMeta(),
      providerDisplayMeta: globalPluginRegistry.getAllProviderDisplayMeta(),
      resourceDisplayByKey: globalPluginRegistry.getAllResourceDisplay(),
      portalLinksByNodeKey: globalPluginRegistry.getAllCompletionPortalLinks(),
      journeyPhaseTitles: globalPluginRegistry.getJourneyPhaseTitles(),
    };
  }

  async function checkExpoGitHubInstallForContext(context: StepContext): Promise<{
    linked: boolean;
    githubOwner?: string;
    githubRepo?: string;
  }> {
    const expoToken = easConnectionService.getStoredExpoToken();
    if (!expoToken?.trim()) return { linked: false };

    const easProjectId = context.upstreamResources['eas_project_id']?.trim();
    const repoUrl = context.upstreamResources['github_repo_url']?.trim();
    if (!easProjectId || !repoUrl) return { linked: false };

    let owner: string;
    let repo: string;
    try {
      const parsed = parseGithubRepoUrl(repoUrl);
      owner = parsed.owner;
      repo = parsed.repo;
    } catch {
      return { linked: false };
    }

    const mod = projectManager.getProject(context.projectId);
    const org = projectManager.getOrganization();
    const easOrg =
      mod.project.easAccount?.trim() ||
      (org.integrations.eas?.config?.['expoAccountSlug'] as string | undefined)?.trim() ||
      undefined;

    const expoClient = new ExpoGraphqlEasApiClient(expoToken);
    const linked = await expoClient.isGitHubRepositoryLinkedToApp({
      expoAppId: easProjectId,
      organization: easOrg,
      githubOwner: owner,
      githubRepoName: repo,
    });
    return { linked, githubOwner: owner, githubRepo: repo };
  }

  function getOrganizationCloudflareToken(): string | undefined {
    return (
      credentialService.retrieveCredential(ORGANIZATION_CREDENTIAL_SCOPE_ID, 'cloudflare_token')?.trim() ||
      undefined
    );
  }

  function getCloudflareTokenForProject(_projectId: string): string | undefined {
    const projectScoped =
      credentialService.retrieveCredential(_projectId, 'cloudflare_token')?.trim() || undefined;
    return projectScoped || getOrganizationCloudflareToken();
  }

  function buildCloudflareAdapter(projectId: string): CloudflareAdapter {
    const token = getCloudflareTokenForProject(projectId);
    if (!token) {
      throw new Error(
        `Cloudflare API token is missing for "${projectId}". Complete "Connect Cloudflare API Token" before running Cloudflare steps.`,
      );
    }
    return new CloudflareAdapter(new HttpCloudflareApiClient(token));
  }

  async function checkCloudflareZoneOwnershipForContext(context: StepContext): Promise<{
    owned: boolean;
    zoneId?: string;
    accountId?: string;
    zoneStatus?: string;
    zoneDomain?: string;
    appDomain?: string;
    nameservers?: string[];
  }> {
    const token = getCloudflareTokenForProject(context.projectId);
    if (!token) return { owned: false };

    const cloudflareConfig = buildCloudflareManifestConfig(context.projectId);
    const zoneDomain = cloudflareConfig.zone_domain ?? cloudflareConfig.domain;
    const api = new HttpCloudflareApiClient(token);
    const zone = await api.getZone(zoneDomain);
    if (!zone) {
      return {
        owned: false,
        zoneDomain,
        appDomain: cloudflareConfig.domain,
      };
    }
    return {
      owned: true,
      zoneId: zone.id,
      accountId: zone.accountId,
      zoneStatus: zone.status,
      zoneDomain,
      appDomain: cloudflareConfig.domain,
      nameservers: zone.nameServers,
    };
  }

  function buildFirebaseManifestConfig(projectId: string): FirebaseManifestConfig {
    const module = projectManager.getProject(projectId);
    return {
      provider: 'firebase',
      project_name: projectResourceSlug(module.project) || projectId,
      billing_account_id: '[connected via OAuth]',
      services: ['auth', 'firestore', 'storage', 'fcm'],
      environment: 'production',
    };
  }

  function buildAppleManifestConfig(projectId: string, plan?: ProvisioningPlan): AppleManifestConfig {
    const module = projectManager.getProject(projectId);
    const organization = projectManager.getOrganization();
    const bundleId = module.project.bundleId?.trim();
    if (!bundleId) {
      throw new Error(
        `Apple provisioning requires a project bundle ID. Set bundleId for "${projectId}" before running Apple steps.`,
      );
    }
    const integrationTeamId = module.integrations.apple?.config?.['team_id']?.trim();
    const orgIntegrationTeamId = organization.integrations.apple?.config?.['team_id']?.trim();
    const storedTeamId = credentialService.retrieveCredential(projectId, 'apple_team_id')?.trim();
    const planTeamId =
      plan?.nodeStates.get('user:enroll-apple-developer')?.resourcesProduced?.['apple_team_id']?.trim();
    const teamId = integrationTeamId || orgIntegrationTeamId || storedTeamId || planTeamId;
    if (!teamId) {
      throw new Error(
        `Apple provisioning requires apple_team_id. Provide it through credentials or Apple integration settings for "${projectId}".`,
      );
    }
    return {
      provider: 'apple',
      bundle_id: bundleId,
      team_id: teamId,
      app_name: module.project.name?.trim() || projectResourceSlug(module.project) || projectId,
      enable_apns: true,
      certificate_type: 'distribution',
    };
  }

  function buildCloudflareManifestConfig(projectId: string): CloudflareManifestConfig {
    const module = projectManager.getProject(projectId);
    const rawDomain = projectPrimaryDomain(module.project);
    if (!rawDomain) {
      throw new Error(
        `Cloudflare and deep-link provisioning require a project domain. Set a domain for "${projectId}" first.`,
      );
    }
    const target = resolveCloudflareDomainTarget(rawDomain);
    return {
      provider: 'cloudflare',
      domain: target.appDomain,
      zone_domain: target.zoneDomain,
      domain_mode: target.mode,
      dns_record_name: target.dnsRecordName,
      deep_link_routes: [
        '/',
        '/auth/*',
        '/__/auth/handler',
        '/.well-known/apple-app-site-association',
        '/.well-known/assetlinks.json',
      ],
      ssl_mode: 'strict',
    };
  }

  function buildOauthManifestConfig(projectId: string, plan: ProvisioningPlan): ProviderConfig {
    const hasGoogleOauthSteps = plan.nodes.some(
      (n) =>
        n.provider === 'oauth' &&
        (n.key === 'oauth:enable-google-sign-in' ||
          n.key === 'oauth:register-oauth-client-web' ||
          n.key === 'oauth:register-oauth-client-ios' ||
          n.key === 'oauth:register-oauth-client-android' ||
          n.key === 'oauth:configure-redirect-uris'),
    );
    return {
      provider: 'oauth',
      oauth_provider: hasGoogleOauthSteps ? 'google' : 'apple',
      redirect_uri: '',
      scopes: [],
      firebase_project_id: projectId,
    };
  }

  function planUsesFirebaseProvider(plan: ProvisioningPlan): boolean {
    return plan.nodes.some((n) => n.provider === 'firebase');
  }

  function planUsesGithubProvider(plan: ProvisioningPlan): boolean {
    return plan.nodes.some((n) => n.provider === 'github');
  }

  function planUsesOauthProvider(plan: ProvisioningPlan): boolean {
    return plan.nodes.some((n) => n.provider === 'oauth');
  }

  function planUsesAppleProvider(plan: ProvisioningPlan): boolean {
    return plan.nodes.some((n) => n.provider === 'apple');
  }

  function planUsesCloudflareProvider(plan: ProvisioningPlan): boolean {
    return plan.nodes.some((n) => n.provider === 'cloudflare');
  }

  function getRunsForProject(projectId: string): OperationRecord[] {
    return eventLog.listOperationsByAppId(projectId, 200);
  }

  // -------------------------------------------------------------------------
  // GET /api/organization — organization-level integration defaults
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // GET /api/plugin-catalog — full list of registered plugins, for the module picker UI
  // -------------------------------------------------------------------------
  router.get('/plugin-catalog', (_req: Request, res: Response) => {
    try {
      res.json(globalPluginRegistry.getPluginCatalog());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

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
      const error = err as Error;
      if (isGitHubAuthFailure(error)) {
        const disconnected = gitHubConnectionService.disconnect();
        console.warn(
          '[studio-github] Stored token rejected by GitHub (401). Cleared token and reset integration to pending.',
        );
        res.status(401).json({
          error:
            'Stored GitHub token is invalid or expired. Reconnect GitHub in Integrations, then sync again.',
          needsReconnect: true,
          provider: 'github',
          connected: disconnected.connected,
        });
        return;
      }
      console.error('[studio-github] Stored GitHub token validation failed:', error.message);
      res.status(502).json({
        error: `Failed to validate stored GitHub token: ${error.message}`,
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
  // GET /api/integrations/cloudflare/connection — validate stored Cloudflare token
  // -------------------------------------------------------------------------
  router.get('/integrations/cloudflare/connection', async (_req: Request, res: Response) => {
    try {
      const token = getOrganizationCloudflareToken();
      if (!token) {
        res.json({ connected: false });
        return;
      }
      const client = new HttpCloudflareApiClient(token);
      const verified = await client.verifyToken();
      res.json({
        connected: verified.status.toLowerCase() === 'active',
        details: { status: verified.status },
      });
    } catch (err) {
      res.status(502).json({ error: `Failed to validate Cloudflare token: ${(err as Error).message}` });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/organization/integrations/cloudflare/connect — store token + verify
  // -------------------------------------------------------------------------
  router.post('/organization/integrations/cloudflare/connect', async (req: Request, res: Response) => {
    try {
      const token = (req.body?.token as string | undefined)?.trim();
      if (!token) {
        res.status(400).json({ error: 'Cloudflare API token is required.' });
        return;
      }
      const client = new HttpCloudflareApiClient(token);
      const verified = await client.verifyToken();
      if (verified.status.toLowerCase() !== 'active') {
        res.status(400).json({ error: `Cloudflare token is not active (status=${verified.status}).` });
        return;
      }
      const organization = projectManager.getOrganization();
      if (!organization.integrations.cloudflare) {
        projectManager.addOrganizationIntegration('cloudflare');
      }
      credentialService.storeCredential({
        project_id: ORGANIZATION_CREDENTIAL_SCOPE_ID,
        credential_type: 'cloudflare_token',
        value: token,
        metadata: { scope: 'organization' },
      });
      const updated = projectManager.updateOrganizationIntegration('cloudflare', {
        status: 'configured',
        notes: 'Cloudflare API token configured at organization scope.',
        config: { token_source: 'organization_vault' },
        replaceConfig: true,
      });
      res.json({
        integration: updated.integrations.cloudflare,
        tokenStored: true,
      });
    } catch (err) {
      res.status(400).json({ error: `Failed to connect Cloudflare: ${(err as Error).message}` });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/organization/integrations/cloudflare/connection — remove token
  // -------------------------------------------------------------------------
  router.delete('/organization/integrations/cloudflare/connection', (_req: Request, res: Response) => {
    try {
      const summary = credentialService.getCredentialSummary(
        ORGANIZATION_CREDENTIAL_SCOPE_ID,
        'cloudflare_token',
      );
      if (summary) {
        credentialService.deleteCredential(summary.id);
      }
      const organization = projectManager.getOrganization();
      if (!organization.integrations.cloudflare) {
        projectManager.addOrganizationIntegration('cloudflare');
      }
      const updated = projectManager.updateOrganizationIntegration('cloudflare', {
        status: 'pending',
        notes: '',
        config: {},
        replaceConfig: true,
      });
      res.json({
        removed: !!summary,
        integration: updated.integrations.cloudflare,
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to disconnect Cloudflare: ${(err as Error).message}` });
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
      logStudioApiAction('integrations/firebase/connection', {
        projectId,
        connected: result.connected,
        firebaseIntegrationStatus: result.integration?.status ?? null,
        gcpProjectId: result.details?.projectId ?? null,
        serviceAccountEmail: result.details?.serviceAccountEmail ?? null,
        hasUserOAuthRefreshToken: gcpConnectionService.hasStoredUserOAuthRefreshToken(projectId),
      });
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
  // POST /api/projects/:projectId/integrations/firebase/auth/enable
  // Body: { gcp_project_id: string }
  // Enables Firebase Identity Toolkit and streams progress via WebSocket.
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/integrations/firebase/auth/enable',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const gcpProjectId = req.body?.gcp_project_id as string | undefined;
        if (!gcpProjectId) {
          res.status(400).json({ error: 'gcp_project_id is required.' });
          return;
        }
        const accessToken = await gcpConnectionService.getAccessToken(projectId).catch(() => null);
        if (!accessToken) {
          res.status(401).json({ error: 'No valid GCP access token. Connect with Google first.' });
          return;
        }
        const runId = `firebase-auth-enable-${projectId}-${Date.now()}`;
        const result = await enableFirebaseIdentityToolkit(
          projectId,
          gcpProjectId,
          accessToken,
          credentialStore,
          (substep, status) => {
            wsHandler.broadcast(runId, {
              type: 'progress',
              runId,
              timestamp: new Date().toISOString(),
              data: { substep, status },
            });
          },
        );
        res.status(200).json({ ...result, run_id: runId });
      } catch (err) {
        const message = (err as Error).message;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
          return;
        }
        res.status(502).json({ error: `Failed to enable Identity Toolkit: ${message}` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId/integrations/firebase/auth/status
  // -------------------------------------------------------------------------
  router.get(
    '/projects/:projectId/integrations/firebase/auth/status',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const gcpProjectId = req.query['gcp_project_id'] as string | undefined;
        if (!gcpProjectId) {
          res.status(400).json({ error: 'gcp_project_id query param is required.' });
          return;
        }
        const accessToken = await gcpConnectionService.getAccessToken(projectId).catch(() => null);
        if (!accessToken) {
          res.status(401).json({ error: 'No valid GCP access token.' });
          return;
        }
        const status = await getFirebaseAuthStatus(gcpProjectId, accessToken);
        res.json(status);
      } catch (err) {
        res.status(502).json({ error: (err as Error).message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/integrations/firebase/auth/domains
  // Body: { gcp_project_id: string, domain: string }
  // Adds a domain to Firebase Auth authorized domains list.
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/integrations/firebase/auth/domains',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const gcpProjectId = req.body?.gcp_project_id as string | undefined;
        const domain = req.body?.domain as string | undefined;
        if (!gcpProjectId || !domain) {
          res.status(400).json({ error: 'gcp_project_id and domain are required.' });
          return;
        }
        const accessToken = await gcpConnectionService.getAccessToken(projectId).catch(() => null);
        if (!accessToken) {
          res.status(401).json({ error: 'No valid GCP access token.' });
          return;
        }
        await addAuthorizedDomain(gcpProjectId, domain, accessToken);
        res.json({ success: true, domain });
      } catch (err) {
        res.status(502).json({ error: (err as Error).message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId/integrations/firebase/billing-setup
  // Query: { gcp_project_id }
  // Returns billing setup instructions; 204 if billing is already enabled.
  // -------------------------------------------------------------------------
  router.get(
    '/projects/:projectId/integrations/firebase/billing-setup',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const gcpProjectId = req.query['gcp_project_id'] as string | undefined;
        if (!gcpProjectId) {
          res.status(400).json({ error: 'gcp_project_id query param is required.' });
          return;
        }
        const accessToken = await gcpConnectionService.getAccessToken(projectId).catch(() => null);
        if (!accessToken) {
          res.status(401).json({ error: 'No valid GCP access token.' });
          return;
        }
        const result = await getBillingSetupInstructions(gcpProjectId, accessToken);
        if (result.already_enabled) {
          res.status(204).end();
          return;
        }
        res.json(result);
      } catch (err) {
        res.status(502).json({ error: (err as Error).message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId/integrations/prerequisites
  // Query: { modules } (comma-separated list of RequiredModule values)
  // Returns 200 if all prerequisites met, 409 with instructions if not.
  // -------------------------------------------------------------------------
  router.get(
    '/projects/:projectId/integrations/prerequisites',
    (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const modulesParam = req.query['modules'] as string | undefined;
        if (!modulesParam) {
          res.status(400).json({ error: 'modules query param is required.' });
          return;
        }

        const requestedModules = modulesParam.split(',').map((m) => m.trim()) as RequiredModule[];

        const project = projectManager.getProject(projectId);
        const integrations = project.integrations;

        const getModuleStatus = (_pid: string, module: RequiredModule): boolean => {
          switch (module) {
            case 'firebase-core':
              return integrations['firebase']?.status === 'configured';
            case 'github-repo':
              return integrations['github']?.status === 'configured';
            case 'eas-builds':
              return integrations['eas']?.status === 'configured';
            case 'apple-signing':
              return integrations['apple']?.status === 'configured';
            case 'google-play-publishing':
              return integrations['google-play']?.status === 'configured';
            case 'cloudflare-domain':
              return integrations['cloudflare']?.status === 'configured';
            case 'firebase-auth':
            case 'oauth-social': {
              const firebaseConfig = credentialStore.getFirebaseAuthConfig(projectId);
              const toolkitEnabled = firebaseConfig?.identity_toolkit_enabled ?? false;
              if (module === 'firebase-auth') return toolkitEnabled;
              const appleSignInConfigured =
                credentialStore.getProviderCredentialByType(projectId, 'apple_sign_in') !== null;
              return toolkitEnabled && appleSignInConfigured;
            }
            default:
              return false;
          }
        };

        const result = validatePrerequisites(projectId, requestedModules, getModuleStatus);
        if (result.valid) {
          res.json({ valid: true, message: 'All prerequisites satisfied.' });
        } else {
          res.status(409).json(result);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
          return;
        }
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/integrations/firebase/oauth/create-client
  // Body: { gcp_project_id, provider, client_id, client_secret, redirect_uris }
  // Creates an OAuth client config in Firebase Auth.
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/integrations/firebase/oauth/create-client',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const {
          gcp_project_id,
          provider,
          client_id,
          client_secret,
          redirect_uris,
        } = req.body as {
          gcp_project_id?: string;
          provider?: string;
          client_id?: string;
          client_secret?: string;
          redirect_uris?: string[];
        };

        if (!gcp_project_id || !provider || !client_id || !client_secret || !redirect_uris) {
          res.status(400).json({
            error: 'gcp_project_id, provider, client_id, client_secret, and redirect_uris are required.',
          });
          return;
        }
        if (provider !== 'google' && provider !== 'apple') {
          res.status(400).json({ error: 'provider must be "google" or "apple".' });
          return;
        }
        if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
          res.status(400).json({ error: 'redirect_uris must be a non-empty array.' });
          return;
        }

        validateRedirectUris(redirect_uris);

        const accessToken = await gcpConnectionService.getAccessToken(projectId).catch(() => null);
        if (!accessToken) {
          res.status(401).json({ error: 'No valid GCP access token.' });
          return;
        }

        const firebaseConfig = credentialStore.upsertFirebaseAuthConfig({ project_id: projectId });
        const record = await createOAuthClientHandler(
          {
            firebase_config_id: firebaseConfig.id,
            provider: provider as 'google' | 'apple',
            client_id,
            client_secret,
            redirect_uris,
            gcp_project_id,
            access_token: accessToken,
          },
          credentialStore,
        );
        res.status(201).json(record);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('must be') || message.includes('must not') || message.includes('Invalid')) {
          res.status(400).json({ error: message });
          return;
        }
        res.status(502).json({ error: `Failed to create OAuth client: ${message}` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/integrations/firebase/apple/upload-key
  // Body: multipart or JSON with { p8_base64, key_id, team_id, key_purpose }
  // Validates and stores an Apple .p8 key encrypted in CredentialStore.
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/integrations/firebase/apple/upload-key',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const { p8_base64, key_id, team_id, key_purpose } = req.body as {
          p8_base64?: string;
          key_id?: string;
          team_id?: string;
          key_purpose?: string;
        };

        if (!p8_base64 || !key_id || !team_id) {
          res.status(400).json({ error: 'p8_base64, key_id, and team_id are required.' });
          return;
        }

        let fileBuffer: Buffer;
        try {
          fileBuffer = Buffer.from(p8_base64, 'base64');
        } catch {
          res.status(400).json({ error: 'p8_base64 must be a valid base64-encoded .p8 file.' });
          return;
        }

        const purpose = (key_purpose === 'sign_in' ? 'sign_in' : 'apns') as 'apns' | 'sign_in';
        const result = await handleAppleKeyUpload(
          { project_id: projectId, p8_file_buffer: fileBuffer, key_id, team_id, key_purpose: purpose },
          credentialStore,
        );
        const vaultPassphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
        if (vaultPassphrase) {
          if (purpose === 'sign_in') {
            vaultManager.setCredential(vaultPassphrase, 'firebase', `${projectId}/apple_sign_in_key_id`, key_id);
            vaultManager.setCredential(vaultPassphrase, 'firebase', `${projectId}/apple_team_id`, team_id);
            vaultManager.setCredential(
              vaultPassphrase,
              'firebase',
              `${projectId}/apple_sign_in_p8`,
              fileBuffer.toString('utf8'),
            );
          } else {
            vaultManager.setCredential(vaultPassphrase, 'firebase', `${projectId}/apns_key_id`, key_id);
            vaultManager.setCredential(vaultPassphrase, 'firebase', `${projectId}/apple_team_id`, team_id);
            vaultManager.setCredential(
              vaultPassphrase,
              'firebase',
              `${projectId}/apns_key_p8`,
              fileBuffer.toString('utf8'),
            );
          }
        }
        res.status(201).json(result);
      } catch (err) {
        const message = (err as Error).message;
        if (
          message.includes('Invalid Apple') ||
          message.includes('already been uploaded') ||
          message.includes('Invalid Apple Team ID') ||
          message.includes('Invalid Apple Key ID')
        ) {
          res.status(400).json({ error: message });
          return;
        }
        res.status(502).json({ error: `Failed to upload Apple key: ${message}` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId/apple/auth-keys/:keyId/p8
  // Streams the previously-uploaded Apple Auth Key PEM back to the user as
  // an `AuthKey_<KEYID>.p8` download so they can re-upload it to a portal
  // (e.g. Firebase Cloud Messaging) that needs the original .p8 bytes.
  //
  // The PEM is read from the unified Apple Auth Key registry vaulted at
  // `<projectId>/apple/auth-keys`, with a fallback to the legacy single-purpose
  // paths used by the Studio REST upload endpoint above so projects that only
  // ever uploaded through the legacy form still get a working download.
  //
  // No JSON wrapping — the response body is the raw PEM and the browser
  // saves it under the exact filename Apple uses (Firebase derives the Key
  // ID from the filename).
  // -------------------------------------------------------------------------
  router.get(
    '/projects/:projectId/apple/auth-keys/:keyId/p8',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const keyId = req.params['keyId']?.toUpperCase() ?? '';
        const validationError = validateAppleKeyId(keyId);
        if (validationError) {
          res.status(400).json({ error: validationError });
          return;
        }

        const passphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
        if (!passphrase) {
          res.status(500).json({
            error: 'STUDIO_VAULT_PASSPHRASE is not configured; cannot decrypt the Apple Auth Key vault.',
          });
          return;
        }

        let pem: string | null = null;

        const registryRaw = vaultManager.getCredential(
          passphrase,
          'firebase',
          appleAuthKeysVaultPath(projectId),
        );
        if (registryRaw) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(registryRaw);
          } catch {
            res.status(500).json({
              error:
                `Apple auth key registry at ${appleAuthKeysVaultPath(projectId)} is corrupt JSON. ` +
                'Inspect the project vault entry; do not re-run any Apple key step until it is repaired.',
            });
            return;
          }
          const registry = parsed as Partial<AppleAuthKeyRegistry>;
          const record = registry?.keys?.[keyId];
          if (record?.p8) {
            pem = record.p8;
          }
        }

        if (!pem) {
          // Fallback: legacy upload endpoint stored the PEM as a single-purpose
          // vault entry instead of the unified registry. Try both APNs and SIWA
          // legacy slots (the apple step handler migrates these into the
          // registry on its next run, but we shouldn't make the user run a
          // step just to get a download).
          const legacyApns = vaultManager.getCredential(
            passphrase,
            'firebase',
            `${projectId}/apns_key_p8`,
          );
          const legacyApnsId = vaultManager
            .getCredential(passphrase, 'firebase', `${projectId}/apns_key_id`)
            ?.toUpperCase();
          if (legacyApns && legacyApnsId === keyId) {
            pem = legacyApns;
          } else {
            const legacySiwa = vaultManager.getCredential(
              passphrase,
              'firebase',
              `${projectId}/apple_sign_in_p8`,
            );
            const legacySiwaId = vaultManager
              .getCredential(passphrase, 'firebase', `${projectId}/apple_sign_in_key_id`)
              ?.toUpperCase();
            if (legacySiwa && legacySiwaId === keyId) {
              pem = legacySiwa;
            }
          }
        }

        if (!pem) {
          res.status(404).json({
            error: `No Apple Auth Key with id "${keyId}" is vaulted for project "${projectId}".`,
          });
          return;
        }

        res.setHeader('Content-Type', 'application/x-pem-file');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="AuthKey_${keyId}.p8"`,
        );
        res.setHeader('Cache-Control', 'no-store');
        res.send(pem);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId/integration-kit/auth/zip
  // Packages auth outputs into a downloadable zip for app-repo handoff.
  // -------------------------------------------------------------------------
  router.get(
    '/projects/:projectId/integration-kit/auth/zip',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const plan = loadPersistedPlan(projectId);
        if (!plan) {
          res.status(404).json({ error: `No active provisioning plan for project "${projectId}".` });
          return;
        }
        const projectModule = projectManager.getProject(projectId);
        const bundle = buildAuthIntegrationKitBundle(plan, projectModule);
        const zip = new JSZip();
        for (const file of bundle.files) {
          zip.file(file.path, file.contents);
        }
        const archive = await zip.generateAsync({
          type: 'nodebuffer',
          compression: 'DEFLATE',
          compressionOptions: { level: 9 },
        });
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${bundle.zipFileName}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.send(archive);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('required provisioning outputs are missing')) {
          res.status(409).json({ error: message });
          return;
        }
        res.status(500).json({ error: message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId/integration-kit/auth/prompt
  // Standalone plaintext prompt with embedded auth values for coding LLM use.
  // -------------------------------------------------------------------------
  router.get(
    '/projects/:projectId/integration-kit/auth/prompt',
    (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const plan = loadPersistedPlan(projectId);
        if (!plan) {
          res.status(404).json({ error: `No active provisioning plan for project "${projectId}".` });
          return;
        }
        const projectModule = projectManager.getProject(projectId);
        const bundle = buildAuthIntegrationKitBundle(plan, projectModule);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${bundle.promptFileName}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.send(bundle.promptText);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('required provisioning outputs are missing')) {
          res.status(409).json({ error: message });
          return;
        }
        res.status(500).json({ error: message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId/integration-kit/env
  // Builds a project-level .env template from provisioned outputs + vault.
  // -------------------------------------------------------------------------
  router.get(
    '/projects/:projectId/integration-kit/env',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const passphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
        if (!passphrase) {
          res.status(500).json({
            error:
              'STUDIO_VAULT_PASSPHRASE is not configured; cannot decrypt vault-backed project secrets.',
          });
          return;
        }
        const plan = loadPersistedPlan(projectId);
        if (!plan) {
          res.status(404).json({ error: `No active provisioning plan for project "${projectId}".` });
          return;
        }
        const projectModule = projectManager.getProject(projectId);
        const upstream = collectCompletedUpstreamArtifacts(plan);
        applyProjectDomainToUpstreamArtifacts(upstream, projectModule.project);
        const gcpProjectId =
          upstream['firebase_project_id']?.trim() || upstream['gcp_project_id']?.trim() || '';
        const firebaseAndroidAppId = upstream['firebase_android_app_id']?.trim() || '';
        const firebaseIosAppId = upstream['firebase_ios_app_id']?.trim() || '';
        let derivedFirebaseApiKey = '';
        if (gcpProjectId) {
          try {
            const accessToken = await gcpConnectionService.getAccessToken(projectId);
            if (firebaseAndroidAppId) {
              const androidConfig = await downloadFirebaseAndroidAppConfig(
                accessToken,
                gcpProjectId,
                firebaseAndroidAppId,
              );
              derivedFirebaseApiKey = extractFirebaseApiKeyFromAndroidConfig(androidConfig) ?? '';
            }
            if (!derivedFirebaseApiKey && firebaseIosAppId) {
              const iosConfig = await downloadFirebaseIosAppConfig(
                accessToken,
                gcpProjectId,
                firebaseIosAppId,
              );
              derivedFirebaseApiKey = extractFirebaseApiKeyFromIosConfig(iosConfig) ?? '';
            }
          } catch {
            // Best-effort enrichment only; exporter still works with vault-only values.
          }
        }
        const bundle = buildProjectEnvBundle(
          plan,
          projectModule,
          (providerId, key) => vaultManager.getCredential(passphrase, providerId, key),
          {
            firebaseApiKey: derivedFirebaseApiKey,
          },
        );
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${bundle.fileName}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Studio-Missing-Required-Env-Keys', String(bundle.missingRequiredKeys.length));
        res.send(bundle.contents);
      } catch (err) {
        const message = (err as Error).message;
        res.status(500).json({ error: message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/integrations/firebase/apple/configure
  // Body: { gcp_project_id, team_id, key_id, service_id }
  // Configures Apple Sign-In as a Firebase Auth OIDC provider.
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/integrations/firebase/apple/configure',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const { gcp_project_id, team_id, key_id, service_id } = req.body as {
          gcp_project_id?: string;
          team_id?: string;
          key_id?: string;
          service_id?: string;
        };

        if (!gcp_project_id || !team_id || !key_id || !service_id) {
          res.status(400).json({
            error: 'gcp_project_id, team_id, key_id, and service_id are required.',
          });
          return;
        }

        const accessToken = await gcpConnectionService.getAccessToken(projectId).catch(() => null);
        if (!accessToken) {
          res.status(401).json({ error: 'No valid GCP access token.' });
          return;
        }

        const result = await configureAppleSignIn(
          { project_id: projectId, gcp_project_id, team_id, key_id, service_id, access_token: accessToken },
          credentialStore,
        );
        const vaultPassphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
        if (vaultPassphrase) {
          vaultManager.setCredential(vaultPassphrase, 'firebase', `${projectId}/gcp_project_id`, gcp_project_id);
          vaultManager.setCredential(vaultPassphrase, 'firebase', `${projectId}/apple_team_id`, team_id);
          vaultManager.setCredential(vaultPassphrase, 'firebase', `${projectId}/apple_sign_in_key_id`, key_id);
          vaultManager.setCredential(vaultPassphrase, 'firebase', `${projectId}/apple_sign_in_service_id`, service_id);
        }
        res.json(result);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('Invalid Apple') || message.includes('required')) {
          res.status(400).json({ error: message });
          return;
        }
        res.status(502).json({ error: `Failed to configure Apple Sign-In: ${message}` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/integrations/firebase/bridge/apns
  // Body: { gcp_project_id }
  // Bridges stored APNs key to Firebase Cloud Messaging.
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/integrations/firebase/bridge/apns',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const gcpProjectId = req.body?.gcp_project_id as string | undefined;
        if (!gcpProjectId) {
          res.status(400).json({ error: 'gcp_project_id is required.' });
          return;
        }
        const accessToken = await gcpConnectionService.getAccessToken(projectId).catch(() => null);
        if (!accessToken) {
          res.status(401).json({ error: 'No valid GCP access token.' });
          return;
        }
        const result = await bridgeApnsKeyToFirebase(projectId, gcpProjectId, accessToken, credentialStore);
        res.json(result);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('No APNs key') || message.includes('incomplete')) {
          res.status(400).json({ error: message });
          return;
        }
        res.status(502).json({ error: `Failed to bridge APNs key: ${message}` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/integrations/firebase/bridge/play-fingerprint
  // Body: { gcp_project_id, android_app_id, fingerprint }
  // Adds a Google Play SHA-1 fingerprint to the Firebase Android app.
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/integrations/firebase/bridge/play-fingerprint',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const { gcp_project_id, android_app_id, fingerprint } = req.body as {
          gcp_project_id?: string;
          android_app_id?: string;
          fingerprint?: string;
        };

        if (!gcp_project_id || !android_app_id || !fingerprint) {
          res.status(400).json({
            error: 'gcp_project_id, android_app_id, and fingerprint are required.',
          });
          return;
        }

        const accessToken = await gcpConnectionService.getAccessToken(projectId).catch(() => null);
        if (!accessToken) {
          res.status(401).json({ error: 'No valid GCP access token.' });
          return;
        }

        const result = await bridgePlayFingerprintToFirebase(
          projectId,
          gcp_project_id,
          android_app_id,
          fingerprint,
          accessToken,
          credentialStore,
        );
        res.json(result);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('Invalid SHA-1') || message.includes('must not be empty')) {
          res.status(400).json({ error: message });
          return;
        }
        res.status(502).json({ error: `Failed to bridge Play fingerprint: ${message}` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId/integrations/firebase/oauth/clients
  // Lists all OAuth clients for the project's Firebase config.
  // -------------------------------------------------------------------------
  router.get(
    '/projects/:projectId/integrations/firebase/oauth/clients',
    (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const firebaseConfig = credentialStore.getFirebaseAuthConfig(projectId);
        if (!firebaseConfig) {
          res.json({ clients: [] });
          return;
        }
        const clients = listOAuthClients(firebaseConfig.id, credentialStore);
        res.json({ clients });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/organization/integrations — add org integration default
  // -------------------------------------------------------------------------
  router.post('/organization/integrations', (req: Request, res: Response) => {
    try {
      const provider = req.body?.provider as IntegrationProvider;
      if (!validOrganizationIntegrationProviders.has(provider)) {
        res.status(400).json({
          error: `Unsupported organization module "${provider}". Allowed: github, eas, apple, cloudflare, google-play. Firebase/GCP is project-scoped and must be configured per project.`,
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
          error: `Unsupported organization module "${provider}". Allowed: github, eas, apple, cloudflare, google-play. Firebase/GCP is project-scoped and must be configured per project.`,
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
      if (provider === 'cloudflare' && configPatch && configPatch['api_token']) {
        res.status(400).json({
          error: 'Cloudflare API tokens cannot be stored in module config. Use /api/organization/integrations/cloudflare/connect.',
        });
        return;
      }
      const organization = projectManager.updateOrganizationIntegration(
        provider as IntegrationProvider,
        {
          status: req.body?.status as IntegrationConfigRecord['status'] | undefined,
          notes: req.body?.notes as string | undefined,
          config: configPatch,
          replaceConfig: req.body?.replaceConfig as boolean | undefined,
        },
      );
      res.json(organization.integrations[provider as IntegrationProvider]);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/organization/integrations/apple/connect
  // -------------------------------------------------------------------------
  // Org-level Apple Developer connection: stores team_id (+ optional account
  // email) in the org integration config and persists optional App Store
  // Connect API credentials in the encrypted vault under the shared `apple/*`
  // scope so all projects can read them through `createVaultReader`.
  router.post('/organization/integrations/apple/connect', async (req: Request, res: Response) => {
    try {
      const teamId = (req.body?.teamId as string | undefined)?.trim();
      const ascIssuerId = (req.body?.ascIssuerId as string | undefined)?.trim();
      const ascApiKeyId = (req.body?.ascApiKeyId as string | undefined)?.trim();
      const ascApiKeyP8 = (req.body?.ascApiKeyP8 as string | undefined)?.trim();

      if (!teamId || !ascIssuerId || !ascApiKeyId || !ascApiKeyP8) {
        res.status(400).json({
          error:
            'Apple connection requires teamId, ascIssuerId, ascApiKeyId, and ascApiKeyP8. ' +
            'Studio only supports the automated flow — every field must be supplied.',
        });
        return;
      }
      validateTeamId(teamId);
      validateKeyId(ascApiKeyId);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ascIssuerId)) {
        res.status(400).json({
          error:
            'Invalid ascIssuerId. App Store Connect Issuer IDs are UUIDs ' +
            '(e.g. 57246542-96fe-1a63-e053-0824d011072a). Find it at ' +
            'https://appstoreconnect.apple.com/access/integrations/api → Team Keys tab.',
        });
        return;
      }
      validateAppleP8Key(Buffer.from(ascApiKeyP8, 'utf8'));

      // Verify the credentials against Apple before persisting. Hitting
      // /v1/users?limit=1 catches mismatched issuer ID, key ID, or wrong
      // .p8 type now instead of mid-provisioning.
      await verifyAscApiCredentials({
        issuerId: ascIssuerId,
        keyId: ascApiKeyId,
        privateKeyP8: ascApiKeyP8,
      });

      const vaultPassphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
      if (!vaultPassphrase) {
        res.status(400).json({
          error:
            'STUDIO_VAULT_PASSPHRASE is required to store the App Store Connect API key. Set the environment variable and retry.',
        });
        return;
      }

      const organization = projectManager.getOrganization();
      if (!organization.integrations.apple) {
        projectManager.addOrganizationIntegration('apple');
      }

      vaultManager.setCredential(vaultPassphrase, 'apple', 'apple/team_id', teamId);
      vaultManager.setCredential(vaultPassphrase, 'apple', 'apple/asc_issuer_id', ascIssuerId);
      vaultManager.setCredential(vaultPassphrase, 'apple', 'apple/asc_api_key_id', ascApiKeyId);
      vaultManager.setCredential(vaultPassphrase, 'apple', 'apple/asc_api_key_p8', ascApiKeyP8);

      const updated = projectManager.updateOrganizationIntegration('apple', {
        status: 'configured',
        notes: 'Apple Team ID + App Store Connect Team Key configured at organization scope.',
        config: {
          team_id: teamId,
          asc_issuer_id: ascIssuerId,
          asc_api_key_id: ascApiKeyId,
          asc_api_key_source: 'organization_vault',
        },
        replaceConfig: true,
      });

      res.json({
        integration: updated.integrations.apple,
        ascCredentials: 'stored_in_vault',
      });
    } catch (err) {
      const message = (err as Error).message;
      res.status(400).json({ error: message });
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
              value = projectResourceSlug(module.project) || null;
            } else if (dependency.key === 'project_domain') {
              value = projectPrimaryDomain(module.project) || null;
            } else if (dependency.key === 'apple_team_id') {
              value =
                module.integrations.apple?.config?.['team_id']?.trim() ||
                organization.integrations.apple?.config?.['team_id']?.trim() ||
                credentialService.retrieveCredential(projectId, 'apple_team_id')?.trim() ||
                null;
            } else if (dependency.key === 'default_test_users') {
              value = module.integrations.apple?.config?.['default_test_users']?.trim() || null;
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
            } else if (dependency.key === 'cloudflare_token') {
              const projectCloudflareToken = credentialService
                .retrieveCredential(projectId, 'cloudflare_token')
                ?.trim();
              const cloudflare = organization.integrations.cloudflare;
              value =
                projectCloudflareToken
                  ? 'Configured as project-scoped override token'
                  : cloudflare?.status === 'configured'
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

      const missingRequired = providers.flatMap((p) =>
        p.dependencies.filter((d) => d.status === 'missing').map((d) => `${p.provider}:${d.key}`),
      );
      logStudioApiAction('integrations/dependencies', {
        projectId,
        projectSlug: module.project.slug,
        providerCount: providers.length,
        missingRequiredCount: missingRequired.length,
        missingRequired,
      });

      res.json({
        project: {
          id: module.project.id,
          slug: module.project.slug,
          bundleId: module.project.bundleId,
          domain: module.project.domain,
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
        domain: req.body?.domain as string | undefined,
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
  router.get('/projects/:projectId/provisioning/plan', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const module = projectManager.getProject(projectId);
      const selectedProviders = (req.query['providers'] as string | undefined)
        ?.split(',')
        .filter(Boolean) as ProviderType[] | undefined;
      const environments = normalizeExpoEnvironments(module.project.environments);

      let plan = loadPersistedPlan(projectId);
      let createdNewPlan = false;
      if (!plan) {
        // Build a default plan using all configured providers
        const providers: ProviderType[] = selectedProviders ?? ['firebase', 'github', 'eas'];
        plan = buildProvisioningPlan(
          projectId,
          providers,
          environments,
          undefined,
          module.project.platforms ?? [],
        );
        savePersistedPlan(projectId, plan);
        createdNewPlan = true;
      }

      // Pre-mark credential gates as completed when the org tokens are already stored,
      // so the UI reflects the actual state without requiring a run first.
      // IMPORTANT: this GET handler runs concurrently with the background
      // orchestrator triggered by POST /run/nodes. If we unconditionally save
      // a stale snapshot here, we will race-overwrite step status updates
      // (`completed` -> `in-progress` regression). Track every mutation and
      // only persist when something actually changed, AND skip persistence
      // entirely while a step is in-progress so we never clobber an
      // orchestrator write with a snapshot loaded before that write landed.
      let planMutated = false;
      const planHasInProgressStep = Array.from(plan.nodeStates.values()).some(
        (state) => state.status === 'in-progress',
      );

      const githubTokenForPlan = gitHubConnectionService.getStoredGitHubToken();
      const githubGateState = plan.nodeStates.get('user:provide-github-pat');
      if (!githubTokenForPlan && githubGateState?.status === 'completed') {
        const legacyToken = githubGateState.resourcesProduced?.['github_token']?.trim();
        if (legacyToken && legacyToken !== '[stored in vault]') {
          gitHubConnectionService.storeGitHubToken(legacyToken);
          plan.nodeStates.set('user:provide-github-pat', {
            ...githubGateState,
            resourcesProduced: {
              ...(githubGateState.resourcesProduced ?? {}),
              github_token: '[stored in vault]',
            },
          });
          planMutated = true;
        }
      }

      const githubTokenAfterBackfill = gitHubConnectionService.getStoredGitHubToken();
      if (githubTokenAfterBackfill) {
        const gateState = plan.nodeStates.get('user:provide-github-pat');
        if (gateState && gateState.status === 'not-started') {
          plan.nodeStates.set('user:provide-github-pat', {
            nodeKey: 'user:provide-github-pat',
            status: 'completed',
            completedAt: Date.now(),
            resourcesProduced: { github_token: '[stored in vault]' },
          });
          planMutated = true;
        }
      }

      const expoTokenForPlan = easConnectionService.getStoredExpoToken();
      const expoGateState = plan.nodeStates.get('user:provide-expo-token');
      if (!expoTokenForPlan && expoGateState?.status === 'completed') {
        const legacyToken = expoGateState.resourcesProduced?.['expo_token']?.trim();
        if (legacyToken && legacyToken !== '[stored in vault]') {
          easConnectionService.storeExpoToken(legacyToken);
          plan.nodeStates.set('user:provide-expo-token', {
            ...expoGateState,
            resourcesProduced: {
              ...(expoGateState.resourcesProduced ?? {}),
              expo_token: '[stored in vault]',
            },
          });
          planMutated = true;
        }
      }

      const expoTokenAfterBackfill = easConnectionService.getStoredExpoToken();
      if (expoTokenAfterBackfill) {
        const gateState = plan.nodeStates.get('user:provide-expo-token');
        if (gateState && gateState.status === 'not-started') {
          plan.nodeStates.set('user:provide-expo-token', {
            nodeKey: 'user:provide-expo-token',
            status: 'completed',
            completedAt: Date.now(),
            resourcesProduced: { expo_token: '[stored in vault]' },
          });
          planMutated = true;
        }
      }

      // Backfill legacy/manual Cloudflare ownership gate outputs when the gate
      // is already marked completed but no zone activation metadata was stored.
      // This keeps the UI artifact box populated for older plans completed
      // before ownership verification outputs were persisted.
      const cloudflareOwnershipGate = plan.nodeStates.get('user:confirm-dns-nameservers');
      if (
        cloudflareOwnershipGate?.status === 'completed' &&
        (!cloudflareOwnershipGate.resourcesProduced?.['cloudflare_zone_status'] ||
          !cloudflareOwnershipGate.resourcesProduced?.['cloudflare_account_id'])
      ) {
        try {
          const upstream = collectCompletedUpstreamArtifacts(plan);
          applyProjectDomainToUpstreamArtifacts(upstream, module.project);
          const checked = await checkCloudflareZoneOwnershipForContext({
            projectId,
            environment: 'global',
            upstreamResources: upstream,
            vaultRead: async () => null,
            vaultWrite: async () => { },
          });
          const produced = {
            ...(cloudflareOwnershipGate.resourcesProduced ?? {}),
            ...(checked.zoneId ? { cloudflare_zone_id: checked.zoneId } : {}),
            ...(checked.accountId ? { cloudflare_account_id: checked.accountId } : {}),
            ...(checked.zoneStatus ? { cloudflare_zone_status: checked.zoneStatus } : {}),
            ...(checked.zoneDomain ? { cloudflare_zone_domain: checked.zoneDomain } : {}),
            ...(checked.appDomain ? { cloudflare_app_domain: checked.appDomain } : {}),
            ...(checked.nameservers?.length
              ? { cloudflare_zone_nameservers: checked.nameservers.join(',') }
              : {}),
          };
          if (Object.keys(produced).length !== Object.keys(cloudflareOwnershipGate.resourcesProduced ?? {}).length) {
            plan.nodeStates.set('user:confirm-dns-nameservers', {
              ...cloudflareOwnershipGate,
              resourcesProduced: produced,
            });
            planMutated = true;
            console.info(
              `[studio-cloudflare] Backfilled ownership outputs for "${projectId}" (zoneStatus=${produced['cloudflare_zone_status'] ?? 'unknown'}).`,
            );
          }
        } catch (err) {
          console.warn(
            `[studio-cloudflare] Could not backfill ownership outputs for "${projectId}": ${(err as Error).message}`,
          );
        }
      }

      // Legacy backfill: token may exist without stored account metadata if it
      // was uploaded through older user-action flows. Hydrate once so dynamic
      // Expo URLs (account/project GitHub settings) can resolve correctly.
      const hasExpoIdentity =
        !!easConnectionService.getStoredExpoUsername() ||
        easConnectionService.getStoredExpoAccountNames().length > 0;
      if (!hasExpoIdentity && expoTokenAfterBackfill) {
        try {
          await easConnectionService.syncExpoIntegrationFromCredentialStore();
        } catch (err) {
          console.warn(
            `[studio-eas] Could not backfill Expo account metadata for "${projectId}": ${(err as Error).message}`,
          );
        }
      }

      if (planMutated && !planHasInProgressStep) {
        savePersistedPlan(projectId, plan);
      }
      logStudioApiAction('provisioning/plan GET', {
        projectId,
        createdNewPlan,
        providersQuery: selectedProviders ?? null,
        ...summarizeProvisionPlanForLog(plan),
      });
      res.json(enrichPlanForResponse(plan));
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
      const environments = req.body?.environments
        ? normalizeExpoEnvironments(req.body?.environments as string[] | undefined)
        : normalizeExpoEnvironments(module.project.environments);

      const plan = buildProvisioningPlan(
        projectId,
        providers,
        environments,
        undefined,
        module.project.platforms ?? [],
      );
      savePersistedPlan(projectId, plan);

      res.json(enrichPlanForResponse(plan));
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
      const environments = normalizeExpoEnvironments(moduleRecord.project.environments);
      const modules = (req.body?.modules as ModuleId[] | undefined) ?? [];
      const resolvedModules = resolveModuleDependencies(modules);

      const previousPlan = loadPersistedPlan(projectId);
      const projectPlatforms = moduleRecord.project.platforms ?? [];
      const nextPlan = previousPlan
        ? recomputePlanForModules(previousPlan, resolvedModules, projectPlatforms)
        : buildProvisioningPlanForModules(projectId, resolvedModules, environments, projectPlatforms);

      savePersistedPlan(projectId, nextPlan);
      res.json(enrichPlanForResponse(nextPlan));
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
      const environments = normalizeExpoEnvironments(moduleRecord.project.environments);
      const persistedPlan = loadPersistedPlan(projectId);
      const requestModules = (req.body?.modules as ModuleId[] | undefined) ?? [];
      const selectedModules = resolveModuleDependencies(
        requestModules.length > 0
          ? requestModules
          : (persistedPlan?.selectedModules as ModuleId[] | undefined) ?? [],
      );
      const providers = getProvidersForModules(selectedModules);
      const teardownPlan = buildTeardownPlan(
        projectId,
        providers,
        environments,
        selectedModules,
        moduleRecord.project.platforms ?? [],
      );

      savePersistedPlan(projectId, teardownPlan);
      res.json(enrichPlanForResponse(teardownPlan));
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
      const planTouchesGithub = planUsesGithubProvider(plan);
      const planTouchesEas = plan.nodes.some((n) => n.provider === 'eas');
      const expoTokenForTeardown = easConnectionService.getStoredExpoToken();
      if (planTouchesGithub && !githubToken) {
        res.status(400).json({
          error:
            'GitHub is not connected. Connect a GitHub PAT via the organization settings before running teardown.',
        });
        return;
      }
      if (planTouchesEas && !expoTokenForTeardown) {
        res.status(400).json({
          error:
            'Expo / EAS is not connected. Add an Expo access token before running teardown for a plan that includes EAS steps.',
        });
        return;
      }

      const defaultBranchRules: BranchProtectionRule[] = [
        { branch: 'main', require_reviews: true, dismiss_stale_reviews: true, require_status_checks: true },
        { branch: 'develop', require_reviews: false, dismiss_stale_reviews: false, require_status_checks: true },
      ];
      const manifestProviders: ProviderConfig[] = [];
      if (planTouchesGithub) {
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
          repo_name: projectResourceSlug(module.project),
          branch_protection_rules: defaultBranchRules,
          environments: (plan.environments as Array<'development' | 'preview' | 'production'>),
          workflow_templates: buildGitHubWorkflowTemplates(plan),
        };
        manifestProviders.push(githubManifestConfig);
      }
      if (planUsesFirebaseProvider(plan)) {
        manifestProviders.push(buildFirebaseManifestConfig(projectId));
      }
      if (planTouchesEas && expoTokenForTeardown) {
        manifestProviders.push(buildEasManifestConfig(projectManager, projectId, plan));
      }
      if (planUsesAppleProvider(plan)) {
        manifestProviders.push(buildAppleManifestConfig(projectId, plan));
      }
      if (planUsesCloudflareProvider(plan)) {
        manifestProviders.push(buildCloudflareManifestConfig(projectId));
      }
      if (planUsesOauthProvider(plan)) {
        manifestProviders.push(buildOauthManifestConfig(projectId, plan));
      }
      const manifest: ProviderManifest = {
        version: PLATFORM_CORE_VERSION,
        app_id: projectId,
        providers: manifestProviders,
      };

      const registry = new ProviderRegistry();
      const httpClient = githubToken ? new HttpGitHubApiClient(githubToken) : null;
      if (planTouchesGithub && httpClient) {
        registry.register('github', new GitHubAdapter(httpClient));
      }
      if (planUsesFirebaseProvider(plan)) {
        registry.register('firebase', new FirebaseAdapter(new StubFirebaseApiClient(), gcpConnectionService));
      }
      if (planTouchesEas && expoTokenForTeardown) {
        registry.register(
          'eas',
          new EasAdapter(new ExpoGraphqlEasApiClient(expoTokenForTeardown), undefined, httpClient ?? undefined),
        );
      }
      if (planUsesAppleProvider(plan)) {
        registry.register('apple', new AppleAdapter());
      }
      if (planUsesCloudflareProvider(plan)) {
        registry.register('cloudflare', buildCloudflareAdapter(projectId));
      }
      if (planUsesOauthProvider(plan)) {
        registry.register(
          'oauth',
          new OAuthAdapter(
            new StudioOAuthApiClient((studioProjectId, reason) =>
              gcpConnectionService.getAccessToken(studioProjectId, reason),
            ),
          ),
        );
      }
      const orchestrator = new Orchestrator(registry, eventLog);
      const vaultRead = createVaultReader(vaultManager);

      void (async () => {
        const currentPlan = loadPersistedPlan(projectId);
        if (!currentPlan) return;

        for await (const event of orchestrator.teardownBySteps(currentPlan, manifest, {}, vaultRead)) {
          const normalizedEnvironment =
            event.environment && event.environment !== 'global' ? event.environment : undefined;
          const stateKey = normalizedEnvironment ? `${event.nodeKey}@${normalizedEnvironment}` : event.nodeKey;
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
            environment: normalizedEnvironment,
            error: event.error,
            userPrompt: event.userPrompt,
            resourcesProduced: event.resourcesProduced,
            completedAt: event.status === 'success' || event.status === 'skipped' ? Date.now() : undefined,
          });
          savePersistedPlan(projectId, currentPlan);

          wsHandler.broadcastStepProgress(
            projectId,
            event.nodeKey,
            event.nodeType,
            event.status,
            normalizedEnvironment,
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
      // Intentionally no per-request log here — clients poll this often. Use GET /provisioning/plan for a full snapshot.
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
    async (req: Request, res: Response) => {
      try {
        const { projectId, nodeKey } = req.params;
        const plan = loadPersistedPlan(projectId);
        if (!plan) {
          logStudioApiAction('provisioning/plan/user-action/complete POST', {
            projectId,
            nodeKey,
            outcome: 'error',
            error: 'no_plan',
          });
          res.status(404).json({ error: `No active provisioning plan for project "${projectId}".` });
          return;
        }

        const state = plan.nodeStates.get(nodeKey);
        if (!state) {
          logStudioApiAction('provisioning/plan/user-action/complete POST', {
            projectId,
            nodeKey,
            outcome: 'error',
            error: 'node_not_in_plan',
            knownStateKeys: Array.from(plan.nodeStates.keys()).slice(0, 80),
          });
          res.status(404).json({ error: `Node "${nodeKey}" not found in plan.` });
          return;
        }

        const resourcesProduced = req.body?.resourcesProduced as Record<string, string> | undefined;
        let normalizedResourcesProduced = resourcesProduced;

        if (nodeKey === 'user:provide-github-pat') {
          const githubToken = resourcesProduced?.['github_token']?.trim();
          if (!githubToken) {
            res.status(400).json({ error: 'Missing "github_token" in resourcesProduced.' });
            return;
          }
          gitHubConnectionService.storeGitHubToken(githubToken);
          normalizedResourcesProduced = {
            ...(resourcesProduced ?? {}),
            github_token: '[stored in vault]',
          };
        }

        if (nodeKey === 'user:provide-expo-token') {
          const expoToken = resourcesProduced?.['expo_token']?.trim();
          if (!expoToken) {
            res.status(400).json({ error: 'Missing "expo_token" in resourcesProduced.' });
            return;
          }
          // Validate + persist token and account metadata (username/orgs) so
          // downstream UI links can target the correct Expo account.
          await easConnectionService.connect(expoToken);
          normalizedResourcesProduced = {
            ...(resourcesProduced ?? {}),
            expo_token: '[stored in vault]',
          };
        }

        let verifiedGithubOwner: string | undefined;
        let verifiedGithubRepo: string | undefined;
        let verifiedCloudflareResources: Record<string, string> | undefined;
        if (nodeKey === 'user:install-expo-github-app') {
          const upstream = collectCompletedUpstreamArtifacts(plan);
          applyProjectDomainToUpstreamArtifacts(upstream, projectManager.getProject(projectId).project);
          const checked = await checkExpoGitHubInstallForContext({
            projectId,
            environment: 'global',
            upstreamResources: upstream,
            vaultRead: async () => null,
            vaultWrite: async () => { },
          });
          if (!checked.linked || !checked.githubOwner || !checked.githubRepo) {
            res.status(400).json({
              error:
                `Expo project "${upstream['eas_project_id']?.trim() || '[unknown]'}" is not linked to GitHub repository "${upstream['github_repo_url']?.trim() || '[unknown]'}" on expo.dev yet. ` +
                'Open your app on expo.dev → GitHub settings, connect that repository (Expo GitHub App must have access), then verify again. ' +
                'Docs: https://docs.expo.dev/eas-update/github-integration/',
            });
            return;
          }
          verifiedGithubOwner = checked.githubOwner;
          verifiedGithubRepo = checked.githubRepo;
        }

        if (nodeKey === 'user:confirm-dns-nameservers') {
          const upstream = collectCompletedUpstreamArtifacts(plan);
          applyProjectDomainToUpstreamArtifacts(upstream, projectManager.getProject(projectId).project);
          const checked = await checkCloudflareZoneOwnershipForContext({
            projectId,
            environment: 'global',
            upstreamResources: upstream,
            vaultRead: async () => null,
            vaultWrite: async () => { },
          });

          if (!checked.owned) {
            res.status(400).json({
              error:
                `Cloudflare zone "${checked.zoneDomain || upstream['cloudflare_zone_domain'] || '[unknown]'}" is not accessible with the configured token yet. ` +
                'Create/verify the zone first, then try again.',
            });
            return;
          }
          if (checked.zoneStatus !== 'active') {
            res.status(400).json({
              error:
                `Cloudflare zone "${checked.zoneDomain || '[unknown]'}" is currently "${checked.zoneStatus || 'unknown'}". ` +
                'Wait until zone status is "active" (nameserver delegation propagated), then complete this step again.',
            });
            return;
          }

          verifiedCloudflareResources = {
            ...(checked.zoneId ? { cloudflare_zone_id: checked.zoneId } : {}),
            ...(checked.accountId ? { cloudflare_account_id: checked.accountId } : {}),
            ...(checked.zoneStatus ? { cloudflare_zone_status: checked.zoneStatus } : {}),
            ...(checked.zoneDomain ? { cloudflare_zone_domain: checked.zoneDomain } : {}),
            ...(checked.appDomain ? { cloudflare_app_domain: checked.appDomain } : {}),
            ...(checked.nameservers?.length
              ? { cloudflare_zone_nameservers: checked.nameservers.join(',') }
              : {}),
          };
        }

        const mergedProduced: Record<string, string> = {
          ...(normalizedResourcesProduced ?? state.resourcesProduced ?? {}),
          ...(nodeKey === 'user:install-expo-github-app' && verifiedGithubOwner && verifiedGithubRepo
            ? {
                expo_github_repo_linked: 'true',
                verified_github_owner: verifiedGithubOwner,
                verified_github_repo: verifiedGithubRepo,
              }
            : {}),
          ...(nodeKey === 'user:confirm-dns-nameservers' && verifiedCloudflareResources
            ? verifiedCloudflareResources
            : {}),
        };

        const updated: NodeState = {
          ...state,
          status: 'completed',
          completedAt: Date.now(),
          resourcesProduced: mergedProduced,
        };
        plan.nodeStates.set(nodeKey, updated);
        savePersistedPlan(projectId, plan);

        logStudioApiAction('provisioning/plan/user-action/complete POST', {
          projectId,
          nodeKey,
          outcome: 'ok',
          previousStatus: state.status,
          verifiedGithubOwner: verifiedGithubOwner ?? null,
          verifiedGithubRepo: verifiedGithubRepo ?? null,
          resourcesProduced: summarizeResourcesProducedForLog(updated.resourcesProduced),
          planSummary: summarizeProvisionPlanForLog(plan),
        });

        // Broadcast the status change to any connected WS clients
        wsHandler.broadcastStepProgress(
          projectId,
          nodeKey,
          'user-action',
          'success',
          undefined,
          mergedProduced,
        );

        res.json({ nodeKey, status: 'completed', resourcesProduced: mergedProduced });
      } catch (err) {
        const message = (err as Error).message;
        logStudioApiAction('provisioning/plan/user-action/complete POST', {
          projectId: req.params.projectId,
          nodeKey: req.params.nodeKey,
          outcome: 'error',
          error: message.slice(0, 500),
        });
        const userFixableExpoGithub =
          req.params.nodeKey === 'user:install-expo-github-app' &&
          /No active Expo GitHub App|Expected a github\.com repository URL|Expo account "|Multiple Expo accounts are linked|No Expo accounts available for this token|was not found for this token|owner account does not match the configured Expo organization/i.test(
            message,
          );
        res.status(userFixableExpoGithub ? 400 : 500).json({ error: message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // PUT /api/projects/:projectId/provisioning/plan/node/:nodeKey/inputs
  // Save user-provided input values for a step with inputFields.
  // Body: { inputs: Record<string, string> }
  // -------------------------------------------------------------------------
  router.put(
    '/projects/:projectId/provisioning/plan/node/:nodeKey/inputs',
    async (req: Request, res: Response) => {
      try {
        const { projectId, nodeKey } = req.params;
        const inputs: Record<string, string> = req.body?.inputs ?? {};
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

        const prevInputs = state.userInputs ?? {};
        const inputsChanged = JSON.stringify(prevInputs) !== JSON.stringify(inputs);

        state.userInputs = inputs;

        if (inputsChanged && state.status === 'completed') {
          state.status = 'not-started';
          state.completedAt = undefined;
          state.resourcesProduced = undefined;
          state.error = undefined;
        }

        plan.nodeStates.set(nodeKey, state);
        savePersistedPlan(projectId, plan);

        logStudioApiAction('provisioning/plan/node/inputs PUT', { projectId, nodeKey, inputsChanged });
        res.json({ nodeKey, inputs, needsReprovision: inputsChanged && state.status === 'not-started' });
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
      const environments = normalizeExpoEnvironments(module.project.environments);

      // Pre-check: validate that credentials exist for steps in the plan.
      // Collect step keys that have associated credential requirements.
      const credentialGatedStepTypes = planProviders.flatMap((p) => {
        const stepMap: Record<string, string[]> = {
          github: ['github:create-repo', 'github:configure-branch-protection'],
          apple: ['apple:generate-apns-key', 'apple:upload-apns-to-firebase'],
          'google-play': ['google-play:configure-app'],
          cloudflare: ['cloudflare:configure-dns'],
        };
        return stepMap[p] ?? [];
      });

      const missingByStep = credentialRetrievalService.analyzeMissingCredentialsForPlan(
        projectId,
        credentialGatedStepTypes,
      );

      if (Object.keys(missingByStep).length > 0) {
        const affectedSteps = Object.keys(missingByStep);
        const missingTypes = [
          ...new Set(Object.values(missingByStep).flatMap((r) => r.missing_types)),
        ];
        console.warn(
          `[studio] Provisioning run for "${projectId}" started with ${missingTypes.length} missing credential type(s): ${missingTypes.join(', ')}. ` +
            `Affected steps: ${affectedSteps.join(', ')}. Steps requiring these credentials will be skipped.`,
        );
      }

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
        plan = buildProvisioningPlan(
          projectId,
          planProviders,
          environments,
          undefined,
          module.project.platforms ?? [],
        );
        savePersistedPlan(projectId, plan);
      }

      // Read the stored GitHub PAT from the credential vault
      const githubToken = gitHubConnectionService.getStoredGitHubToken();
      const planTouchesGithub = planUsesGithubProvider(plan);

      // Build the gate resolver — handles GCP auth, GitHub PAT, Expo token
      // auto-completion during orchestration instead of ad-hoc pre-marking.
      const gateResolver = buildProvisioningGateResolver({
        gcpConnectionService,
        easConnectionService,
        getGitHubToken: () => gitHubConnectionService.getStoredGitHubToken(),
        getCloudflareToken: (id) => getCloudflareTokenForProject(id),
        checkCloudflareZoneOwnership: checkCloudflareZoneOwnershipForContext,
        checkExpoGitHubInstall: checkExpoGitHubInstallForContext,
      });

      // Build provider manifest for GitHub
      const defaultBranchRules: BranchProtectionRule[] = [
        { branch: 'main', require_reviews: true, dismiss_stale_reviews: true, require_status_checks: true },
        { branch: 'develop', require_reviews: false, dismiss_stale_reviews: false, require_status_checks: true },
      ];
      const manifestProviders: ProviderConfig[] = [];
      if (planTouchesGithub) {
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
          repo_name: projectResourceSlug(module.project),
          branch_protection_rules: defaultBranchRules,
          environments: (plan.environments as Array<'development' | 'preview' | 'production'>),
          workflow_templates: buildGitHubWorkflowTemplates(plan),
        };
        manifestProviders.push(githubManifestConfig);
      }
      if (planUsesFirebaseProvider(plan)) {
        manifestProviders.push(buildFirebaseManifestConfig(projectId));
      }
      if (planUsesEasProvider(plan)) {
        manifestProviders.push(buildEasManifestConfig(projectManager, projectId, plan));
      }
      if (planUsesAppleProvider(plan)) {
        manifestProviders.push(buildAppleManifestConfig(projectId, plan));
      }
      if (planUsesCloudflareProvider(plan)) {
        manifestProviders.push(buildCloudflareManifestConfig(projectId));
      }
      if (planUsesOauthProvider(plan)) {
        manifestProviders.push(buildOauthManifestConfig(projectId, plan));
      }
      const manifest: ProviderManifest = {
        version: PLATFORM_CORE_VERSION,
        app_id: projectId,
        providers: manifestProviders,
      };

      // Require a real GitHub token — refuse to run with stubs.
      if (planTouchesGithub && !githubToken) {
        res.status(400).json({
          error: 'GitHub is not connected. Connect a GitHub PAT via the organization settings before running provisioning.',
        });
        return;
      }

      const expoTokenForFullRun = easConnectionService.getStoredExpoToken();
      if (planUsesEasProvider(plan) && !expoTokenForFullRun) {
        res.status(400).json({
          error:
            'Expo / EAS is not connected. Add an Expo access token under organization integrations before running a plan that includes EAS steps.',
        });
        return;
      }

      const registry = new ProviderRegistry();
      const httpClient = githubToken ? new HttpGitHubApiClient(githubToken) : null;
      if (planTouchesGithub && httpClient) {
        registry.register('github', new GitHubAdapter(httpClient));
      }
      if (planUsesFirebaseProvider(plan)) {
        registry.register('firebase', new FirebaseAdapter(new StubFirebaseApiClient(), gcpConnectionService));
      }
      if (planUsesEasProvider(plan) && expoTokenForFullRun) {
        registry.register(
          'eas',
          new EasAdapter(new ExpoGraphqlEasApiClient(expoTokenForFullRun), undefined, httpClient ?? undefined),
        );
      }
      if (planUsesAppleProvider(plan)) {
        registry.register('apple', new AppleAdapter());
      }
      if (planUsesCloudflareProvider(plan)) {
        registry.register('cloudflare', buildCloudflareAdapter(projectId));
      }
      if (planUsesOauthProvider(plan)) {
        registry.register(
          'oauth',
          new OAuthAdapter(
            new StudioOAuthApiClient((studioProjectId, reason) =>
              gcpConnectionService.getAccessToken(studioProjectId, reason),
            ),
          ),
        );
      }

      const vaultRead = createVaultReader(vaultManager);
      const vaultWrite = createVaultWriter(vaultManager);

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
            {
              initialUpstreamResources: buildInitialUpstreamSeed(
                module.project,
                projectManager.getOrganization(),
              ),
            },
            vaultRead,
            vaultWrite,
            undefined,
            gateResolver,
          )) {
            const normalizedEnvironment =
              event.environment && event.environment !== 'global' ? event.environment : undefined;
            const stateKey = normalizedEnvironment ? `${event.nodeKey}@${normalizedEnvironment}` : event.nodeKey;

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
              environment: normalizedEnvironment,
              error: event.error,
              userPrompt: event.userPrompt,
              resourcesProduced: event.resourcesProduced,
              completedAt: event.status === 'success' || event.status === 'skipped' ? Date.now() : undefined,
            });

            wsHandler.broadcastStepProgress(
              projectId,
              event.nodeKey,
              event.nodeType,
              event.status,
              normalizedEnvironment,
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

      logStudioApiAction('provisioning/plan/run POST', {
        projectId,
        planProviders,
        reusedExistingPlanWhileRunning: planIsRunning,
        ...summarizeProvisionPlanForLog(plan),
      });
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
      const expoTokenForOrchestrator = easConnectionService.getStoredExpoToken();
      const handlerBackedNeedsEas = handlerBacked.some((k) => {
        const base = k.includes('@') ? k.split('@')[0]! : k;
        return base.startsWith('eas:');
      });
      const orchestratorBackedNeedsEas = orchestratorBacked.some((k) =>
        (k.includes('@') ? k.split('@')[0]! : k).startsWith('eas:'),
      );
      if ((orchestratorBackedNeedsEas || handlerBackedNeedsEas) && !expoTokenForOrchestrator) {
        res.status(400).json({
          error:
            'Expo / EAS is not connected. Add an Expo access token under organization integrations before running EAS provisioning steps.',
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
            plan.nodeStates.set(nk, {
              nodeKey: baseKey,
              status: 'in-progress',
              startedAt: Date.now(),
              ...(existing?.environment !== undefined ? { environment: existing.environment } : {}),
              ...(existing?.userInputs ? { userInputs: existing.userInputs } : {}),
            });
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
      logStudioApiAction('provisioning/plan/run/nodes POST', {
        projectId,
        requestedNodeKeys: nodeKeys,
        effectiveNodeKeys,
        handlerBackedCount: handlerBacked.length,
        orchestratorBackedCount: orchestratorBacked.length,
        handlerBacked,
        orchestratorBacked,
      });
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
        try {
          applyProjectDomainToUpstreamArtifacts(
            upstreamArtifacts,
            projectManager.getProject(projectId).project,
          );
        } catch (err) {
          const errno = err as NodeJS.ErrnoException;
          if (errno.code !== 'ENOENT') throw err;
          // Some legacy runs may still have a persisted plan while the
          // module.json was removed. Domain enrichment is optional for steps
          // like oauth:configure-apple-sign-in, so skip it instead of hard
          // failing the entire targeted run.
          console.warn(
            `[plan/run/nodes] studio="${projectId}" | Project module missing while applying domain enrichment; continuing without project domain context.`,
          );
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

          const existingState = currentPlan.nodeStates.get(stateKey);
          const context = {
            projectId,
            environment,
            upstreamArtifacts: { ...upstreamArtifacts },
            userInputs: existingState?.userInputs,
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
                userInputs: existingState?.userInputs,
              });
              wsHandler.broadcastStepProgress(projectId, baseKey, 'step', 'success', environment, resources);
              const summary = result.message ? ` — ${result.message}` : '';
              console.log(`[plan/run/nodes] studio="${projectId}" | ✓ "${baseKey}" completed.${summary}`);
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
                userInputs: existingState?.userInputs,
              });
              wsHandler.broadcastStepProgress(projectId, baseKey, 'step', 'failure', environment, undefined, errMsg);
              console.log(`[plan/run/nodes] studio="${projectId}" | ✗ "${baseKey}" failed: ${errMsg}`);
            }
          } catch (err) {
            const errMsg = (err as Error).message;
            currentPlan.nodeStates.set(stateKey, { nodeKey: baseKey, status: 'failed', environment, error: errMsg, userInputs: existingState?.userInputs });
            wsHandler.broadcastStepProgress(projectId, baseKey, 'step', 'failure', environment, undefined, errMsg);
            console.error(`[plan/run/nodes] studio="${projectId}" | ✗ "${baseKey}" threw: ${errMsg}`);
          }

          savePersistedPlan(projectId, currentPlan);
        }

        // ── Orchestrator path for github/*, eas/*, oauth/* steps and user-action gates ──
        const orchBaseKeys = orchestratorBacked.map((k) => (k.includes('@') ? k.split('@')[0]! : k));
        const needsGithubOrchestration = orchBaseKeys.some((b) => b.startsWith('github:'));
        const needsEasOrchestration = orchBaseKeys.some((b) => b.startsWith('eas:'));
        const needsOauthOrchestration = orchBaseKeys.some((b) => b.startsWith('oauth:'));
        const needsAppleOrchestration = orchBaseKeys.some((b) => b.startsWith('apple:'));
        const needsCloudflareOrchestration = orchBaseKeys.some((b) => b.startsWith('cloudflare:'));
        const canRunOrchestrator =
          orchestratorBacked.length > 0 &&
          (!needsGithubOrchestration || !!githubToken) &&
          (!needsEasOrchestration || !!expoTokenForOrchestrator);

        if (canRunOrchestrator) {
          const projectModule = projectManager.getProject(projectId);
          const nodesGateResolver = buildProvisioningGateResolver({
            gcpConnectionService,
            easConnectionService,
            getGitHubToken: () => gitHubConnectionService.getStoredGitHubToken(),
            getCloudflareToken: (id) => getCloudflareTokenForProject(id),
            checkCloudflareZoneOwnership: checkCloudflareZoneOwnershipForContext,
            checkExpoGitHubInstall: checkExpoGitHubInstallForContext,
          });

          const org = projectManager.getOrganization();
          const orgGithubConfig = org.integrations.github?.config ?? {};
          const module = needsGithubOrchestration
            ? projectModule
            : null;
          const githubOwner =
            module?.project.githubOrg?.trim() ||
            orgGithubConfig['owner_default']?.trim() ||
            orgGithubConfig['username']?.trim() ||
            module?.project.slug ||
            projectId;

          const manifestProviders: ProviderConfig[] = [];
          if (needsGithubOrchestration && githubToken) {
            const githubProject = module ?? projectManager.getProject(projectId);
            manifestProviders.push({
              provider: 'github',
              owner: githubOwner,
              repo_name: projectResourceSlug(githubProject.project),
              branch_protection_rules: [
                { branch: 'main', require_reviews: true, dismiss_stale_reviews: true, require_status_checks: true },
                { branch: 'develop', require_reviews: false, dismiss_stale_reviews: false, require_status_checks: true },
              ],
              environments: currentPlan.environments as Array<'development' | 'preview' | 'production'>,
              workflow_templates: buildGitHubWorkflowTemplates(currentPlan),
            });
          }
          if (needsEasOrchestration && expoTokenForOrchestrator) {
            manifestProviders.push(buildEasManifestConfig(projectManager, projectId, currentPlan));
          }
          if (needsAppleOrchestration) {
            manifestProviders.push(buildAppleManifestConfig(projectId, currentPlan));
          }
          if (needsCloudflareOrchestration) {
            manifestProviders.push(buildCloudflareManifestConfig(projectId));
          }
          if (needsOauthOrchestration) {
            manifestProviders.push(buildOauthManifestConfig(projectId, currentPlan));
          }

          const manifest: ProviderManifest = {
            version: PLATFORM_CORE_VERSION,
            app_id: projectId,
            providers: manifestProviders,
          };

          const registry = new ProviderRegistry();
          if (needsGithubOrchestration && githubToken) {
            registry.register('github', new GitHubAdapter(new HttpGitHubApiClient(githubToken)));
          }
          if (needsEasOrchestration && expoTokenForOrchestrator) {
            const ghForEas = githubToken ? new HttpGitHubApiClient(githubToken) : undefined;
            registry.register(
              'eas',
              new EasAdapter(new ExpoGraphqlEasApiClient(expoTokenForOrchestrator), undefined, ghForEas),
            );
          }
          if (needsAppleOrchestration) {
            registry.register('apple', new AppleAdapter());
          }
          if (needsCloudflareOrchestration) {
            registry.register('cloudflare', buildCloudflareAdapter(projectId));
          }
          if (needsOauthOrchestration) {
            registry.register(
              'oauth',
              new OAuthAdapter(
                new StudioOAuthApiClient((studioProjectId, reason) =>
                  gcpConnectionService.getAccessToken(studioProjectId, reason),
                ),
              ),
            );
          }

          const orchestrator = new Orchestrator(registry, eventLog);
          const vaultRead = createVaultReader(vaultManager);
          const vaultWrite = createVaultWriter(vaultManager);
          const nodeKeysFilter = new Set(orchestratorBacked);

          try {
            for await (const event of orchestrator.provisionBySteps(
              currentPlan,
              manifest,
              {
                initialUpstreamResources: buildInitialUpstreamSeed(
                  projectModule.project,
                  projectManager.getOrganization(),
                ),
              },
              vaultRead,
              vaultWrite,
              nodeKeysFilter,
              nodesGateResolver,
            )) {
              const normalizedEnvironment =
                event.environment && event.environment !== 'global' ? event.environment : undefined;
              const stateKey = normalizedEnvironment ? `${event.nodeKey}@${normalizedEnvironment}` : event.nodeKey;
              // Preserve userInputs across the event-driven state rewrite.
              // Without this, every status transition the orchestrator emits
              // would clobber the user-supplied configuration map persisted
              // by PUT /inputs, and any retry / re-edit / re-render of the
              // wizard would render empty fields (or, worse, the executor
              // would see no inputs and bounce the user back into a
              // "Missing input" waiting-on-user prompt).
              const previousState = currentPlan.nodeStates.get(stateKey);
              currentPlan.nodeStates.set(stateKey, {
                nodeKey: event.nodeKey,
                status:
                  event.status === 'success' ? 'completed' :
                  event.status === 'failure' ? 'failed' :
                  event.status === 'waiting-on-user' ? 'waiting-on-user' :
                  event.status === 'resolving' ? 'resolving' :
                  event.status === 'skipped' ? 'skipped' :
                  event.status === 'blocked' ? 'blocked' : 'in-progress',
                environment: normalizedEnvironment,
                error: event.error,
                userPrompt: event.userPrompt,
                resourcesProduced: event.resourcesProduced,
                completedAt: event.status === 'success' || event.status === 'skipped' ? Date.now() : undefined,
                ...(previousState?.userInputs ? { userInputs: previousState.userInputs } : {}),
              });
              wsHandler.broadcastStepProgress(
                projectId, event.nodeKey, event.nodeType, event.status,
                normalizedEnvironment, event.resourcesProduced, event.error, event.userPrompt,
              );
              if (event.status === 'failure' && event.error) {
                console.error(
                  `[plan/run/nodes] studio="${projectId}" | ✗ "${event.nodeKey}"` +
                    (event.provider ? ` (${event.provider})` : '') +
                    `: ${event.error}`,
                );
              }
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
        'firebase:create-gcp-project',
        'firebase:bind-provisioner-iam',
        'firebase:create-provisioner-sa',
        'firebase:delete-gcp-project',
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
      const revertManualActions: RevertManualAction[] = [];

      if (handlerKeysToDelete.length > 0) {
        // Delete from leaf to root (reverse order so dependents are torn down first)
        const deleteOrder = [...handlerKeysToDelete].reverse();
        console.log(`[studio-api] node/reset: deleting GCP resources for ${projectId}: ${deleteOrder.join(', ')}`);

        const revertArtifactSnapshot: Record<string, string> = {};
        for (const st of plan.nodeStates.values()) {
          if (st.status === 'completed' && st.resourcesProduced) {
            Object.assign(revertArtifactSnapshot, st.resourcesProduced);
          }
        }
        applyProjectDomainToUpstreamArtifacts(revertArtifactSnapshot, projectManager.getProject(projectId).project);

        for (const stepKey of deleteOrder) {
          const handler = globalStepHandlerRegistry.get(stepKey);
          if (!handler) continue;

          const handlerContext = {
            projectId,
            upstreamArtifacts: { ...revertArtifactSnapshot },
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
            console.log(
              `[studio-api] node/reset ${stepKey}: handler.delete reconciled=${result.reconciled}` +
                (result.message ? ` (${result.message})` : ''),
            );
            if (!result.reconciled) {
              const msg = result.message ?? 'handler.delete returned reconciled=false with no message.';
              revertWarnings.push(`${stepKey}: ${msg}`);
              appendExpoManualDeleteIfRobotBlocked(
                revertManualActions,
                stepKey,
                msg,
                projectManager,
                projectId,
                easConnectionService.getStoredExpoAccountNames(),
              );
            }
          } catch (err) {
            const msg = (err as Error).message;
            revertWarnings.push(`${stepKey}: ${msg}`);
            appendExpoManualDeleteIfRobotBlocked(
              revertManualActions,
              stepKey,
              msg,
              projectManager,
              projectId,
              easConnectionService.getStoredExpoAccountNames(),
            );
          }
        }

        if (revertWarnings.length > 0) {
          console.warn(`[studio-api] node/reset: partial revert for ${projectId}: ${revertWarnings.join('; ')}`);
        }
      }

      if (allKeysToReset.includes('apple:revoke-signing-assets')) {
        revertManualActions.push({
          stepKey: 'apple:revoke-signing-assets',
          title: 'Revoke Apple signing assets manually',
          body:
            'Revoke certificates, provisioning profiles, APNs keys, and App Store Connect API keys in Apple Developer and App Store Connect.',
          primaryUrl: 'https://developer.apple.com/account/resources',
          primaryLabel: 'Open Apple Developer resources',
        });
      }
      if (allKeysToReset.includes('apple:remove-app-store-listing')) {
        revertManualActions.push({
          stepKey: 'apple:remove-app-store-listing',
          title: 'Remove App Store Connect listing manually',
          body:
            'Archive or remove the App Store listing in App Store Connect. Apple may not allow permanent deletion for published apps.',
          primaryUrl: 'https://appstoreconnect.apple.com/apps',
          primaryLabel: 'Open App Store Connect apps',
        });
      }

      // Reverting credential-upload gates should also remove org-scoped tokens
      // from vault so subsequent steps cannot continue using stale credentials.
      if (allKeysToReset.includes('user:provide-github-pat')) {
        try {
          const disconnected = gitHubConnectionService.disconnect();
          console.log(
            `[studio-api] node/reset: revoked GitHub PAT for ${projectId} (removed=${disconnected.removed}).`,
          );
        } catch (err) {
          revertWarnings.push(`user:provide-github-pat: ${(err as Error).message}`);
        }
      }
      if (allKeysToReset.includes('user:provide-expo-token')) {
        try {
          const disconnected = easConnectionService.disconnect();
          console.log(
            `[studio-api] node/reset: revoked Expo token for ${projectId} (removed=${disconnected.removed}).`,
          );
        } catch (err) {
          revertWarnings.push(`user:provide-expo-token: ${(err as Error).message}`);
        }
      }

      const hasManualRevertStep = revertManualActions.some((action) => allKeysToReset.includes(action.stepKey));
      if (!hasManualRevertStep) {
        clearLogicalNodeState(plan, node);
        for (const depKey of dependents) {
          const n = plan.nodes.find((x) => x.key === depKey);
          if (n) clearLogicalNodeState(plan, n);
        }
      }

      savePersistedPlan(projectId, plan);

      const enriched = enrichPlanForResponse(plan);
      if (revertWarnings.length > 0) {
        (enriched as any).revertWarnings = revertWarnings;
      }
      if (revertManualActions.length > 0) {
        (enriched as any).revertManualActions = revertManualActions;
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
  // POST /api/projects/:projectId/provisioning/plan/node/cancel
  // Force-clears a stuck in-progress node back to not-started without doing
  // any GCP cleanup. Use when a handler is mid-flight and the user wants to
  // unblock the UI so they can re-trigger the step.
  // Body: { nodeKey: string }
  // -------------------------------------------------------------------------
  router.post('/projects/:projectId/provisioning/plan/node/cancel', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const nodeKey = req.body?.nodeKey as string | undefined;
      if (!nodeKey || typeof nodeKey !== 'string') {
        res.status(400).json({ error: 'nodeKey is required.' });
        return;
      }

      const plan = loadPersistedPlan(projectId);
      if (!plan) {
        res.status(404).json({ error: `No provisioning plan found for project "${projectId}".` });
        return;
      }

      const node = plan.nodes.find((n) => n.key === nodeKey);
      if (!node) {
        res.status(404).json({ error: `Node "${nodeKey}" not found in plan.` });
        return;
      }

      clearLogicalNodeState(plan, node);
      savePersistedPlan(projectId, plan);

      console.log(`[studio-api] node/cancel: force-cleared "${nodeKey}" back to not-started for project "${projectId}".`);
      res.json(enrichPlanForResponse(plan));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId/provisioning/steps/:stepKey/secrets
  // Returns metadata describing every vault-stored secret a step uploads to a
  // third-party (e.g. EXPO_TOKEN to GitHub repo secrets). No plaintext is
  // returned — only `present` and `length` so the UI can show whether the
  // value is available before offering a "Copy" button.
  // -------------------------------------------------------------------------
  router.get(
    '/projects/:projectId/provisioning/steps/:stepKey/secrets',
    (req: Request, res: Response) => {
      const { projectId, stepKey } = req.params;
      const descriptors = getStepSecretDescriptors(stepKey);
      if (descriptors.length === 0) {
        res.json({ stepKey, secrets: [] });
        return;
      }

      const passphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
      if (!passphrase) {
        res.status(500).json({
          error:
            'STUDIO_VAULT_PASSPHRASE is not configured; cannot inspect vault-stored secrets.',
        });
        return;
      }

      const statuses = readStepSecretStatuses(vaultManager, passphrase, stepKey, projectId);
      res.json({ stepKey, secrets: statuses });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/provisioning/steps/:stepKey/secrets/:secretName/reveal
  // Returns the plaintext value of a single vault-stored secret so the user
  // can copy it (e.g. to verify what was uploaded to GitHub Actions, or paste
  // into a local `eas whoami` to debug a "bearer token is invalid" error).
  // POST is used (not GET) to keep the value out of browser/proxy caches.
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/provisioning/steps/:stepKey/secrets/:secretName/reveal',
    (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const { projectId, stepKey, secretName } = req.params;
      const descriptor = findStepSecretDescriptor(stepKey, secretName);
      if (!descriptor) {
        res.status(404).json({
          error: `Step "${stepKey}" does not declare an uploadable secret named "${secretName}".`,
        });
        return;
      }

      const passphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
      if (!passphrase) {
        res.status(500).json({
          error: 'STUDIO_VAULT_PASSPHRASE is not configured; cannot decrypt the vault.',
        });
        return;
      }

      const value = readStepSecretValue(vaultManager, passphrase, descriptor, projectId);
      if (value === null || value.length === 0) {
        res.status(404).json({
          error: `No vault entry stored for ${descriptor.label}. Connect the source integration first.`,
        });
        return;
      }

      res.json({
        stepKey,
        name: descriptor.name,
        label: descriptor.label,
        contentType: descriptor.contentType,
        destination: descriptor.destination,
        value,
        length: value.length,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/provisioning/plan/node/reset/manual-complete
  // Marks a previously manual-gated revert as complete by clearing node/dependents.
  // Body: { nodeKey: string }
  // -------------------------------------------------------------------------
  router.post('/projects/:projectId/provisioning/plan/node/reset/manual-complete', (req: Request, res: Response) => {
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
        res.status(409).json({ error: 'Wait for in-progress provisioning to finish before finalizing manual revert.' });
        return;
      }

      const node = plan.nodes.find((n) => n.key === nodeKey);
      if (!node) {
        res.status(404).json({ error: `Unknown node "${nodeKey}".` });
        return;
      }

      const dependents = collectDependentNodeKeys(nodeKey, plan.nodes);
      clearLogicalNodeState(plan, node);
      for (const depKey of dependents) {
        const depNode = plan.nodes.find((x) => x.key === depKey);
        if (depNode) clearLogicalNodeState(plan, depNode);
      }

      savePersistedPlan(projectId, plan);
      res.json(enrichPlanForResponse(plan));
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
      res.json(enrichPlanForResponse(plan));
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
          plan: enrichPlanForResponse(plan),
        });
        return;
      }

      if (node.direction === 'teardown') {
        res.json({
          supported: false,
          message: 'Teardown steps are not revalidated from here.',
          plan: enrichPlanForResponse(plan),
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
        repo_name: projectResourceSlug(projModule.project),
        branch_protection_rules: defaultBranchRules,
        environments: (plan.environments as Array<'development' | 'preview' | 'production'>),
        workflow_templates: buildGitHubWorkflowTemplates(plan),
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
      const providerConfigsByProvider = new Map<string, ProviderConfig>();
      if (githubToken) {
        providerConfigsByProvider.set('github', githubManifestConfig);
        registry.register('github', new GitHubAdapter(new HttpGitHubApiClient(githubToken)));
      }
      const expoTokenForRevalidate = easConnectionService.getStoredExpoToken();
      if (planUsesEasProvider(plan) && expoTokenForRevalidate) {
        const ghForEas = githubToken ? new HttpGitHubApiClient(githubToken) : undefined;
        providerConfigsByProvider.set('eas', buildEasManifestConfig(projectManager, projectId, plan));
        registry.register(
          'eas',
          new EasAdapter(new ExpoGraphqlEasApiClient(expoTokenForRevalidate), undefined, ghForEas),
        );
      }
      if (planUsesAppleProvider(plan)) {
        providerConfigsByProvider.set('apple', buildAppleManifestConfig(projectId, plan));
        registry.register('apple', new AppleAdapter());
      }
      if (planUsesCloudflareProvider(plan)) {
        providerConfigsByProvider.set('cloudflare', buildCloudflareManifestConfig(projectId));
        registry.register('cloudflare', buildCloudflareAdapter(projectId));
      }
      if (planUsesOauthProvider(plan)) {
        providerConfigsByProvider.set('oauth', buildOauthManifestConfig(projectId, plan));
        registry.register(
          'oauth',
          new OAuthAdapter(
            new StudioOAuthApiClient((studioProjectId, reason) =>
              gcpConnectionService.getAccessToken(studioProjectId, reason),
            ),
          ),
        );
      }

      if (node.provider === 'eas' && !stepHandler && !expoTokenForRevalidate) {
        res.status(400).json({
          error: 'Expo / EAS is not connected. Add an Expo access token before revalidating EAS steps.',
        });
        return;
      }

      if (!stepHandler && !registry.hasAdapter(node.provider)) {
        res.json({
          supported: false,
          message: `Provider "${node.provider}" has no revalidation hook in Studio yet.`,
          plan: enrichPlanForResponse(plan),
        });
        return;
      }

      const adapter = stepHandler ? null : registry.getAdapter(node.provider);
      if (!stepHandler && (!adapter || !adapter.checkStep)) {
        res.json({
          supported: false,
          message: `Step checks are not implemented for provider "${node.provider}".`,
          plan: enrichPlanForResponse(plan),
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
      applyProjectDomainToUpstreamArtifacts(upstream, projectManager.getProject(projectId).project);

      const results: Array<{ environment?: string; stillValid: boolean }> = [];
      const targetItems = sequentialExecutionItems.filter((i) => i.nodeKey === nodeKey);
      let checked = 0;

      const vaultPassphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim() ?? '';

      for (const item of targetItems) {
        const stateKey = item.environment ? `${nodeKey}@${item.environment}` : nodeKey;
        const existing = plan.nodeStates.get(stateKey);
        if (existing?.status === 'in-progress' || existing?.status === 'waiting-on-user') continue;

        const context: StepContext = {
          projectId,
          environment: item.environment ?? 'global',
          upstreamResources: { ...upstream, ...(existing?.userInputs ?? {}) },
          vaultRead,
          vaultWrite: async () => { },
        };

        const configForProvider = providerConfigsByProvider.get(node.provider) ?? ({} as ProviderConfig);

        try {
          let stillValid = false;
          let resourcesProduced: Record<string, string> | undefined;

          if (stepHandler) {
            // Use StepHandlerRegistry for Firebase and other registered steps.
            // Try sync first so handlers can discover/link existing resources
            // before strict validation (e.g. existing GCP project not yet in vault).
            const handlerContext = {
              projectId,
              environment: item.environment,
              upstreamArtifacts: { ...upstream },
              userInputs: existing?.userInputs,
              getToken: async (providerId: string) => {
                if (providerId === 'gcp') return gcpConnectionService.getAccessToken(projectId, `revalidate:${nodeKey}`);
                throw new Error(`No token provider for "${providerId}".`);
              },
              hasToken: (providerId: string) => providerId === 'gcp' ? gcpConnectionService.hasStoredUserOAuthRefreshToken(projectId) : false,
              vaultManager,
              passphrase: vaultPassphrase,
              projectManager,
            };
            let handlerResult = await stepHandler.sync(handlerContext);
            if (handlerResult === null) {
              handlerResult = await stepHandler.validate(handlerContext);
            }
            if (!handlerResult.reconciled && handlerResult.suggestsReauth) {
              savePersistedPlan(projectId, plan);
              const oauthResult = await gcpConnectionService.startProjectOAuthFlow(projectId);
              console.log(
                `[studio-api] plan/revalidate: Step "${nodeKey}" requires re-auth — started OAuth session ${oauthResult.sessionId}`,
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
              ...(existing?.userInputs ? { userInputs: existing.userInputs } : {}),
            });
            if (resourcesProduced) Object.assign(upstream, resourcesProduced);
            results.push({ environment: item.environment, stillValid: true });
          } else {
            plan.nodeStates.set(stateKey, {
              nodeKey,
              status: 'not-started',
              environment: item.environment,
              ...(existing?.userInputs ? { userInputs: existing.userInputs } : {}),
            });
            results.push({ environment: item.environment, stillValid: false });
          }
        } catch {
          checked++;
          plan.nodeStates.set(stateKey, {
            nodeKey,
            status: 'not-started',
            environment: item.environment,
            ...(existing?.userInputs ? { userInputs: existing.userInputs } : {}),
          });
          results.push({ environment: item.environment, stillValid: false });
        }
      }

      if (checked === 0) {
        res.json({
          supported: true,
          message: 'No checkable instances of this step found.',
          results: [],
          plan: enrichPlanForResponse(plan),
        });
        return;
      }

      savePersistedPlan(projectId, plan);
      res.json({
        supported: true,
        results,
        plan: enrichPlanForResponse(plan),
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
  // Firebase graph steps use GcpConnectionService live checks; other
  // StepHandler-registered steps (e.g. eas:create-project) use handler sync/validate.
  // Responds after sync finishes and the plan is saved so clients can GET an up-to-date plan.
  // -------------------------------------------------------------------------
  router.post('/projects/:projectId/provisioning/plan/sync', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const _module = projectManager.getProject(projectId);

      let plan = loadPersistedPlan(projectId);
      if (!plan) {
        const environments = normalizeExpoEnvironments(_module.project.environments);
        const providers: ProviderType[] = ['firebase', 'github', 'eas'];
        plan = buildProvisioningPlan(
          projectId,
          providers,
          environments,
          undefined,
          _module.project.platforms ?? [],
        );
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
      // Register the GitHub adapter only when a token is available and still valid.
      let githubToken = gitHubConnectionService.getStoredGitHubToken();
      let githubAuthFailureMessage: string | null = null;
      if (githubToken) {
        try {
          await gitHubConnectionService.syncGitHubIntegrationFromCredentialStore();
        } catch (err) {
          const error = err as Error;
          if (isGitHubAuthFailure(error)) {
            githubAuthFailureMessage = error.message;
            gitHubConnectionService.disconnect();
            githubToken = undefined;
            console.warn(
              `[studio-api] plan/sync: cleared invalid GitHub PAT after auth failure: ${error.message}`,
            );
          } else {
            throw error;
          }
        }
      }
      logStudioApiAction('provisioning/plan/sync POST', {
        projectId,
        phase: 'start',
        githubTokenPresent: !!githubToken,
        githubAuthFailure: githubAuthFailureMessage ? 'cleared-invalid-token' : 'none',
        ...summarizeProvisionPlanForLog(plan),
      });

      const registry = new ProviderRegistry();
      const providerConfigsByProvider = new Map<string, ProviderConfig>();
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
          repo_name: projectResourceSlug(_module.project),
          branch_protection_rules: [
            { branch: 'main', require_reviews: true, dismiss_stale_reviews: true, require_status_checks: true },
            { branch: 'develop', require_reviews: false, dismiss_stale_reviews: false, require_status_checks: true },
          ],
          environments: plan.environments as Array<'development' | 'preview' | 'production'>,
          workflow_templates: buildGitHubWorkflowTemplates(plan),
        };
        providerConfigsByProvider.set('github', githubManifestConfig);
        registry.register('github', new GitHubAdapter(new HttpGitHubApiClient(githubToken)));
      }
      if (planUsesAppleProvider(plan)) {
        const appleConfig = buildAppleManifestConfig(projectId, plan);
        providerConfigsByProvider.set('apple', appleConfig);
        registry.register('apple', new AppleAdapter());
      }
      if (planUsesCloudflareProvider(plan)) {
        const cloudflareConfig = buildCloudflareManifestConfig(projectId);
        providerConfigsByProvider.set('cloudflare', cloudflareConfig);
        registry.register('cloudflare', buildCloudflareAdapter(projectId));
      }
      if (planUsesOauthProvider(plan)) {
        const oauthConfig = buildOauthManifestConfig(projectId, plan);
        providerConfigsByProvider.set('oauth', oauthConfig);
        registry.register(
          'oauth',
          new OAuthAdapter(
            new StudioOAuthApiClient((studioProjectId, reason) =>
              gcpConnectionService.getAccessToken(studioProjectId, reason),
            ),
          ),
        );
      }

      const vaultRead = createVaultReader(vaultManager);

      // Resolve credential gates before sync — uses the same resolver the
      // orchestrator would use so gate resolution logic lives in one place.
      const syncGateResolver = buildProvisioningGateResolver({
        gcpConnectionService,
        easConnectionService,
        getGitHubToken: () => gitHubConnectionService.getStoredGitHubToken(),
        getCloudflareToken: (id) => getCloudflareTokenForProject(id),
        checkCloudflareZoneOwnership: checkCloudflareZoneOwnershipForContext,
        checkExpoGitHubInstall: checkExpoGitHubInstallForContext,
      });

      const gateNodeKeys = plan.nodes
        .filter((n) => n.type === 'user-action')
        .map((n) => n.key);
      const gateUpstream = collectCompletedUpstreamArtifacts(plan);
      applyProjectDomainToUpstreamArtifacts(gateUpstream, projectManager.getProject(projectId).project);
      for (const nodeKey of gateNodeKeys) {
        const existing = plan.nodeStates.get(nodeKey);
        const alwaysRecheck = nodeKey === 'user:install-expo-github-app';
        if (existing?.status === 'completed' && !alwaysRecheck) continue;
        try {
          const gateResult = await syncGateResolver.canResolve(nodeKey, {
            projectId,
            environment: 'global',
            upstreamResources: { ...gateUpstream },
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
            Object.assign(gateUpstream, gateResult.resourcesProduced);
          } else if (alwaysRecheck && existing?.status === 'completed') {
            plan.nodeStates.set(nodeKey, {
              nodeKey,
              status: 'not-started',
              ...(existing?.userInputs ? { userInputs: existing.userInputs } : {}),
            });
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

        const upstreamResources: Record<string, string> = {
          ...buildInitialUpstreamSeed(
            projectManager.getProject(projectId).project,
            projectManager.getOrganization(),
          ),
        };
        const failedNodeKeys = new Set<string>();

        for (const group of executionGroups) {
          for (const item of group.items) {
            const node = currentPlan.nodes.find((n) => n.key === item.nodeKey);
            if (!node) continue;

            const stateKey = item.environment ? `${item.nodeKey}@${item.environment}` : item.nodeKey;
            const baseStepKey = item.nodeKey.includes('@') ? item.nodeKey.split('@')[0]! : item.nodeKey;

            const existingState = currentPlan.nodeStates.get(stateKey);
            // Firebase steps and any other StepHandler-backed step are re-validated against live APIs.
            const isFirebaseStep = node.provider === 'firebase' && node.type === 'step';
            const stepHasHandler = node.type === 'step' && globalStepHandlerRegistry.has(baseStepKey);
            const adapterCanCheck =
              node.type === 'step' &&
              registry.hasAdapter(node.provider) &&
              !!registry.getAdapter(node.provider).checkStep;
            if (existingState?.status === 'completed' && !isFirebaseStep && !stepHasHandler && !adapterCanCheck) {
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

            // StepHandler-registered steps (Firebase, EAS create-project, …) always attempt sync
            // regardless of upstream gate status — sync discovers real-world state.
            const isHandlerBacked = node.type === 'step' && globalStepHandlerRegistry.has(baseStepKey);

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
                  ...(existingState?.userInputs ? { userInputs: existingState.userInputs } : {}),
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
                    ...(existingState?.userInputs ? { userInputs: existingState.userInputs } : {}),
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
                    ...(existingState?.userInputs ? { userInputs: existingState.userInputs } : {}),
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

            if (isHandlerBacked && node.provider !== 'firebase') {
              const handler = globalStepHandlerRegistry.get(baseStepKey);
              if (handler) {
                const vaultPassphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim() ?? '';

                wsHandler.broadcastStepProgress(
                  projectId,
                  item.nodeKey,
                  'step',
                  'running',
                  item.environment,
                );

                const handlerContext = {
                  projectId: currentPlan.projectId,
                  environment: item.environment,
                  upstreamArtifacts: { ...upstreamResources },
                  userInputs: existingState?.userInputs,
                  getToken: async (providerId: string) => {
                    if (providerId === 'gcp') {
                      return gcpConnectionService.getAccessToken(currentPlan.projectId, `sync:${baseStepKey}`);
                    }
                    throw new Error(`No token provider for "${providerId}" in plan/sync for "${baseStepKey}".`);
                  },
                  hasToken: (providerId: string) =>
                    providerId === 'gcp'
                      ? gcpConnectionService.hasStoredUserOAuthRefreshToken(currentPlan.projectId)
                      : false,
                  vaultManager,
                  passphrase: vaultPassphrase,
                  projectManager,
                };

                try {
                  let handlerSync = await handler.sync(handlerContext);
                  if (handlerSync === null) {
                    handlerSync = await handler.validate(handlerContext);
                  }
                  const handlerMsg = handlerSync.reconciled
                    ? 'reconciled'
                    : `not matched — ${handlerSync.message ?? ''}`;
                  console.log(
                    `[studio-api] plan/sync StepHandler "${item.nodeKey}" (${projectId}): ${handlerMsg}`,
                  );
                  if (handlerSync.reconciled) {
                    const produced =
                      handlerSync.resourcesProduced ?? existingState?.resourcesProduced;
                    if (produced) Object.assign(upstreamResources, produced);
                    currentPlan.nodeStates.set(stateKey, {
                      nodeKey: item.nodeKey,
                      status: 'completed',
                      environment: item.environment,
                      completedAt: Date.now(),
                      resourcesProduced: produced,
                      ...(existingState?.userInputs ? { userInputs: existingState.userInputs } : {}),
                    });
                    wsHandler.broadcastStepProgress(
                      projectId,
                      item.nodeKey,
                      'step',
                      'success',
                      item.environment,
                      produced,
                    );
                  } else {
                    if (handlerSync.suggestsReauth) {
                      savePersistedPlan(projectId, currentPlan);
                      const oauthResult = await gcpConnectionService.startProjectOAuthFlow(currentPlan.projectId);
                      console.log(
                        `[studio-api] plan/sync: Step "${item.nodeKey}" requires re-auth — started OAuth session ${oauthResult.sessionId}`,
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
                      ...(existingState?.userInputs ? { userInputs: existingState.userInputs } : {}),
                    });
                    wsHandler.broadcastStepProgress(
                      projectId,
                      item.nodeKey,
                      'step',
                      'ready',
                      item.environment,
                    );
                  }
                } catch (handlerSyncErr) {
                  failedNodeKeys.add(item.nodeKey);
                  currentPlan.nodeStates.set(stateKey, {
                    nodeKey: item.nodeKey,
                    status: 'not-started',
                    environment: item.environment,
                    ...(existingState?.userInputs ? { userInputs: existingState.userInputs } : {}),
                  });
                  wsHandler.broadcastStepProgress(
                    projectId,
                    item.nodeKey,
                    'step',
                    'ready',
                    item.environment,
                  );
                  console.warn(
                    `[studio-api] plan/sync StepHandler "${item.nodeKey}" (${projectId}) threw: ${(handlerSyncErr as Error).message}`,
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

            const configForProvider = providerConfigsByProvider.get(node.provider);
            if (!configForProvider) {
              continue;
            }

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
                  ...(existingState?.userInputs ? { userInputs: existingState.userInputs } : {}),
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
                  error: result.error,
                  ...(existingState?.userInputs ? { userInputs: existingState.userInputs } : {}),
                });
                wsHandler.broadcastStepProgress(
                  projectId, item.nodeKey, 'step', 'ready',
                  item.environment, undefined, result.error,
                );
              }
            } catch {
              failedNodeKeys.add(item.nodeKey);
              currentPlan.nodeStates.set(stateKey, {
                nodeKey: item.nodeKey,
                status: 'not-started',
                environment: item.environment,
                error: 'Step sync check failed unexpectedly. Re-run provisioning for this step.',
                ...(existingState?.userInputs ? { userInputs: existingState.userInputs } : {}),
              });
              wsHandler.broadcastStepProgress(
                projectId, item.nodeKey, 'step', 'ready',
                item.environment, undefined, 'Step sync check failed unexpectedly. Re-run provisioning for this step.',
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

      logStudioApiAction('provisioning/plan/sync POST', {
        projectId,
        phase: 'complete',
        firebaseSyncSteps: firebaseResults.length,
        firebaseResults: firebaseResults.map((r) => ({
          nodeKey: r.nodeKey,
          reconciled: r.reconciled,
          message: r.message.length > 300 ? `${r.message.slice(0, 300)}…` : r.message,
        })),
        ...summarizeProvisionPlanForLog(currentPlan),
      });
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
  // POST /api/projects/:projectId/credentials/:credentialType
  // Body: { value?: string, file_base64?: string, metadata?: object }
  // Validates and stores a credential for the project. Returns summary (no plaintext).
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/credentials/:credentialType',
    (req: Request, res: Response) => {
      try {
        const { projectId, credentialType } = req.params;
        const allowedTypes: CredentialType[] = [
          'github_pat', 'cloudflare_token', 'apple_p8', 'apple_team_id',
          'google_play_key', 'expo_token', 'domain_name',
        ];
        if (!allowedTypes.includes(credentialType as CredentialType)) {
          res.status(400).json({
            error: `Unsupported credential type "${credentialType}". Allowed: ${allowedTypes.join(', ')}`,
          });
          return;
        }

        const type = credentialType as CredentialType;
        const rawValue = req.body?.value as string | undefined;
        const fileBase64 = req.body?.file_base64 as string | undefined;
        const extraMetadata = req.body?.metadata as Record<string, unknown> | undefined;

        let value = rawValue ?? '';
        let fileBuffer: Buffer | undefined;

        if (fileBase64) {
          try {
            fileBuffer = Buffer.from(fileBase64, 'base64');
            if (fileBuffer.length > 10 * 1024) {
              res.status(400).json({ error: 'File size must not exceed 10KB.' });
              return;
            }
            value = fileBase64;
          } catch {
            res.status(400).json({ error: 'file_base64 must be valid base64.' });
            return;
          }
        }

        if (!value && !fileBuffer) {
          res.status(400).json({ error: 'Either value or file_base64 is required.' });
          return;
        }

        const validationResult = validateByType(type, value, fileBuffer);

        const stored = credentialService.storeCredential({
          project_id: projectId,
          credential_type: type,
          value,
          metadata: { ...validationResult.metadata, ...(extraMetadata ?? {}) },
        });

        res.status(201).json({
          credential_id: stored.id,
          type: stored.credential_type,
          validated_at: new Date(stored.created_at).toISOString(),
          metadata: stored.metadata,
        });
      } catch (err) {
        const message = (err as Error).message;
        const errName = (err as Error).name;
        if (errName === 'CredentialError') {
          res.status(400).json({ error: message });
          return;
        }
        res.status(500).json({ error: message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId/credentials
  // Returns summaries (no plaintext) of all active credentials.
  // -------------------------------------------------------------------------
  router.get('/projects/:projectId/credentials', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const credentials = credentialService.listCredentials(projectId);
      res.json({ credentials });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/projects/:projectId/credentials/:credentialId
  // Soft-deletes a credential record.
  // -------------------------------------------------------------------------
  router.delete('/projects/:projectId/credentials/:credentialId', (req: Request, res: Response) => {
    try {
      const { credentialId } = req.params;
      credentialService.deleteCredential(credentialId);
      res.json({ success: true, credential_id: credentialId });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/credentials/retry/:credentialType
  // Re-uploads and re-validates a credential, replacing the existing active one.
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/credentials/retry/:credentialType',
    (req: Request, res: Response) => {
      try {
        const { projectId, credentialType } = req.params;
        const type = credentialType as CredentialType;
        const rawValue = req.body?.value as string | undefined;
        const fileBase64 = req.body?.file_base64 as string | undefined;

        let value = rawValue ?? '';
        let fileBuffer: Buffer | undefined;

        if (fileBase64) {
          fileBuffer = Buffer.from(fileBase64, 'base64');
          if (fileBuffer.length > 10 * 1024) {
            res.status(400).json({ error: 'File size must not exceed 10KB.' });
            return;
          }
          value = fileBase64;
        }

        if (!value) {
          res.status(400).json({ error: 'Either value or file_base64 is required.' });
          return;
        }

        const validationResult = validateByType(type, value, fileBuffer);

        const stored = credentialService.storeCredential({
          project_id: projectId,
          credential_type: type,
          value,
          metadata: validationResult.metadata,
        });

        res.json({
          credential_id: stored.id,
          type: stored.credential_type,
          retried_at: new Date(stored.created_at).toISOString(),
          metadata: stored.metadata,
        });
      } catch (err) {
        const message = (err as Error).message;
        if ((err as Error).name === 'CredentialError') {
          res.status(400).json({ error: message });
          return;
        }
        res.status(500).json({ error: message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId/provisioning/credential-check
  // Query: { step_types } (comma-separated)
  // Validates credentials for the given step types. Returns 200 if all ok,
  // 409 with missing_by_step map if any are missing.
  // -------------------------------------------------------------------------
  router.get(
    '/projects/:projectId/provisioning/credential-check',
    (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const stepTypesParam = req.query['step_types'] as string | undefined;
        const stepTypes = stepTypesParam ? stepTypesParam.split(',').map((s) => s.trim()) : [];

        if (stepTypes.length === 0) {
          res.json({ valid: true, missing_by_step: {} });
          return;
        }

        const missingByStep = credentialRetrievalService.analyzeMissingCredentialsForPlan(
          projectId,
          stepTypes,
        );

        if (Object.keys(missingByStep).length === 0) {
          res.json({ valid: true, missing_by_step: {} });
        } else {
          res.status(409).json({
            valid: false,
            missing_by_step: missingByStep,
            message: `Missing credentials for ${Object.keys(missingByStep).length} step(s).`,
          });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
          return;
        }
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // =========================================================================
  // Guided Flows
  // =========================================================================

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/guided-flows
  // Body: { flow_type: 'apple_signing' | 'google_play' }
  // Initializes a guided flow for the project.
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/guided-flows',
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const flowType = req.body?.flow_type as GuidedFlowType | undefined;
        if (!flowType || !['apple_signing', 'google_play'].includes(flowType)) {
          res.status(400).json({ error: 'flow_type must be "apple_signing" or "google_play".' });
          return;
        }
        const flow = await guidedFlowService.initializeFlow(flowType, projectId);
        res.status(201).json(flow);
      } catch (err) {
        const message = (err as Error).message;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: `Project "${req.params.projectId}" not found.` });
          return;
        }
        res.status(500).json({ error: `Failed to initialize guided flow: ${message}` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:projectId/guided-flows/:flowId
  // Returns current flow state with all steps.
  // -------------------------------------------------------------------------
  router.get(
    '/projects/:projectId/guided-flows/:flowId',
    (req: Request, res: Response) => {
      try {
        const { flowId } = req.params;
        const flow = guidedFlowService.getFlowWithSteps(flowId);
        res.json(flow);
      } catch (err) {
        const message = (err as Error).message;
        if (err instanceof GuidedFlowError && err.code === 'FLOW_NOT_FOUND') {
          res.status(404).json({ error: message });
          return;
        }
        res.status(500).json({ error: message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/guided-flows/:flowId/steps/:stepId/complete
  // Body: { metadata?: object }
  // Marks a step as completed and unblocks dependent steps.
  // -------------------------------------------------------------------------
  router.post(
    '/guided-flows/:flowId/steps/:stepId/complete',
    async (req: Request, res: Response) => {
      try {
        const { stepId } = req.params;
        const metadata = req.body?.metadata as Record<string, unknown> | undefined;
        const updated = await guidedFlowService.completeStep(stepId, metadata);
        res.json(updated);
      } catch (err) {
        const message = (err as Error).message;
        if (err instanceof GuidedFlowError) {
          if (err.code === 'STEP_NOT_FOUND') {
            res.status(404).json({ error: message });
            return;
          }
          if (err.code === 'STEP_BLOCKED') {
            res.status(409).json({ error: message, context: err.context });
            return;
          }
        }
        res.status(500).json({ error: message });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/guided-flows/:flowId/steps/:stepId/upload
  // Body: { file_base64, file_name, key_id?, team_id?, project_id }
  // Validates and stores a file upload for a step.
  // -------------------------------------------------------------------------
  router.post(
    '/guided-flows/:flowId/steps/:stepId/upload',
    async (req: Request, res: Response) => {
      try {
        const { stepId } = req.params;
        const {
          file_base64,
          file_name,
          key_id,
          team_id,
          project_id,
          upload_type,
        } = req.body as {
          file_base64?: string;
          file_name?: string;
          key_id?: string;
          team_id?: string;
          project_id?: string;
          upload_type?: string;
        };

        if (!file_base64 || !file_name) {
          res.status(400).json({ error: 'file_base64 and file_name are required.' });
          return;
        }

        let fileBuffer: Buffer;
        try {
          fileBuffer = Buffer.from(file_base64, 'base64');
        } catch {
          res.status(400).json({ error: 'file_base64 must be valid base64.' });
          return;
        }

        if (fileBuffer.length > 10 * 1024) {
          res.status(400).json({ error: 'File size must not exceed 10KB.' });
          return;
        }

        let result: Record<string, unknown>;

        if (upload_type === 'apple_p8' && key_id && team_id) {
          result = await appleSigningHandler.handleP8Upload(
            stepId, fileBuffer, file_name, key_id, team_id,
          );
        } else if (upload_type === 'google_play_service_account' && project_id) {
          result = await googlePlayHandler.handleServiceAccountUpload(
            stepId, project_id, fileBuffer, file_name,
          );
        } else {
          const upload = await guidedFlowService.recordFileUpload(
            stepId, file_name, 'application/octet-stream', fileBuffer, 'valid',
          );
          result = { upload_id: upload.id, file_hash: upload.file_hash };
        }

        res.status(201).json(result);
      } catch (err) {
        const message = (err as Error).message;
        if (
          (err as Error).name === 'CredentialError' ||
          (err instanceof GuidedFlowError && err.code === 'STEP_NOT_FOUND')
        ) {
          res.status(400).json({ error: message });
          return;
        }
        res.status(500).json({ error: `Upload failed: ${message}` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/guided-flows/:flowId/steps/:stepId/upload/:uploadId
  // Returns the validation status of a file upload.
  // -------------------------------------------------------------------------
  router.get(
    '/guided-flows/:flowId/steps/:stepId/upload/:uploadId',
    (req: Request, res: Response) => {
      try {
        const { uploadId } = req.params;
        const upload = guidedFlowService.getUpload(uploadId);
        if (!upload) {
          res.status(404).json({ error: `Upload "${uploadId}" not found.` });
          return;
        }
        const { encrypted_file_path: _encPath, ...publicUpload } = upload;
        res.json(publicUpload);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

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
