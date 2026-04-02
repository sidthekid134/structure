/**
 * EAS (Expo Application Services) adapter — initializes EAS projects and
 * manages environment variables scoped to development, preview, and production.
 */

import * as crypto from 'crypto';
import {
  ProviderAdapter,
  EasManifestConfig,
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
import type { GitHubApiClient } from './github.js';
import { ExpoGraphqlEasApiClient } from './expo-graphql-eas-client.js';

// ---------------------------------------------------------------------------
// API client interface
// ---------------------------------------------------------------------------

export interface EasApiClient {
  createProject(projectName: string, organization?: string): Promise<string>;
  getProject(projectName: string, organization?: string): Promise<string | null>;
  /** Permanently remove the Expo app / EAS project (async on Expo's side). */
  deleteProject(projectId: string): Promise<void>;
  uploadEnvFile(
    projectId: string,
    environment: Environment,
    envVars: Record<string, string>,
  ): Promise<void>;
  getEnvVars(projectId: string, environment: Environment): Promise<Record<string, string>>;
}

export class StubEasApiClient implements EasApiClient {
  async createProject(projectName: string, _organization?: string): Promise<string> {
    return `eas-${projectName.toLowerCase()}-${Date.now()}`;
  }

  async getProject(_projectName: string, _organization?: string): Promise<string | null> {
    return null;
  }

  async deleteProject(_projectId: string): Promise<void> {}

  async uploadEnvFile(
    _projectId: string,
    _environment: Environment,
    _envVars: Record<string, string>,
  ): Promise<void> {}

  async getEnvVars(
    _projectId: string,
    _environment: Environment,
  ): Promise<Record<string, string>> {
    return {};
  }
}

// ---------------------------------------------------------------------------
// EAS adapter
// ---------------------------------------------------------------------------

function parseGithubHttpsRepo(url: string): { owner: string; repo: string } {
  const u = url.trim().replace(/\.git$/i, '');
  const m = u.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\/|$)/i);
  if (!m) {
    throw new AdapterError(
      `Expected a github.com repository URL (https://github.com/owner/repo), got: ${url}`,
      'eas',
      'executeStep',
    );
  }
  return { owner: m[1]!, repo: m[2]! };
}

export class EasAdapter implements ProviderAdapter<EasManifestConfig> {
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(
    private readonly apiClient: EasApiClient = new StubEasApiClient(),
    loggingCallback?: LoggingCallback,
    private readonly githubClient?: GitHubApiClient,
  ) {
    this.log = createOperationLogger('EasAdapter', loggingCallback);
  }

  async provision(config: EasManifestConfig): Promise<ProviderState> {
    this.log.info('Starting EAS provisioning', { projectName: config.project_name });

    const now = Date.now();
    const state: ProviderState = {
      provider_id: `eas-${config.project_name}`,
      provider_type: 'eas',
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
      // Step 1: Create or reuse EAS project
      let projectId = await this.apiClient.getProject(
        config.project_name,
        config.organization,
      );

      if (!projectId) {
        projectId = await this.apiClient.createProject(
          config.project_name,
          config.organization,
        );
        this.log.info('EAS project created', { projectId });
      }

      state.resource_ids['project_id'] = projectId;
      state.completed_steps.push('create_project');

      // Step 2: Mark each Studio environment on the Expo app (EAS env-var slots).
      for (const env of config.environments) {
        try {
          if (this.apiClient instanceof ExpoGraphqlEasApiClient) {
            await this.apiClient.ensureStudioEasEnvironmentMarkerOnApp(projectId, env);
          } else {
            await this.apiClient.uploadEnvFile(projectId, env, {});
          }
          state.resource_ids[`env_${env}`] = 'initialized';
          state.completed_steps.push(`init_env_${env}`);
          this.log.info('EAS environment initialized', { env, projectId });
        } catch (err) {
          state.failed_steps.push(`init_env_${env}`);
          state.partially_complete = true;
          this.log.error('Failed to initialize EAS environment', {
            env,
            error: (err as Error).message,
          });
        }
      }

      state.updated_at = Date.now();
      return state;
    } catch (err) {
      throw new AdapterError(
        `EAS provisioning failed: ${(err as Error).message}`,
        'eas',
        'provision',
        err,
      );
    }
  }

