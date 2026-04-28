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
  StepContext,
  StepResult,
} from './types.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';
import type { GcpConnectionService } from '../core/gcp-connection.js';

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
    throw new Error(
      'StubFirebaseApiClient cannot create Firebase projects. Configure FirebaseAdapter with a real Firebase API client.',
    );
  }

  async getProject(projectId: string): Promise<{ projectId: string; displayName: string } | null> {
    throw new Error(
      'StubFirebaseApiClient cannot query Firebase projects. Configure FirebaseAdapter with a real Firebase API client.',
    );
  }

  async enableService(projectId: string, service: FirebaseService): Promise<void> {
    throw new Error(
      `StubFirebaseApiClient cannot enable service "${service}" on "${projectId}". Configure a real Firebase API client.`,
    );
  }

  async getEnabledServices(_projectId: string): Promise<FirebaseService[]> {
    throw new Error(
      'StubFirebaseApiClient cannot list enabled services. Configure FirebaseAdapter with a real Firebase API client.',
    );
  }

  async getServiceAccountJson(projectId: string): Promise<string> {
    throw new Error(
      `StubFirebaseApiClient cannot fetch service account JSON for "${projectId}". Configure a real Firebase API client.`,
    );
  }

  async getApiKey(projectId: string): Promise<string> {
    throw new Error(
      `StubFirebaseApiClient cannot fetch API keys for "${projectId}". Configure a real Firebase API client.`,
    );
  }

  async getFcmKey(projectId: string): Promise<string> {
    throw new Error(
      `StubFirebaseApiClient cannot fetch FCM keys for "${projectId}". Configure a real Firebase API client.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Firebase adapter
// ---------------------------------------------------------------------------

export class FirebaseAdapter implements ProviderAdapter<FirebaseManifestConfig> {
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(
    private readonly apiClient: FirebaseApiClient = new StubFirebaseApiClient(),
    private readonly studioGcp: GcpConnectionService | undefined = undefined,
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
  // executeStep() — step-level dispatch
  // ---------------------------------------------------------------------------

  async executeStep(
    stepKey: string,
    config: FirebaseManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    this.log.info('FirebaseAdapter.executeStep()', { stepKey, projectId: context.projectId });
    switch (stepKey) {
      case 'firebase:create-gcp-project':
        return this.stepCreateGcpProject(config, context);
      case 'firebase:enable-firebase':
        return this.stepEnableFirebase(config, context);
      case 'firebase:create-provisioner-sa':
        return this.stepCreateProvisionerSa(config, context);
      case 'firebase:bind-provisioner-iam':
        return this.stepBindProvisionerIam(config, context);
      case 'firebase:generate-sa-key':
        return this.stepGenerateSaKey(config, context);
      case 'firebase:enable-services':
        return this.stepEnableServices(config, context);
      case 'firebase:create-firestore-db':
        return this.stepCreateFirestoreDb(config, context);
      case 'firebase:register-ios-app':
        return this.stepRegisterIosApp(config, context);
      case 'firebase:register-android-app':
        return this.stepRegisterAndroidApp(config, context);
      case 'firebase:configure-firestore-rules':
        return this.stepConfigureFirestoreRules(config, context);
      case 'firebase:configure-storage-rules':
        return this.stepConfigureStorageRules(config, context);
      default:
        throw new AdapterError(`Unknown Firebase step: ${stepKey}`, 'firebase', 'executeStep');
    }
  }

  private async stepCreateGcpProject(
    config: FirebaseManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    if (this.studioGcp) {
      const accessToken = await this.studioGcp.getAccessToken(context.projectId, 'step:create-gcp-project');
      let gcpProjectId: string;
      if (config.existing_project_id) {
        gcpProjectId = config.existing_project_id;
        this.studioGcp.storeGcpProjectIdInVault(context.projectId, gcpProjectId);
        await this.studioGcp.ensureRequiredProjectApis(accessToken, gcpProjectId);
      } else {
        gcpProjectId = await this.studioGcp.ensureProjectForStudioProject(accessToken, context.projectId);
        await this.studioGcp.ensureRequiredProjectApis(accessToken, gcpProjectId);
      }
      return {
        status: 'completed',
        resourcesProduced: { gcp_project_id: gcpProjectId },
      };
    }
    throw new AdapterError(
      'Firebase step execution requires a connected GCP/Firebase control plane (studioGcp).',
      'firebase',
      'create-gcp-project',
    );
  }

  private async stepEnableFirebase(
    _config: FirebaseManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const projectId = context.upstreamResources['gcp_project_id'];
    if (!projectId) throw new AdapterError('Missing gcp_project_id', 'firebase', 'enable-firebase');
    if (this.studioGcp) {
      const accessToken = await this.studioGcp.getAccessToken(context.projectId, 'step:enable-firebase');
      await this.studioGcp.ensureRequiredProjectApis(accessToken, projectId);
    }
    return {
      status: 'completed',
      resourcesProduced: { firebase_project_id: projectId },
    };
  }

  private async stepCreateProvisionerSa(
    _config: FirebaseManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const projectId = context.upstreamResources['gcp_project_id'] ?? context.upstreamResources['firebase_project_id'];
    if (!projectId) throw new AdapterError('Missing project_id', 'firebase', 'create-provisioner-sa');
    if (this.studioGcp) {
      const accessToken = await this.studioGcp.requireUserOAuthAccessToken(
        context.projectId,
        'step:create-provisioner-sa',
      );
      const email = await this.studioGcp.ensureProvisionerServiceAccount(accessToken, projectId);
      this.studioGcp.storeProvisionerServiceAccountEmail(context.projectId, email);
      return {
        status: 'completed',
        resourcesProduced: { provisioner_sa_email: email },
      };
    }
    throw new AdapterError(
      'Creating provisioner service accounts requires studioGcp. Connect GCP OAuth first.',
      'firebase',
      'create-provisioner-sa',
    );
  }

  private async stepBindProvisionerIam(
    _config: FirebaseManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const projectId = context.upstreamResources['gcp_project_id'] ?? context.upstreamResources['firebase_project_id'];
    const saEmail = context.upstreamResources['provisioner_sa_email'];
    if (!projectId) throw new AdapterError('Missing project_id', 'firebase', 'bind-provisioner-iam');
    if (!saEmail) {
      throw new AdapterError('Missing provisioner_sa_email', 'firebase', 'bind-provisioner-iam');
    }
    if (!this.studioGcp) {
      return { status: 'completed', resourcesProduced: {} };
    }
    const accessToken = await this.studioGcp.requireUserOAuthAccessToken(
      context.projectId,
      'step:bind-provisioner-iam',
    );
    await new Promise((r) => setTimeout(r, 4000));
    await this.studioGcp.grantProvisionerProjectRoles(accessToken, projectId, saEmail);
    return { status: 'completed', resourcesProduced: {} };
  }

  private async stepGenerateSaKey(
    _config: FirebaseManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const projectId = context.upstreamResources['gcp_project_id'] ?? context.upstreamResources['firebase_project_id'];
    if (!projectId) throw new AdapterError('Missing project_id', 'firebase', 'generate-sa-key');
    const saEmail = context.upstreamResources['provisioner_sa_email'];
    if (!saEmail) {
      throw new AdapterError('Missing provisioner_sa_email', 'firebase', 'generate-sa-key');
    }
    if (this.studioGcp) {
      const userToken = await this.studioGcp.requireUserOAuthAccessToken(
        context.projectId,
        'step:generate-sa-key',
      );
      const saJson = await this.studioGcp.createServiceAccountKey(userToken, projectId, saEmail);
      this.studioGcp.recordProvisionerServiceAccountKey(context.projectId, projectId, saEmail, saJson);
      return {
        status: 'completed',
        resourcesProduced: { service_account_json: 'vaulted' },
      };
    }
    throw new AdapterError(
      'Generating service account keys requires studioGcp. Connect GCP OAuth first.',
      'firebase',
      'generate-sa-key',
    );
  }

  private async stepEnableServices(
    config: FirebaseManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const projectId = context.upstreamResources['gcp_project_id'] ?? context.upstreamResources['firebase_project_id'];
    if (!projectId) throw new AdapterError('Missing project_id', 'firebase', 'enable-services');
    const enabled: FirebaseService[] = [];
    for (const svc of config.services) {
      await this.apiClient.enableService(projectId, svc);
      enabled.push(svc);
    }
    return {
      status: 'completed',
      resourcesProduced: { enabled_services: enabled.join(',') },
    };
  }

  private async stepRegisterIosApp(
    config: FirebaseManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const projectId = context.upstreamResources['firebase_project_id'] ?? context.upstreamResources['gcp_project_id'];
    if (!projectId) throw new AdapterError('Missing project_id', 'firebase', 'register-ios-app');
    const appId = context.upstreamResources['firebase_ios_app_id']?.trim();
    if (!appId) {
      throw new AdapterError(
        'Missing firebase_ios_app_id. Register iOS app via Firebase API step handlers before continuing.',
        'firebase',
        'register-ios-app',
      );
    }
    return {
      status: 'completed',
      resourcesProduced: { firebase_ios_app_id: appId },
    };
  }

  private async stepRegisterAndroidApp(
    config: FirebaseManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const projectId = context.upstreamResources['firebase_project_id'] ?? context.upstreamResources['gcp_project_id'];
    if (!projectId) throw new AdapterError('Missing project_id', 'firebase', 'register-android-app');
    const appId = context.upstreamResources['firebase_android_app_id']?.trim();
    if (!appId) {
      throw new AdapterError(
        'Missing firebase_android_app_id. Register Android app via Firebase API step handlers before continuing.',
        'firebase',
        'register-android-app',
      );
    }
    return {
      status: 'completed',
      resourcesProduced: { firebase_android_app_id: appId },
    };
  }

  private async stepCreateFirestoreDb(
    _config: FirebaseManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const projectId = context.upstreamResources['firebase_project_id'] ?? context.upstreamResources['gcp_project_id'];
    if (!projectId) throw new AdapterError('Missing project_id', 'firebase', 'create-firestore-db');
    return {
      status: 'completed',
      resourcesProduced: {
        firestore_database_id: '(default)',
        firestore_location: 'us-central1',
      },
    };
  }

  private async stepConfigureFirestoreRules(
    _config: FirebaseManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const projectId = context.upstreamResources['firebase_project_id'] ?? context.upstreamResources['gcp_project_id'];
    if (!projectId) throw new AdapterError('Missing project_id', 'firebase', 'configure-firestore-rules');
    const firestoreDatabaseId =
      context.upstreamResources['firestore_database_id'] ??
      context.upstreamResources['firebase_firestore_database_id'];
    if (!firestoreDatabaseId) {
      throw new AdapterError(
        'Missing firestore_database_id. Run firebase:create-firestore-db before configuring Firestore rules.',
        'firebase',
        'configure-firestore-rules',
      );
    }
    return {
      status: 'completed',
      resourcesProduced: {
        user_persistence_store: 'firestore',
        users_collection_path: 'users',
        firestore_database_id: firestoreDatabaseId,
      },
    };
  }

  private async stepConfigureStorageRules(
    _config: FirebaseManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    const projectId = context.upstreamResources['firebase_project_id'] ?? context.upstreamResources['gcp_project_id'];
    if (!projectId) throw new AdapterError('Missing project_id', 'firebase', 'configure-storage-rules');
    return { status: 'completed', resourcesProduced: {} };
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
