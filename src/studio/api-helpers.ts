/**
 * Shared helpers for Structure API routes.
 *
 * Extracted to eliminate repeated boilerplate across plan/run, plan/sync,
 * plan/node/reset, teardown/run, and revalidate routes.
 */

import type { ProjectManager } from './project-manager.js';
import { projectResourceSlug } from './project-identity.js';
import type {
  GitHubManifestConfig,
  EasManifestConfig,
  BranchProtectionRule,
  ProviderManifest,
  ProviderConfig,
  StepContext,
} from '../providers/types.js';
import { PLATFORM_CORE_VERSION } from '../providers/types.js';
import type { ProvisioningPlan } from '../provisioning/graph.types.js';
import type { CredentialService, CredentialType } from '../services/credential-service.js';
import { resolveDeployContractFromInputs } from './deploy-contract.js';

// ---------------------------------------------------------------------------
// Vault-key to CredentialType mapping (used by legacy StepContext.vaultRead)
// ---------------------------------------------------------------------------

export function vaultKeyToCredentialLookup(
  providerId: string,
  key: string,
  projectId: string,
): { projectId: string; credentialType: CredentialType } | null {
  if (providerId === 'github') {
    const map: Record<string, CredentialType> = {
      token: 'github_pat',
      user_id: 'github_user_id',
      username: 'github_username',
      orgs: 'github_orgs',
      scopes: 'github_scopes',
      token_last_validated_at: 'github_validated_at',
    };
    const ct = map[key];
    if (ct) return { projectId: '__organization__', credentialType: ct };
    return null;
  }
  if (providerId === 'eas') {
    const map: Record<string, CredentialType> = {
      expo_token: 'expo_token',
      expo_username: 'expo_username',
      expo_user_id: 'expo_user_id',
      expo_accounts: 'expo_accounts',
    };
    const ct = map[key];
    if (ct) return { projectId: '__organization__', credentialType: ct };
    return null;
  }
  if (providerId === 'apple') {
    const map: Record<string, CredentialType> = {
      'apple/team_id': 'apple_team_id',
      'apple/asc_issuer_id': 'apple_asc_issuer_id',
      'apple/asc_api_key_id': 'apple_asc_api_key_id',
      'apple/asc_api_key_p8': 'apple_asc_api_key_p8',
    };
    const ct = map[key];
    if (ct) return { projectId: '__organization__', credentialType: ct };
    return null;
  }
  if (providerId === 'cloudflare') {
    return { projectId: '__organization__', credentialType: 'cloudflare_token' };
  }
  if (providerId === 'google-play') {
    return { projectId: '__organization__', credentialType: 'google_play_key' };
  }
  if (providerId === 'firebase') {
    const suffixMap: Record<string, CredentialType> = {
      gcp_project_id: 'gcp_project_id',
      service_account_email: 'gcp_service_account_email',
      service_account_json: 'gcp_service_account_json',
      connected_by_email: 'gcp_connected_by_email',
      connected_at: 'gcp_connected_at',
      gcp_oauth_refresh_token: 'gcp_oauth_refresh_token',
      api_key: 'firebase_api_key',
      firebase_ios_app_id: 'firebase_ios_app_id',
      firebase_android_app_id: 'firebase_android_app_id',
      firestore_database_id: 'firestore_database_id',
      firestore_location: 'firestore_location',
      apple_sign_in_key_id: 'apple_sign_in_key_id',
      apple_sign_in_service_id: 'apple_sign_in_service_id',
      apple_sign_in_p8: 'apple_sign_in_p8',
      apns_key_id: 'apns_key_id',
      apns_key_p8: 'apns_p8',
      apple_team_id: 'apple_team_id',
      asc_app_id: 'apple_asc_app_id',
      'apple/auth-keys': 'apple_auth_keys_registry',
    };
    // key may be "{projectId}/{suffix}" or just "{suffix}"
    const slashIdx = key.indexOf('/');
    if (slashIdx !== -1) {
      const prefix = key.slice(0, slashIdx);
      const suffix = key.slice(slashIdx + 1);
      const ct = suffixMap[suffix];
      if (ct) return { projectId: prefix, credentialType: ct };
      // apple/auth-keys has a nested slash
      const fullSuffix = suffix;
      const ct2 = suffixMap[`${suffix}`];
      if (ct2) return { projectId: prefix, credentialType: ct2 };
    }
    const ct = suffixMap[key];
    if (ct) return { projectId, credentialType: ct };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Vault reader / writer — now backed by CredentialService
// ---------------------------------------------------------------------------

/**
 * Build a cross-provider vault reader for use in StepContext.vaultRead.
 * Routes through CredentialService (SQLite) after vault migration.
 */
export function createVaultReader(
  credentialService: CredentialService,
  projectId: string,
): (key: string) => Promise<string | null> {
  return async (key: string): Promise<string | null> => {
    try {
      // Try looking up firebase-namespaced key (most common use case for StepContext)
      const lookup = vaultKeyToCredentialLookup('firebase', key, projectId);
      if (lookup) {
        return credentialService.retrieveCredential(lookup.projectId, lookup.credentialType) ?? null;
      }
      return null;
    } catch {
      return null;
    }
  };
}

export function createVaultWriter(
  credentialService: CredentialService,
  projectId: string,
  _providerId = 'firebase',
): (key: string, value: string) => Promise<void> {
  return async (key: string, value: string): Promise<void> => {
    const lookup = vaultKeyToCredentialLookup('firebase', key, projectId);
    if (!lookup) return;
    credentialService.storeCredential({
      project_id: lookup.projectId,
      credential_type: lookup.credentialType,
      value,
    });
  };
}

// ---------------------------------------------------------------------------
// GitHub manifest builder
// ---------------------------------------------------------------------------

const DEFAULT_BRANCH_RULES: BranchProtectionRule[] = [
  { branch: 'main', require_reviews: true, dismiss_stale_reviews: true, require_status_checks: true },
  { branch: 'develop', require_reviews: false, dismiss_stale_reviews: false, require_status_checks: true },
];

export function buildGitHubManifestConfig(
  projectManager: ProjectManager,
  projectId: string,
  plan: ProvisioningPlan,
): GitHubManifestConfig {
  const module = projectManager.getProject(projectId);
  const org = projectManager.getOrganization();
  const orgGithubConfig = org.integrations.github?.config ?? {};
  const owner =
    module.project.githubOrg?.trim() ||
    orgGithubConfig['owner_default']?.trim() ||
    orgGithubConfig['username']?.trim() ||
    module.project.slug;

  return {
    provider: 'github',
    owner,
    repo_name: projectResourceSlug(module.project),
    branch_protection_rules: DEFAULT_BRANCH_RULES,
    environments: plan.environments as Array<'development' | 'preview' | 'production'>,
    workflow_templates: buildGitHubWorkflowTemplates(plan),
    deploy_contract: resolveDeployContractFromInputs(
      plan.nodeStates.get('github:deploy-workflows')?.userInputs,
    ),
  };
}

export function buildGitHubWorkflowTemplates(plan: ProvisioningPlan): string[] {
  const deployConfig = resolveGitHubDeployConfig(plan);
  const selectedTargets = resolveGitHubDeployTargets(plan);
  const supportedDestinations = resolveSupportedDestinationTargets(plan);
  const templates = new Set<string>();
  for (const target of selectedTargets) {
    if (target === 'mobile') {
      if (deployConfig.mobileStack !== 'expo') {
        throw new Error(
          `Unsupported mobile stack "${deployConfig.mobileStack}" for GitHub CI/CD. Supported values: expo.`,
        );
      }
      if (!planUsesEasProvider(plan)) {
        throw new Error(
          'The "mobile" CI/CD target requires EAS steps in the provisioning plan. ' +
          'Add the EAS module or remove "mobile" from Deploy Target Types.',
        );
      }
      templates.add('expo-testflight');
      continue;
    }
    if (target === 'web') {
      if (!supportedDestinations.supportsWebGcp) {
        throw new Error(
          'Web target was selected but no supported deployment destination is available from the current plan modules. ' +
          'Add a web deployment module (for example `gcp-serverless-web`) before generating CI/CD workflows.',
        );
      }
      if (deployConfig.webStack === 'react') {
        templates.add('web-gcp-react-delivery');
        continue;
      }
      if (deployConfig.webStack === 'nextjs') {
        templates.add('web-gcp-nextjs-delivery');
        continue;
      }
      throw new Error(
        `Unsupported web stack "${deployConfig.webStack}" for "${deployConfig.webDestination}". Supported values: ${GITHUB_WEB_STACKS.join(', ')}.`,
      );
    }
    if (target === 'api') {
      if (!supportedDestinations.supportsApiGcp) {
        throw new Error(
          'API target was selected but no supported deployment destination is available from the current plan modules. ' +
          'Add an API deployment module (for example `gcp-serverless-api`) before generating CI/CD workflows.',
        );
      }
      if (deployConfig.apiStack === 'node/express') {
        templates.add('api-gcp-node-delivery');
        continue;
      }
      if (deployConfig.apiStack === 'flask') {
        templates.add('api-gcp-flask-delivery');
        continue;
      }
      throw new Error(
        `Unsupported API stack "${deployConfig.apiStack}" for "${deployConfig.apiDestination}". Supported values: ${GITHUB_API_STACKS.join(', ')}.`,
      );
    }
  }
  return Array.from(templates);
}

type GitHubDeployTarget = 'mobile' | 'web' | 'api';
type GitHubMobileStack = 'expo';
type GitHubWebStack = 'react' | 'nextjs';
type GitHubApiStack = 'node/express' | 'flask';
type GitHubWebDestination = 'gcp-cloud-run';
type GitHubApiDestination = 'gcp-cloud-run';

const GITHUB_DEPLOY_TARGETS: readonly GitHubDeployTarget[] = ['mobile', 'web', 'api'] as const;
const GITHUB_MOBILE_STACKS: readonly GitHubMobileStack[] = ['expo'] as const;
const GITHUB_WEB_STACKS: readonly GitHubWebStack[] = ['react', 'nextjs'] as const;
const GITHUB_API_STACKS: readonly GitHubApiStack[] = ['node/express', 'flask'] as const;
const GITHUB_WEB_DESTINATIONS: readonly GitHubWebDestination[] = ['gcp-cloud-run'] as const;
const GITHUB_API_DESTINATIONS: readonly GitHubApiDestination[] = ['gcp-cloud-run'] as const;

function resolveGitHubDeployConfig(plan: ProvisioningPlan): {
  mobileStack: GitHubMobileStack;
  webStack: GitHubWebStack;
  apiStack: GitHubApiStack;
  webDestination: GitHubWebDestination;
  apiDestination: GitHubApiDestination;
} {
  const deployState = plan.nodeStates.get('github:deploy-workflows');
  return {
    mobileStack: parseStackInput(
      deployState?.userInputs?.['deploy_mobile_stack'],
      GITHUB_MOBILE_STACKS,
      'expo',
      'mobile',
    ),
    webStack: parseStackInput(
      deployState?.userInputs?.['deploy_web_stack'],
      GITHUB_WEB_STACKS,
      'react',
      'web',
    ),
    apiStack: parseStackInput(
      deployState?.userInputs?.['deploy_api_stack'],
      GITHUB_API_STACKS,
      'node/express',
      'api',
    ),
    webDestination: parseStackInput(
      deployState?.userInputs?.['deploy_web_destination'],
      GITHUB_WEB_DESTINATIONS,
      'gcp-cloud-run',
      'web deployment target',
    ),
    apiDestination: parseStackInput(
      deployState?.userInputs?.['deploy_api_destination'],
      GITHUB_API_DESTINATIONS,
      'gcp-cloud-run',
      'api deployment target',
    ),
  };
}

function resolveSupportedDestinationTargets(plan: ProvisioningPlan): {
  supportsWebGcp: boolean;
  supportsApiGcp: boolean;
} {
  const selectedModules = new Set((plan.selectedModules ?? []) as string[]);
  const hasGcpWebModule =
    selectedModules.has('gcp-serverless-web') || selectedModules.has('gcp-serverless-fullstack');
  const hasGcpApiModule =
    selectedModules.has('gcp-serverless-api') || selectedModules.has('gcp-serverless-fullstack');

  if (hasGcpWebModule || hasGcpApiModule) {
    return { supportsWebGcp: hasGcpWebModule, supportsApiGcp: hasGcpApiModule };
  }

  // Backward-compatible inference for older plans without selectedModules.
  const hasWebNodes = plan.nodes.some((node) => node.key.startsWith('web:'));
  const hasApiNodes = plan.nodes.some((node) => node.key.startsWith('api:'));
  return { supportsWebGcp: hasWebNodes, supportsApiGcp: hasApiNodes };
}

function parseStackInput<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  targetLabel: string,
): T {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return fallback;
  const allowedSet = new Set<string>(allowed);
  if (!allowedSet.has(normalized)) {
    throw new Error(
      `Unsupported ${targetLabel} stack "${raw}". Supported values: ${allowed.join(', ')}.`,
    );
  }
  return normalized as T;
}

function resolveGitHubDeployTargets(plan: ProvisioningPlan): GitHubDeployTarget[] {
  const configured = parseConfiguredGitHubDeployTargets(plan);
  if (configured.length > 0) return configured;
  return autoDetectGitHubDeployTargets(plan);
}

function parseConfiguredGitHubDeployTargets(plan: ProvisioningPlan): GitHubDeployTarget[] {
  const deployState = plan.nodeStates.get('github:deploy-workflows');
  const raw = deployState?.userInputs?.['deploy_target_types']?.trim();
  if (!raw) return [];
  const allowed = new Set<string>(GITHUB_DEPLOY_TARGETS);
  const targets = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part): part is GitHubDeployTarget => allowed.has(part));
  return Array.from(new Set(targets));
}

