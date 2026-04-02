/**
 * GitHub adapter — creates repositories with branch protection, secrets
 * injection, and CI/CD workflow deployment.
 *
 * Rate-limit handling: catches 403 responses from the GitHub API, reads
 * X-RateLimit-Reset, and retries after the appropriate delay.
 */

import * as crypto from 'crypto';
import { Octokit } from '@octokit/rest';
import _sodium from 'libsodium-wrappers';
import {
  ProviderAdapter,
  GitHubManifestConfig,
  BranchProtectionRule,
  ProviderState,
  DriftReport,
  DriftDifference,
  ReconcileDirection,
  AdapterError,
  Environment,
  StepContext,
  StepResult,
} from './types.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';

// ---------------------------------------------------------------------------
// API client interface
// ---------------------------------------------------------------------------

export interface GitHubRateLimitError {
  isRateLimit: boolean;
  resetAt: number; // Unix timestamp seconds
}

export interface GitHubApiClient {
  createRepo(owner: string, name: string): Promise<{ id: number; cloneUrl: string; defaultBranch: string }>;
  getRepo(owner: string, name: string): Promise<{ id: number; cloneUrl: string; defaultBranch: string } | null>;
  setBranchProtection(owner: string, repo: string, rule: BranchProtectionRule): Promise<void>;
  getBranchProtection(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<BranchProtectionRule | null>;
  createEnvironment(owner: string, repo: string, env: string): Promise<{ id: number }>;
  setEnvironmentSecret(
    owner: string,
    repo: string,
    env: string,
    secretName: string,
    secretValue: string,
  ): Promise<void>;
  listEnvironmentSecrets(owner: string, repo: string, env: string): Promise<string[]>;
  deployWorkflow(owner: string, repo: string, filename: string, content: string): Promise<void>;
  listWorkflows(owner: string, repo: string): Promise<string[]>;
  /** Repository-level Actions secret (not environment-scoped). */
  setRepositorySecret(owner: string, repo: string, secretName: string, secretValue: string): Promise<void>;
  /** Returns true if the named repository-level secret exists, false if absent. */
  hasRepositorySecret(owner: string, repo: string, secretName: string): Promise<boolean>;
  /** Deletes a repository-level Actions secret. Resolves without error if already absent. */
  deleteRepositorySecret(owner: string, repo: string, secretName: string): Promise<void>;
}

export class StubGitHubApiClient implements GitHubApiClient {
  async createRepo(
    owner: string,
    name: string,
  ): Promise<{ id: number; cloneUrl: string; defaultBranch: string }> {
    return {
      id: Math.floor(Math.random() * 1_000_000),
      cloneUrl: `https://github.com/${owner}/${name}.git`,
      defaultBranch: 'main',
    };
  }

  async getRepo(
    _owner: string,
    _name: string,
  ): Promise<{ id: number; cloneUrl: string; defaultBranch: string } | null> {
    return null;
  }

  async setBranchProtection(
    _owner: string,
    _repo: string,
    _rule: BranchProtectionRule,
  ): Promise<void> {}

  async getBranchProtection(
    _owner: string,
    _repo: string,
    _branch: string,
  ): Promise<BranchProtectionRule | null> {
    return null;
  }

  async createEnvironment(
    owner: string,
    repo: string,
    env: string,
  ): Promise<{ id: number }> {
    return { id: Math.floor(Math.random() * 1_000_000) };
  }

  async setEnvironmentSecret(
    _owner: string,
    _repo: string,
    _env: string,
    _secretName: string,
    _secretValue: string,
  ): Promise<void> {}

  async listEnvironmentSecrets(
    _owner: string,
    _repo: string,
    _env: string,
  ): Promise<string[]> {
    return [];
  }

  async deployWorkflow(
    _owner: string,
    _repo: string,
    _filename: string,
    _content: string,
  ): Promise<void> {}

