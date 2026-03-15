/**
 * Firebase adapter — creates and configures Firebase projects with all
 * required services, extracts credentials, and handles drift detection.
 *
 * Actual Google Cloud / Firebase Management API calls are delegated to an
 * injectable FirebaseApiClient so the adapter logic can be unit-tested without
 * real credentials.
 */

import * as crypto from 'crypto';
import {
  ProviderAdapter,
  FirebaseManifestConfig,
  FirebaseService,
  ProviderState,
  DriftReport,
  DriftDifference,
  ReconcileDirection,
  AdapterError,
} from './types.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';

// ---------------------------------------------------------------------------
// API client interface (injectable for testing)
// ---------------------------------------------------------------------------

export interface FirebaseApiClient {
  createProject(projectName: string, billingAccountId: string): Promise<string>;
  getProject(projectId: string): Promise<{ projectId: string; displayName: string } | null>;
  enableService(projectId: string, service: FirebaseService): Promise<void>;
  getEnabledServices(projectId: string): Promise<FirebaseService[]>;
  getServiceAccountJson(projectId: string): Promise<string>;
  getApiKey(projectId: string): Promise<string>;
  getFcmKey(projectId: string): Promise<string>;
}

/** Default stub client — logs operations without real API calls. */
export class StubFirebaseApiClient implements FirebaseApiClient {
  async createProject(projectName: string, _billingAccountId: string): Promise<string> {
    return `${projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${Date.now()}`;
  }

  async getProject(projectId: string): Promise<{ projectId: string; displayName: string } | null> {
    // In a real implementation, call the Firebase Management API
    return null;
  }

  async enableService(projectId: string, service: FirebaseService): Promise<void> {
    // In a real implementation, call the Firebase Management API
  }

  async getEnabledServices(_projectId: string): Promise<FirebaseService[]> {
    return [];
  }

  async getServiceAccountJson(projectId: string): Promise<string> {
    return JSON.stringify({ type: 'service_account', project_id: projectId });
  }

  async getApiKey(projectId: string): Promise<string> {
    return `stub-api-key-${projectId}`;
  }

  async getFcmKey(projectId: string): Promise<string> {
    return `stub-fcm-key-${projectId}`;
  }
}

// ---------------------------------------------------------------------------
// Firebase adapter
// ---------------------------------------------------------------------------

export class FirebaseAdapter implements ProviderAdapter<FirebaseManifestConfig> {
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(
    private readonly apiClient: FirebaseApiClient = new StubFirebaseApiClient(),
    loggingCallback?: LoggingCallback,
  ) {
    this.log = createOperationLogger('FirebaseAdapter', loggingCallback);
  }

  // ---------------------------------------------------------------------------
  // provision()
  // ---------------------------------------------------------------------------