function autoDetectGitHubDeployTargets(plan: ProvisioningPlan): GitHubDeployTarget[] {
  const targets = new Set<GitHubDeployTarget>();
  if (planUsesEasProvider(plan)) {
    targets.add('mobile');
  }
  for (const node of plan.nodes) {
    if (node.key.startsWith('web:')) targets.add('web');
    if (node.key.startsWith('api:')) targets.add('api');
  }
  if (targets.size === 0) {
    targets.add(planUsesEasProvider(plan) ? 'mobile' : 'web');
  }
  return Array.from(targets);
}

export function buildFirebaseManifestConfig(
  projectManager: ProjectManager,
  projectId: string,
): import('../providers/types.js').FirebaseManifestConfig {
  const module = projectManager.getProject(projectId);
  return {
    provider: 'firebase',
    project_name: projectResourceSlug(module.project) || projectId,
    billing_account_id: '[connected via OAuth]',
    services: ['auth', 'firestore', 'storage', 'fcm'],
    environment: 'production',
  };
}

/** Returns true if any node in the plan uses the firebase provider. */
export function planUsesFirebase(plan: ProvisioningPlan): boolean {
  return plan.nodes.some((n) => n.provider === 'firebase');
}

/** True when the plan includes EAS automation steps (not only credential gates). */
export function planUsesEasProvider(plan: ProvisioningPlan): boolean {
  return plan.nodes.some((n) => n.type === 'step' && n.provider === 'eas');
}