  async listWorkflows(_owner: string, _repo: string): Promise<string[]> {
    return [];
  }

  async setRepositorySecret(
    _owner: string,
    _repo: string,
    _secretName: string,
    _secretValue: string,
  ): Promise<void> {}

  async hasRepositorySecret(
    _owner: string,
    _repo: string,
    _secretName: string,
  ): Promise<boolean> {
    return false;
  }

  async deleteRepositorySecret(
    _owner: string,
    _repo: string,
    _secretName: string,
  ): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Real HTTP client using Octokit
// ---------------------------------------------------------------------------

export class HttpGitHubApiClient implements GitHubApiClient {
  private readonly octokit: Octokit;
  private readonly repoIdCache = new Map<string, number>();

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  private async getRepoId(owner: string, repo: string): Promise<number> {
    const cacheKey = `${owner}/${repo}`;
    const cached = this.repoIdCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const { data } = await this.octokit.repos.get({ owner, repo });
    this.repoIdCache.set(cacheKey, data.id);
    return data.id;
  }

  async createRepo(owner: string, name: string): Promise<{ id: number; cloneUrl: string; defaultBranch: string }> {
    const existing = await this.getRepo(owner, name);
    if (existing) return existing;

    let response: Awaited<ReturnType<typeof this.octokit.repos.createForAuthenticatedUser>>;
    try {
      response = await this.octokit.repos.createInOrg({ org: owner, name, auto_init: true, private: true });
    } catch {
      response = await this.octokit.repos.createForAuthenticatedUser({ name, auto_init: true, private: true });
    }
    return {
      id: response.data.id,
      cloneUrl: response.data.clone_url,
      defaultBranch: response.data.default_branch ?? 'main',
    };
  }

  async getRepo(owner: string, name: string): Promise<{ id: number; cloneUrl: string; defaultBranch: string } | null> {
    try {
      const { data } = await this.octokit.repos.get({ owner, repo: name });
      return {
        id: data.id,
        cloneUrl: data.clone_url,
        defaultBranch: data.default_branch ?? 'main',
      };
    } catch {
      return null;
    }
  }

  async setBranchProtection(owner: string, repo: string, rule: BranchProtectionRule): Promise<void> {
    // Ensure the branch exists before applying protection rules.
    // A freshly auto-initialised repo only has the default branch (main),
    // so branches like 'develop' must be created from it first.
    try {
      await this.octokit.repos.getBranch({ owner, repo, branch: rule.branch });
    } catch {
      const { data: repoData } = await this.octokit.repos.get({ owner, repo });
      const { data: defaultRef } = await this.octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${repoData.default_branch}`,
      });
      await this.octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${rule.branch}`,
        sha: defaultRef.object.sha,
      });
    }

    await this.octokit.repos.updateBranchProtection({
      owner,
      repo,
      branch: rule.branch,
      required_status_checks: rule.require_status_checks ? { strict: true, contexts: [] } : null,
      enforce_admins: true,
      required_pull_request_reviews: rule.require_reviews
        ? { dismiss_stale_reviews: rule.dismiss_stale_reviews, required_approving_review_count: 1 }
        : null,
      restrictions: null,
    });
  }

  async getBranchProtection(owner: string, repo: string, branch: string): Promise<BranchProtectionRule | null> {
    try {
      const { data } = await this.octokit.repos.getBranchProtection({ owner, repo, branch });
      return {
        branch,
        require_reviews: !!(data.required_pull_request_reviews),
        dismiss_stale_reviews: !!(data.required_pull_request_reviews?.dismiss_stale_reviews),
        require_status_checks: !!(data.required_status_checks),
      };
    } catch {
      return null;
    }
  }

  async createEnvironment(owner: string, repo: string, env: string): Promise<{ id: number }> {
    const { data } = await this.octokit.repos.createOrUpdateEnvironment({
      owner,
      repo,
      environment_name: env,
    });
    return { id: data.id ?? 0 };
  }

