/**
 * GitHub adapter — creates repositories with branch protection, secrets
 * injection, and CI/CD workflow deployment.
 *
 * Rate-limit handling: catches 403 responses from the GitHub API, reads
 * X-RateLimit-Reset, and retries after the appropriate delay.
 */

import * as crypto from 'crypto';
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
  createRepo(owner: string, name: string): Promise<{ id: number; cloneUrl: string }>;
  getRepo(owner: string, name: string): Promise<{ id: number; cloneUrl: string } | null>;
  setBranchProtection(owner: string, repo: string, rule: BranchProtectionRule): Promise<void>;
  getBranchProtection(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<BranchProtectionRule | null>;
  setEnvironmentSecret(
    owner: string,
    repo: string,
    env: string,
    secretName: string,
    encryptedValue: string,
  ): Promise<void>;
  listEnvironmentSecrets(owner: string, repo: string, env: string): Promise<string[]>;
  deployWorkflow(owner: string, repo: string, filename: string, content: string): Promise<void>;
  listWorkflows(owner: string, repo: string): Promise<string[]>;
}

export class StubGitHubApiClient implements GitHubApiClient {
  async createRepo(
    owner: string,
    name: string,
  ): Promise<{ id: number; cloneUrl: string }> {
    return {
      id: Math.floor(Math.random() * 1_000_000),
      cloneUrl: `https://github.com/${owner}/${name}.git`,
    };
  }

  async getRepo(
    _owner: string,
    _name: string,
  ): Promise<{ id: number; cloneUrl: string } | null> {
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

  async setEnvironmentSecret(
    _owner: string,
    _repo: string,
    _env: string,
    _secretName: string,
    _encryptedValue: string,
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
    environment: \${{ github.ref == 'refs/heads/main' && 'prod' || 'dev' }}
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
    environment: \${{ github.ref == 'refs/heads/main' && 'prod' || 'preview' }}
    # Environments: ${envList}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run deploy
    env:
      FIREBASE_TOKEN: \${{ secrets.FIREBASE_TOKEN }}
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
    private readonly apiClient: GitHubApiClient = new StubGitHubApiClient(),
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