  async executeStep(
    stepKey: string,
    config: EasManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    this.log.info('EasAdapter.executeStep()', { stepKey });
    switch (stepKey) {
      case 'eas:create-project': {
        const existing = await this.apiClient.getProject(config.project_name, config.organization);
        const projectId = existing ?? await this.apiClient.createProject(config.project_name, config.organization);
        return { status: 'completed', resourcesProduced: { eas_project_id: projectId } };
      }
      case 'eas:configure-build-profiles': {
        const expo = this.apiClient instanceof ExpoGraphqlEasApiClient ? this.apiClient : null;
        if (!expo) {
          throw new AdapterError(
            'Configure build profiles requires the real Expo GraphQL client (Expo token).',
            'eas',
            'executeStep',
          );
        }
        const env = (context.environment ?? config.environments[0] ?? 'development') as Environment;
        const appId = context.upstreamResources['eas_project_id'] ?? '';
        if (!appId) {
          throw new AdapterError('Create the EAS project first (missing eas_project_id).', 'eas', 'executeStep');
        }
        await expo.ensureStudioEasEnvironmentMarkerOnApp(appId, env);
        return {
          status: 'completed',
          resourcesProduced: {},
          userPrompt:
            'Studio recorded which EAS environment slot matches this Studio environment. You must still maintain `eas.json` build profiles (development / preview / production) in your app repository — Expo builds read that file, not Studio.',
        };
      }
      case 'eas:store-token-in-github': {
        if (!this.githubClient) {
          throw new AdapterError(
            'Storing the Expo token in GitHub requires a GitHub PAT (organization settings).',
            'eas',
            'executeStep',
          );
        }
        const repoUrl = context.upstreamResources['github_repo_url'] ?? '';
        if (!repoUrl) {
          throw new AdapterError('Missing github_repo_url — create the GitHub repository first.', 'eas', 'executeStep');
        }
        const { owner, repo } = parseGithubHttpsRepo(repoUrl);
        const token =
          context.upstreamResources['expo_token']?.trim() ||
          (await context.vaultRead('eas/expo_token'))?.trim();
        if (!token) {
          throw new AdapterError(
            'No Expo robot token available. Connect EAS under organization settings so the token is stored in the vault.',
            'eas',
            'executeStep',
          );
        }
        await this.githubClient.setRepositorySecret(owner, repo, 'EXPO_TOKEN', token);
        return {
          status: 'completed',
          resourcesProduced: {},
          userPrompt:
            'GitHub Actions can use secret EXPO_TOKEN. Reference it in workflow env (e.g. EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}).',
        };
      }
      case 'eas:configure-submit-apple': {
        const expo = this.apiClient instanceof ExpoGraphqlEasApiClient ? this.apiClient : null;
        if (!expo) {
          throw new AdapterError('Configure EAS Submit (Apple) requires the real Expo GraphQL client.', 'eas', 'executeStep');
        }
        const appId = context.upstreamResources['eas_project_id'] ?? '';
        const bundleId = config.bundle_id?.trim();
        if (!appId || !bundleId) {
          throw new AdapterError(
            'Missing eas_project_id or bundle_id. Ensure the Studio project has a bundle id and the EAS project exists.',
            'eas',
            'executeStep',
          );
        }
        const issuer =
          (await context.vaultRead(`${context.projectId}/asc_issuer_id`))?.trim() ||
          (await context.vaultRead(`${context.projectId}/app_store_connect_issuer_id`))?.trim();
        const keyId = context.upstreamResources['asc_api_key_id']?.trim();
        let p8 =
          context.upstreamResources['asc_api_key_p8'] === 'vaulted'
            ? null
            : context.upstreamResources['asc_api_key_p8']?.trim();
        if (!p8) p8 = (await context.vaultRead(`${context.projectId}/asc_api_key_p8`))?.trim() ?? null;
        if (!issuer || !keyId || !p8) {
          throw new AdapterError(
            'App Store Connect API key material is incomplete. Store: (1) Issuer ID in vault as ' +
              `${context.projectId}/asc_issuer_id, (2) Key ID from Apple (asc_api_key_id from the Apple step or vault), ` +
              '(3) The .p8 private key contents in vault as ' +
              `${context.projectId}/asc_api_key_p8. ` +
              'Generate the key in App Store Connect → Users and Access → Keys.',
            'eas',
            'executeStep',
          );
        }
        await expo.configureIosEasSubmit({
          expoAppId: appId,
          organization: config.organization,
          bundleId,
          issuerIdentifier: issuer,
          keyIdentifier: keyId,
          keyP8: p8,
        });
        return {
          status: 'completed',
          resourcesProduced: {},
          userPrompt:
            'Expo is configured to use this ASC API key for iOS submissions. You still need valid `eas.json` submit profile(s) and matching credentials in the repo or EAS.',
        };
      }
      case 'eas:configure-submit-android': {
        const expo = this.apiClient instanceof ExpoGraphqlEasApiClient ? this.apiClient : null;
        if (!expo) {
          throw new AdapterError(
            'Configure EAS Submit (Android) requires the real Expo GraphQL client.',
            'eas',
            'executeStep',
          );
        }
        const appId = context.upstreamResources['eas_project_id'] ?? '';
        const pkg = (config.android_package ?? config.bundle_id)?.trim();
        if (!appId || !pkg) {
          throw new AdapterError(
            'Missing eas_project_id or Android application id. Set the Studio project bundle / package id.',
            'eas',
            'executeStep',
          );
        }
        const jsonRaw =
          (await context.vaultRead(`${context.projectId}/google_play_service_account_json`)) ??
          (await context.vaultRead(`${context.projectId}/play_service_account_json`));
        if (!jsonRaw?.trim()) {
          throw new AdapterError(
            'Google Play service account JSON not found. Upload it to the vault as ' +
              `${context.projectId}/google_play_service_account_json (JSON key with Play Console API access).`,
            'eas',
            'executeStep',
          );
        }
        let jsonKey: Record<string, unknown>;
        try {
          jsonKey = JSON.parse(jsonRaw) as Record<string, unknown>;
        } catch {
          throw new AdapterError(
            'google_play_service_account_json in the vault is not valid JSON.',
            'eas',
            'executeStep',
          );
        }
        await expo.configureAndroidEasSubmit({
          expoAppId: appId,
          organization: config.organization,
          androidApplicationId: pkg,
          googleServiceAccountJson: jsonKey,
        });
        return {
          status: 'completed',
          resourcesProduced: {},
          userPrompt:
            'Expo stores a Google Play service account key for Android submissions. Confirm `eas.json` submit config and Play Console API access for that service account.',
        };
      }
      default:
        throw new AdapterError(`Unknown EAS step: ${stepKey}`, 'eas', 'executeStep');
    }
  }