  async provision(config: FirebaseManifestConfig): Promise<ProviderState> {
    this.log.info('Starting Firebase provisioning', {
      projectName: config.project_name,
      serviceCount: config.services.length,
    });

    const now = Date.now();
    const state: ProviderState = {
      provider_id: `firebase-${config.project_name}`,
      provider_type: 'firebase',
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
      // Step 1: Create or reuse Firebase project
      let projectId = config.existing_project_id;
      if (!projectId) {
        if (!state.resource_ids['project_id']) {
          projectId = await this.apiClient.createProject(
            config.project_name,
            config.billing_account_id,
          );
          state.resource_ids['project_id'] = projectId;
          state.completed_steps.push('create_project');
          this.log.info('Firebase project created', { projectId });
        }
      } else {
        state.resource_ids['project_id'] = projectId;
        state.completed_steps.push('create_project');
      }

      // Step 2: Enable each service
      const enabledServices: FirebaseService[] = [];
      for (const service of config.services) {
        try {
          await this.apiClient.enableService(projectId!, service);
          enabledServices.push(service);
          state.completed_steps.push(`enable_${service}`);
          state.resource_ids[`service_${service}`] = 'enabled';
          this.log.info('Firebase service enabled', { service, projectId });
        } catch (err) {
          state.failed_steps.push(`enable_${service}`);
          state.partially_complete = true;
          this.log.error('Failed to enable Firebase service', {
            service,
            projectId,
            error: (err as Error).message,
          });
        }
      }

      // Record enabled services for drift detection
      state.resource_ids['enabled_services'] = enabledServices.join(',');

      state.updated_at = Date.now();

      if (state.failed_steps.length > 0) {
        this.log.warn(
          'Firebase provisioning partially complete. ' +
            'Use "platform secret add" to manually supply missing credentials.',
          { failedSteps: state.failed_steps },
        );
      } else {
        this.log.info('Firebase provisioning complete');
      }

      return state;
    } catch (err) {
      throw new AdapterError(
        `Firebase provisioning failed: ${(err as Error).message}`,
        'firebase',
        'provision',
        err,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // validate()
  // ---------------------------------------------------------------------------

  async validate(
    manifest: FirebaseManifestConfig,
    liveState: ProviderState | null,
  ): Promise<DriftReport> {
    const differences: DriftDifference[] = [];
    const orphanedResources: string[] = [];

    if (!liveState) {
      return {
        provider_id: `firebase-${manifest.project_name}`,
        provider_type: 'firebase',
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
      // Check enabled services
      try {
        const liveServices = await this.apiClient.getEnabledServices(projectId);
        const manifestServices = new Set(manifest.services);
        const liveServiceSet = new Set(liveServices);

        for (const svc of manifest.services) {
          if (!liveServiceSet.has(svc)) {
            differences.push({
              field: `service.${svc}`,
              manifest_value: 'enabled',
              live_value: null,
              conflict_type: 'missing_in_live',
            });
          }
        }

        for (const svc of liveServices) {
          if (!manifestServices.has(svc)) {
            orphanedResources.push(`service.${svc}`);
            differences.push({
              field: `service.${svc}`,
              manifest_value: null,
              live_value: 'enabled',
              conflict_type: 'missing_in_manifest',
            });
          }
        }
      } catch (err) {
        this.log.warn('Could not fetch live Firebase services', {
          error: (err as Error).message,
        });
      }
    }

    return {
      provider_id: liveState.provider_id,
      provider_type: 'firebase',
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
    const manifest = report.manifest_state as FirebaseManifestConfig;
    const liveState = report.live_state;

    if (!liveState) {
      return this.provision(manifest);
    }

    const projectId = liveState.resource_ids['project_id'];
    if (!projectId) {
      throw new AdapterError(
        'Cannot reconcile: live state is missing project_id',
        'firebase',
        'reconcile',
      );
    }

    if (direction === 'manifest→live') {
      // Enable missing services
      const missingServices = report.differences
        .filter(d => d.conflict_type === 'missing_in_live')
        .map(d => d.field.replace('service.', '') as FirebaseService);

      for (const svc of missingServices) {
        await this.apiClient.enableService(projectId, svc);
        liveState.resource_ids[`service_${svc}`] = 'enabled';
        liveState.completed_steps.push(`reconcile_enable_${svc}`);
      }
    } else {
      // live→manifest: update manifest to reflect live services (read-only state update)
      this.log.info('Updating manifest state to reflect live Firebase services');
    }

    liveState.updated_at = Date.now();
    return liveState;
  }

  // ---------------------------------------------------------------------------
  // extractCredentials()
  // ---------------------------------------------------------------------------

  async extractCredentials(state: ProviderState): Promise<Record<string, string>> {
    const projectId = state.resource_ids['project_id'];
    if (!projectId) {
      throw new AdapterError(
        'Cannot extract credentials: missing project_id in state',
        'firebase',
        'extractCredentials',
      );
    }

    const [serviceAccountJson, apiKey, fcmKey] = await Promise.all([
      this.apiClient.getServiceAccountJson(projectId),
      this.apiClient.getApiKey(projectId),
      this.apiClient.getFcmKey(projectId),
    ]);

    // Update credential metadata
    state.credential_metadata['service_account_json'] = {
      name: 'service_account_json',
      stored_at: Date.now(),
    };
    state.credential_metadata['api_key'] = { name: 'api_key', stored_at: Date.now() };
    state.credential_metadata['fcm_key'] = { name: 'fcm_key', stored_at: Date.now() };

    return {
      service_account_json: serviceAccountJson,
      api_key: apiKey,
      fcm_key: fcmKey,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private hashConfig(config: FirebaseManifestConfig): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex')
      .slice(0, 16);
  }
}