  async setEnvironmentSecret(
    owner: string,
    repo: string,
    env: string,
    secretName: string,
    secretValue: string,
  ): Promise<void> {
    const repositoryId = await this.getRepoId(owner, repo);

    const { data: keyData } = await this.octokit.actions.getEnvironmentPublicKey({
      repository_id: repositoryId,
      environment_name: env,
    });

    const encryptedValue = await this.encryptSecret(keyData.key, secretValue);

    await this.octokit.actions.createOrUpdateEnvironmentSecret({
      repository_id: repositoryId,
      environment_name: env,
      secret_name: secretName,
      encrypted_value: encryptedValue,
      key_id: keyData.key_id,
    });
  }

  async listEnvironmentSecrets(owner: string, repo: string, env: string): Promise<string[]> {
    try {
      const repositoryId = await this.getRepoId(owner, repo);
      const { data } = await this.octokit.actions.listEnvironmentSecrets({
        repository_id: repositoryId,
        environment_name: env,
      });
      return data.secrets.map((s: { name: string }) => s.name);
    } catch {
      return [];
    }
  }

  async deployWorkflow(owner: string, repo: string, filename: string, content: string): Promise<void> {
    const filePath = `.github/workflows/${filename}`;
    const contentBase64 = Buffer.from(content, 'utf8').toString('base64');

    // Get existing SHA for update
    let sha: string | undefined;
    try {
      const { data } = await this.octokit.repos.getContent({ owner, repo, path: filePath });
      if (!Array.isArray(data) && data.type === 'file') {
        sha = data.sha;
      }
    } catch {
      // File does not exist yet — create it
    }

    await this.octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      message: sha ? `chore: update ${filename}` : `chore: add ${filename}`,
      content: contentBase64,
      ...(sha ? { sha } : {}),
    });
  }

  async listWorkflows(owner: string, repo: string): Promise<string[]> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner,
        repo,
        path: '.github/workflows',
      });
      if (Array.isArray(data)) {
        return data.map((f: { name: string }) => f.name);
      }
    } catch {
      // Directory does not exist
    }
    return [];
  }

  async setRepositorySecret(
    owner: string,
    repo: string,
    secretName: string,
    secretValue: string,
  ): Promise<void> {
    const { data: keyData } = await this.octokit.actions.getRepoPublicKey({
      owner,
      repo,
    });
    const encryptedValue = await this.encryptSecret(keyData.key, secretValue);
    await this.octokit.actions.createOrUpdateRepoSecret({
      owner,
      repo,
      secret_name: secretName,
      encrypted_value: encryptedValue,
      key_id: keyData.key_id,
    });
  }

  async hasRepositorySecret(owner: string, repo: string, secretName: string): Promise<boolean> {
    try {
      await this.octokit.actions.getRepoSecret({ owner, repo, secret_name: secretName });
      return true;
    } catch (err) {
      if ((err as { status?: number })?.status === 404) return false;
      throw err;
    }
  }

  async deleteRepositorySecret(owner: string, repo: string, secretName: string): Promise<void> {
    try {
      await this.octokit.actions.deleteRepoSecret({ owner, repo, secret_name: secretName });
    } catch (err) {
      if ((err as { status?: number })?.status === 404) return;
      throw err;
    }
  }

  /**
   * Encrypts a secret value using the repo's NaCl public key via libsodium sealed box.
   * GitHub requires secrets encrypted with crypto_box_seal before storing.
   */
  private async encryptSecret(publicKeyBase64: string, secretValue: string): Promise<string> {
    await _sodium.ready;
    const sodium = _sodium;

    const publicKey = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
    const messageBytes = sodium.from_string(secretValue);
    const encryptedBytes = sodium.crypto_box_seal(messageBytes, publicKey);
    return sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);
  }
}

// ---------------------------------------------------------------------------
// Workflow templates
// ---------------------------------------------------------------------------

