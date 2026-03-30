/**
 * Shared helpers for Studio API routes.
 *
 * Extracted to eliminate repeated boilerplate across plan/run, plan/sync,
 * plan/node/reset, teardown/run, and revalidate routes.
 */

import type { VaultManager } from '../vault.js';
import type { ProjectManager } from './project-manager.js';
import type {
  GitHubManifestConfig,
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
      return easValue ?? null;
    } catch {
      return null;
    }
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
    repo_name: module.project.slug,
    branch_protection_rules: DEFAULT_BRANCH_RULES,
    environments: plan.environments as Array<'dev' | 'preview' | 'prod'>,
    workflow_templates: ['build', 'deploy'],
  };
}

export function buildFirebaseManifestConfig(
  projectManager: ProjectManager,
  projectId: string,
): import('../providers/types.js').FirebaseManifestConfig {
  const module = projectManager.getProject(projectId);
  return {
    provider: 'firebase',
    project_name: module.project.slug || projectId,
    billing_account_id: '[connected via OAuth]',
    services: ['auth', 'firestore', 'storage', 'fcm'],
    environment: 'prod',
  };
}

/** Returns true if any node in the plan uses the firebase provider. */
export function planUsesFirebase(plan: ProvisioningPlan): boolean {
  return plan.nodes.some((n) => n.provider === 'firebase');
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