  async validate(
    manifest: EasManifestConfig,
    liveState: ProviderState | null,
  ): Promise<DriftReport> {
    const differences: DriftDifference[] = [];

    if (!liveState) {
      return {
        provider_id: `eas-${manifest.project_name}`,
        provider_type: 'eas',
        manifest_state: manifest,
        live_state: null,
        differences: [
          {
            field: 'project',
            manifest_value: manifest.project_name,
            live_value: null,
            conflict_type: 'missing_in_live',
          },
        ],
        orphaned_resources: [],
        requires_user_decision: false,
      };
    }

    const projectId = liveState.resource_ids['project_id'];
    if (!projectId) {
      differences.push({
        field: 'project_id',
        manifest_value: manifest.project_name,
        live_value: null,
        conflict_type: 'missing_in_live',
      });
    } else {
      for (const env of manifest.environments) {
        if (!liveState.resource_ids[`env_${env}`]) {
          differences.push({
            field: `environment.${env}`,
            manifest_value: env,
            live_value: null,
            conflict_type: 'missing_in_live',
          });
        }
      }
    }

    return {
      provider_id: liveState.provider_id,
      provider_type: 'eas',
      manifest_state: manifest,
      live_state: liveState,
      differences,
      orphaned_resources: [],
      requires_user_decision: false,
    };
  }

  async reconcile(
    report: DriftReport,
    direction: ReconcileDirection,
  ): Promise<ProviderState> {
    const manifest = report.manifest_state as EasManifestConfig;

    if (!report.live_state) {
      return this.provision(manifest);
    }

    if (direction === 'manifest→live') {
      const projectId = report.live_state.resource_ids['project_id'];
      if (projectId) {
        for (const diff of report.differences) {
          if (diff.conflict_type === 'missing_in_live' && diff.field.startsWith('environment.')) {
            const env = diff.field.replace('environment.', '') as Environment;
            if (this.apiClient instanceof ExpoGraphqlEasApiClient) {
              await this.apiClient.ensureStudioEasEnvironmentMarkerOnApp(projectId, env);
            } else {
              await this.apiClient.uploadEnvFile(projectId, env, {});
            }
            report.live_state.resource_ids[`env_${env}`] = 'initialized';
          }
        }
      }
    }

    report.live_state.updated_at = Date.now();
    return report.live_state;
  }

  async extractCredentials(state: ProviderState): Promise<Record<string, string>> {
    return {
      project_id: state.resource_ids['project_id'] ?? '',
    };
  }

  private hashConfig(config: EasManifestConfig): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex')
      .slice(0, 16);
  }
}