function buildWorkflowTemplate(template: string, environments: Environment[]): string {
  const envList = environments.join(', ');
  switch (template) {
    case 'build':
      return `name: Build
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    environment: \${{ github.ref == 'refs/heads/main' && 'production' || 'development' }}
    # Environments: ${envList}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run build
`;
    case 'deploy':
      return `name: Deploy
on:
  push:
    branches: [main, develop]
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: \${{ github.ref == 'refs/heads/main' && 'production' || 'preview' }}
    # Environments: ${envList}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run deploy
    env:
      FIREBASE_SERVICE_ACCOUNT: \${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
      EAS_TOKEN: \${{ secrets.EAS_TOKEN }}
`;
    default:
      return `name: ${template}\non: [push]\njobs:\n  run:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`;
  }
}

// ---------------------------------------------------------------------------
// GitHub adapter
// ---------------------------------------------------------------------------

export class GitHubAdapter implements ProviderAdapter<GitHubManifestConfig> {
  private readonly log: ReturnType<typeof createOperationLogger>;
  private static readonly MAX_RETRIES = 4;

  constructor(
    private readonly apiClient: GitHubApiClient,
    loggingCallback?: LoggingCallback,
  ) {
    this.log = createOperationLogger('GitHubAdapter', loggingCallback);
  }

  // ---------------------------------------------------------------------------
  // provision()
  // ---------------------------------------------------------------------------