export function buildEasManifestConfig(
  projectManager: ProjectManager,
  projectId: string,
  plan: ProvisioningPlan,
): EasManifestConfig {
  const module = projectManager.getProject(projectId);
  const orgSlug = module.project.easAccount?.trim();
  return {
    provider: 'eas',
    project_name: projectResourceSlug(module.project) || projectId,
    organization: orgSlug || undefined,
    environments: plan.environments as Array<'development' | 'preview' | 'production'>,
    bundle_id: module.project.bundleId?.trim() || undefined,
    android_package: module.project.bundleId?.trim() || undefined,
  };
}

export function buildProviderManifest(
  projectId: string,
  githubConfig: GitHubManifestConfig,
  firebaseConfig?: import('../providers/types.js').FirebaseManifestConfig,
): ProviderManifest {
  const providers: ProviderConfig[] = [githubConfig];
  if (firebaseConfig) providers.push(firebaseConfig);
  return { version: PLATFORM_CORE_VERSION, app_id: projectId, providers };
}

// ---------------------------------------------------------------------------
// Plan state mapping
// ---------------------------------------------------------------------------

type ProvisioningStepProgressStatus =
  | 'success'
  | 'failure'
  | 'waiting-on-user'
  | 'resolving'
  | 'skipped'
  | 'blocked'
  | 'running';

