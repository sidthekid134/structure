/**
 * Shared helpers for Studio API routes.
 *
 * Extracted to eliminate repeated boilerplate across plan/run, plan/sync,
 * plan/node/reset, teardown/run, and revalidate routes.
 */

import type { VaultManager } from '../vault.js';
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

// ---------------------------------------------------------------------------
// Vault reader
// ---------------------------------------------------------------------------

/**
 * Build a cross-provider vault reader for use in StepContext.vaultRead.
 * Tries firebase → github → eas namespaces in order.
 */
export function createVaultReader(
  vaultManager: VaultManager,
): (key: string) => Promise<string | null> {
  return async (key: string): Promise<string | null> => {
    const passphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
    if (!passphrase) return null;
    try {
      const firebaseValue = vaultManager.getCredential(passphrase, 'firebase', key);
      if (firebaseValue) return firebaseValue;
      const githubValue = vaultManager.getCredential(passphrase, 'github', key);
      if (githubValue) return githubValue;
      const easValue = vaultManager.getCredential(passphrase, 'eas', key);
      if (easValue) return easValue;
      const appleValue = vaultManager.getCredential(passphrase, 'apple', key);
      if (appleValue) return appleValue;
      const oauthValue = vaultManager.getCredential(passphrase, 'oauth', key);
      if (oauthValue) return oauthValue;
      const cloudflareValue = vaultManager.getCredential(passphrase, 'cloudflare', key);
      if (cloudflareValue) return cloudflareValue;
      const googlePlayValue = vaultManager.getCredential(passphrase, 'google-play', key);
      return googlePlayValue ?? null;
    } catch {
      return null;
    }
  };
}

export function createVaultWriter(
  vaultManager: VaultManager,
  providerId = 'firebase',
): (key: string, value: string) => Promise<void> {
  return async (key: string, value: string): Promise<void> => {
    const passphrase = process.env['STUDIO_VAULT_PASSPHRASE']?.trim();
    if (!passphrase) {
      throw new Error('STUDIO_VAULT_PASSPHRASE is required to write provisioning credentials.');
    }
    vaultManager.setCredential(passphrase, providerId, key, value);
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
  };
}

export function buildGitHubWorkflowTemplates(plan: ProvisioningPlan): string[] {
  if (planUsesEasProvider(plan)) {
    // expo-testflight.yml already runs the EAS build (`eas build --platform
    // ios --profile production`) before submitting, so a separate generic
    // `build.yml` doing `npm run build` would be a redundant CI job.
    return ['expo-testflight'];
  }
  return ['build', 'deploy'];
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