  async provision(config: GitHubManifestConfig): Promise<ProviderState> {
    this.log.info('Starting GitHub provisioning', {
      owner: config.owner,
      repo: config.repo_name,
    });

    const now = Date.now();
    const state: ProviderState = {
      provider_id: `github-${config.owner}-${config.repo_name}`,
      provider_type: 'github',
      resource_ids: {},
      config_hashes: { config: this.hashConfig(config) },
      credential_metadata: {},
      partially_complete: false,
      failed_steps: [],
      completed_steps: [],
      created_at: now,
      updated_at: now,
    };

    try {
      // Step 1: Create or reuse repository
      let repoId: number;
      let cloneUrl: string;

      const existing = config.existing_repo_id
        ? await this.apiClient.getRepo(config.owner, config.repo_name)
        : null;

      if (existing) {
        repoId = existing.id;
        cloneUrl = existing.cloneUrl;
        state.completed_steps.push('create_repo');
      } else {
        const repo = await this.withRateLimit(() =>
          this.apiClient.createRepo(config.owner, config.repo_name),
        );
        repoId = repo.id;
        cloneUrl = repo.cloneUrl;
        state.completed_steps.push('create_repo');
        this.log.info('GitHub repository created', { repoId, cloneUrl });
      }

      state.resource_ids['repo_id'] = String(repoId);
      state.resource_ids['clone_url'] = cloneUrl;

      // Step 2: Apply branch protection rules
      for (const rule of config.branch_protection_rules) {
        try {
          await this.withRateLimit(() =>
            this.apiClient.setBranchProtection(config.owner, config.repo_name, rule),
          );
          state.completed_steps.push(`branch_protection_${rule.branch}`);
          state.resource_ids[`branch_protection_${rule.branch}`] = 'enabled';
        } catch (err) {
          state.failed_steps.push(`branch_protection_${rule.branch}`);
          state.partially_complete = true;
          this.log.error('Failed to set branch protection', {
            branch: rule.branch,
            error: (err as Error).message,
          });
        }
      }

      // Step 3: Deploy workflows
      for (const template of config.workflow_templates) {
        try {
          const content = buildWorkflowTemplate(template, config.environments);
          await this.withRateLimit(() =>
            this.apiClient.deployWorkflow(
              config.owner,
              config.repo_name,
              `${template}.yml`,
              content,
            ),
          );
          state.completed_steps.push(`workflow_${template}`);
          state.resource_ids[`workflow_${template}`] = `${template}.yml`;
        } catch (err) {
          state.failed_steps.push(`workflow_${template}`);
          state.partially_complete = true;
          this.log.error('Failed to deploy workflow', {
            template,
            error: (err as Error).message,
          });
        }
      }

      state.updated_at = Date.now();
      this.log.info('GitHub provisioning complete', {
        failedSteps: state.failed_steps.length,
      });

      return state;
    } catch (err) {
      throw new AdapterError(
        `GitHub provisioning failed: ${(err as Error).message}`,
        'github',
        'provision',
        err,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // executeStep() — step-level dispatch
  // ---------------------------------------------------------------------------

  async executeStep(
    stepKey: string,
    config: GitHubManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    this.log.info('GitHubAdapter.executeStep()', { stepKey, projectId: context.projectId });
    switch (stepKey) {
      case 'github:create-repository':
        return this.stepCreateRepository(config, context);
      case 'github:create-environments':
        return this.stepCreateEnvironments(config, context);
      case 'github:inject-secrets':
        return this.stepInjectSecrets(config, context);
      case 'github:deploy-workflows':
        return this.stepDeployWorkflows(config, context);
      default:
        throw new AdapterError(`Unknown GitHub step: ${stepKey}`, 'github', 'executeStep');
    }
  }

  private async stepCreateRepository(
    config: GitHubManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const existing = config.existing_repo_id
      ? await this.apiClient.getRepo(config.owner, config.repo_name)
      : null;
    let cloneUrl: string;
    let repoId: number;
    if (existing) {
      cloneUrl = existing.cloneUrl;
      repoId = existing.id;
    } else {
      const repo = await this.withRateLimit(() =>
        this.apiClient.createRepo(config.owner, config.repo_name),
      );
      cloneUrl = repo.cloneUrl;
      repoId = repo.id;
    }
    const github_repo_url = cloneUrl.replace(/\.git$/i, '');
    return {
      status: 'completed',
      resourcesProduced: {
        github_repo_url,
        github_repo_id: String(repoId),
      },
    };
  }

  private async stepCreateEnvironments(
    config: GitHubManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const env = context.environment ?? config.environments[0] ?? 'development';
    const result = await this.withRateLimit(() =>
      this.apiClient.createEnvironment(config.owner, config.repo_name, env),
    );
    return {
      status: 'completed',
      resourcesProduced: { github_environment_id: String(result.id) },
    };
  }

  private async stepInjectSecrets(
    config: GitHubManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const env = context.environment ?? config.environments[0] ?? 'development';
    const injected: string[] = [];

    // Firebase service account key → FIREBASE_SERVICE_ACCOUNT
    const saJson = await context.vaultRead(`${context.projectId}/service_account_json`);
    if (saJson) {
      await this.withRateLimit(() =>
        this.apiClient.setEnvironmentSecret(
          config.owner,
          config.repo_name,
          env,
          'FIREBASE_SERVICE_ACCOUNT',
          saJson,
        ),
      );
      injected.push('FIREBASE_SERVICE_ACCOUNT');
    }

    // Expo/EAS token → EAS_TOKEN (from upstream resources or vault)
    const easToken =
      context.upstreamResources['expo_token'] ??
      (await context.vaultRead('eas/expo_token'));
    if (easToken) {
      await this.withRateLimit(() =>
        this.apiClient.setEnvironmentSecret(
          config.owner,
          config.repo_name,
          env,
          'EAS_TOKEN',
          easToken,
        ),
      );
      injected.push('EAS_TOKEN');
    }

    return { status: 'completed', resourcesProduced: { injected_secrets: injected.join(',') } };
  }

  private async stepDeployWorkflows(
    config: GitHubManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    for (const template of config.workflow_templates) {
      const content = buildWorkflowTemplate(template, config.environments);
      await this.withRateLimit(() =>
        this.apiClient.deployWorkflow(config.owner, config.repo_name, `${template}.yml`, content),
      );
    }
    return { status: 'completed', resourcesProduced: {} };
  }

  // ---------------------------------------------------------------------------
  // checkStep() — verify whether a step's resource already exists
  // ---------------------------------------------------------------------------

  async checkStep(
    stepKey: string,
    config: GitHubManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    this.log.info('GitHubAdapter.checkStep()', { stepKey, projectId: context.projectId });
    switch (stepKey) {
      case 'github:create-repository': {
        const existing = await this.apiClient.getRepo(config.owner, config.repo_name);
        if (existing) {
          const github_repo_url = existing.cloneUrl.replace(/\.git$/i, '');
          return {
            status: 'completed',
            resourcesProduced: { github_repo_url, github_repo_id: String(existing.id) },
          };
        }
        return { status: 'failed', resourcesProduced: {}, error: 'Repository not found' };
      }
      case 'github:create-environments': {
        const env = context.environment ?? config.environments[0] ?? 'development';
        try {
          const result = await this.withRateLimit(() =>
            this.apiClient.createEnvironment(config.owner, config.repo_name, env),
          );
          return { status: 'completed', resourcesProduced: { github_environment_id: String(result.id) } };
        } catch {
          return { status: 'failed', resourcesProduced: {}, error: `Environment "${env}" check failed` };
        }
      }
      case 'github:inject-secrets': {
        const env = context.environment ?? config.environments[0] ?? 'development';
        try {
          const secrets = await this.withRateLimit(() =>
            this.apiClient.listEnvironmentSecrets(config.owner, config.repo_name, env),
          );
          if (secrets.length > 0) {
            return { status: 'completed', resourcesProduced: { injected_secrets: secrets.join(',') } };
          }
          return { status: 'failed', resourcesProduced: {}, error: `No secrets found in environment "${env}"` };
        } catch {
          return { status: 'failed', resourcesProduced: {}, error: `Failed to list secrets for environment "${env}"` };
        }
      }
      case 'github:deploy-workflows': {
        try {
          const workflows = await this.withRateLimit(() =>
            this.apiClient.listWorkflows(config.owner, config.repo_name),
          );
          if (workflows.length > 0) {
            return { status: 'completed', resourcesProduced: {} };
          }
          return { status: 'failed', resourcesProduced: {}, error: 'No workflows found' };
        } catch {
          return { status: 'failed', resourcesProduced: {}, error: 'Failed to list workflows' };
        }
      }
      default:
        return { status: 'failed', resourcesProduced: {}, error: `Unknown step: ${stepKey}` };
    }
  }

  // ---------------------------------------------------------------------------
  // validate()
  // ---------------------------------------------------------------------------

  async validate(
    manifest: GitHubManifestConfig,
    liveState: ProviderState | null,
  ): Promise<DriftReport> {
    const differences: DriftDifference[] = [];
    const orphanedResources: string[] = [];

    if (!liveState) {
      return {
        provider_id: `github-${manifest.owner}-${manifest.repo_name}`,
        provider_type: 'github',
        manifest_state: manifest,
        live_state: null,
        differences: [
          {
            field: 'repository',
            manifest_value: `${manifest.owner}/${manifest.repo_name}`,
            live_value: null,
            conflict_type: 'missing_in_live',
          },
        ],
        orphaned_resources: [],
        requires_user_decision: false,
      };
    }

    // Check branch protection rules
    for (const rule of manifest.branch_protection_rules) {
      const liveRule = await this.apiClient.getBranchProtection(
        manifest.owner,
        manifest.repo_name,
        rule.branch,
      );

      if (!liveRule) {
        differences.push({
          field: `branch_protection.${rule.branch}`,
          manifest_value: rule,
          live_value: null,
          conflict_type: 'missing_in_live',
        });
      } else {
        if (liveRule.require_reviews !== rule.require_reviews) {
          differences.push({
            field: `branch_protection.${rule.branch}.require_reviews`,
            manifest_value: rule.require_reviews,
            live_value: liveRule.require_reviews,
            conflict_type: 'value_mismatch',
          });
        }
      }
    }

    // Check workflows
    const liveWorkflows = new Set(
      await this.apiClient.listWorkflows(manifest.owner, manifest.repo_name),
    );

    for (const template of manifest.workflow_templates) {
      const filename = `${template}.yml`;
      if (!liveWorkflows.has(filename)) {
        differences.push({
          field: `workflow.${filename}`,
          manifest_value: filename,
          live_value: null,
          conflict_type: 'missing_in_live',
        });
      }
    }

    return {
      provider_id: liveState.provider_id,
      provider_type: 'github',
      manifest_state: manifest,
      live_state: liveState,
      differences,
      orphaned_resources: orphanedResources,
      requires_user_decision: orphanedResources.length > 0,
    };
  }

  // ---------------------------------------------------------------------------
  // reconcile()
  // ---------------------------------------------------------------------------

  async reconcile(
    report: DriftReport,
    direction: ReconcileDirection,
  ): Promise<ProviderState> {
    const manifest = report.manifest_state as GitHubManifestConfig;

    if (!report.live_state) {
      return this.provision(manifest);
    }

    const state = { ...report.live_state };

    if (direction === 'manifest→live') {
      for (const diff of report.differences) {
        if (diff.conflict_type === 'missing_in_live') {
          if (diff.field.startsWith('branch_protection.')) {
            const branch = diff.field.replace('branch_protection.', '').split('.')[0]!;
            const rule = manifest.branch_protection_rules.find(r => r.branch === branch);
            if (rule) {
              await this.withRateLimit(() =>
                this.apiClient.setBranchProtection(manifest.owner, manifest.repo_name, rule),
              );
              state.completed_steps.push(`reconcile_branch_protection_${branch}`);
            }
          } else if (diff.field.startsWith('workflow.')) {
            const filename = diff.field.replace('workflow.', '');
            const template = filename.replace('.yml', '');
            const content = buildWorkflowTemplate(template, manifest.environments);
            await this.withRateLimit(() =>
              this.apiClient.deployWorkflow(manifest.owner, manifest.repo_name, filename, content),
            );
            state.completed_steps.push(`reconcile_workflow_${template}`);
          }
        }
      }
    }

    state.updated_at = Date.now();
    return state;
  }

  // ---------------------------------------------------------------------------
  // extractCredentials()
  // ---------------------------------------------------------------------------

  async extractCredentials(state: ProviderState): Promise<Record<string, string>> {
    const cloneUrl = state.resource_ids['clone_url'] ?? '';
    const repoId = state.resource_ids['repo_id'] ?? '';

    state.credential_metadata['clone_url'] = { name: 'clone_url', stored_at: Date.now() };
    state.credential_metadata['repo_id'] = { name: 'repo_id', stored_at: Date.now() };

    return {
      clone_url: cloneUrl,
      repo_id: repoId,
    };
  }

  // ---------------------------------------------------------------------------
  // Rate-limit handling
  // ---------------------------------------------------------------------------

  private async withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < GitHubAdapter.MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const rateLimitErr = err as Partial<GitHubRateLimitError>;
        if (rateLimitErr.isRateLimit && rateLimitErr.resetAt) {
          const delayMs = Math.max(0, rateLimitErr.resetAt * 1000 - Date.now()) + 1000;
          this.log.warn(`GitHub rate limit hit — retrying after ${delayMs}ms`, {
            attempt,
            resetAt: rateLimitErr.resetAt,
          });
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          throw err;
        }
      }
    }
    throw new AdapterError(
      `GitHub API rate limit retries exhausted: ${(lastError as Error).message}`,
      'github',
      'withRateLimit',
      lastError,
    );
  }

  private hashConfig(config: GitHubManifestConfig): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex')
      .slice(0, 16);
  }
}