export function progressStatusToNodeStatus(status: ProvisioningStepProgressStatus): import('../provisioning/graph.types.js').NodeStatus {
  switch (status) {
    case 'success': return 'completed';
    case 'failure': return 'failed';
    case 'waiting-on-user': return 'waiting-on-user';
    case 'resolving': return 'resolving';
    case 'skipped': return 'skipped';
    case 'blocked': return 'blocked';
    default: return 'in-progress';
  }
}

/** Parse owner/repo from a GitHub HTTPS or git@ URL. */
export function parseGithubRepoUrl(url: string): { owner: string; repo: string } {
  const u = url.trim().replace(/\.git$/i, '');
  const m = u.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\/|$)/i);
  if (!m) {
    throw new Error(`Expected a github.com repository URL (https://github.com/owner/repo), got: ${url}`);
  }
  return { owner: m[1]!, repo: m[2]! };
}

/** Merge `resourcesProduced` from every completed node state (plan sync / verify helpers). */
export function collectCompletedUpstreamArtifacts(plan: ProvisioningPlan): Record<string, string> {
  const upstream: Record<string, string> = {};
  for (const st of plan.nodeStates.values()) {
    if (st.status === 'completed' && st.resourcesProduced) {
      Object.assign(upstream, st.resourcesProduced);
    }
  }
  return upstream;
}
