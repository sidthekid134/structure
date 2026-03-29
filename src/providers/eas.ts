/**
 * EAS (Expo Application Services) adapter — initializes EAS projects and
 * manages environment variables scoped to dev, preview, and production.
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

// ---------------------------------------------------------------------------
// API client interface
// ---------------------------------------------------------------------------

export interface EasApiClient {
  createProject(projectName: string, organization?: string): Promise<string>;
  getProject(projectName: string, organization?: string): Promise<string | null>;
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

export class EasAdapter implements ProviderAdapter<EasManifestConfig> {
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(
    private readonly apiClient: EasApiClient = new StubEasApiClient(),
    loggingCallback?: LoggingCallback,
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

      // Step 2: Initialize env var slots for each environment
      for (const env of config.environments) {
        try {
          // Upload empty env file initially; credentials will be added via secret management
          await this.apiClient.uploadEnvFile(projectId, env, {});
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
        const env = (context.environment ?? config.environments[0] ?? 'dev') as Environment;
        await this.apiClient.uploadEnvFile(context.upstreamResources['eas_project_id'] ?? '', env, {});
        return { status: 'completed', resourcesProduced: {} };
      }
      case 'eas:link-github':
        return { status: 'completed', resourcesProduced: {} };
      case 'eas:store-token-in-github':
        return { status: 'completed', resourcesProduced: {} };
      case 'eas:configure-submit-apple':
        return { status: 'completed', resourcesProduced: {} };
      case 'eas:configure-submit-android':
        return { status: 'completed', resourcesProduced: {} };
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
            await this.apiClient.uploadEnvFile(projectId, env, {});
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
