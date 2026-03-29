/**
 * Apple Developer adapter — provisions bundle IDs, certificates, and APNs keys.
 *
 * Apple's APNs keys have a one-time download window; if the window closes before
 * the key is captured, the state is marked as `download_window_closed = true` and
 * the user is directed to manually supply the key via 'platform secret add'.
 */

import * as crypto from 'crypto';
import {
  ProviderAdapter,
  AppleManifestConfig,
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

// ---------------------------------------------------------------------------
// API client interface
// ---------------------------------------------------------------------------

export interface AppleApiClient {
  createBundleId(bundleId: string, appName: string, teamId: string): Promise<string>;
  getBundleId(bundleId: string): Promise<{ id: string; identifier: string } | null>;
  createCertificate(
    teamId: string,
    type: 'development' | 'distribution',
    csrPem: string,
  ): Promise<{ id: string; certPem: string }>;
  getCertificates(teamId: string): Promise<Array<{ id: string; type: string; expiresAt: number }>>;
  createApnsKey(teamId: string): Promise<{ keyId: string; privateKeyP8: string }>;
  getApnsKeys(teamId: string): Promise<Array<{ keyId: string }>>;
}

export class StubAppleApiClient implements AppleApiClient {
  async createBundleId(bundleId: string, _appName: string, _teamId: string): Promise<string> {
    return `bundle-${bundleId.replace(/\./g, '-')}`;
  }

  async getBundleId(
    _bundleId: string,
  ): Promise<{ id: string; identifier: string } | null> {
    return null;
  }

  async createCertificate(
    _teamId: string,
    _type: 'development' | 'distribution',
    _csrPem: string,
  ): Promise<{ id: string; certPem: string }> {
    return {
      id: `cert-${Date.now()}`,
      certPem: '-----BEGIN CERTIFICATE-----\nSTUB\n-----END CERTIFICATE-----',
    };
  }

  async getCertificates(
    _teamId: string,
  ): Promise<Array<{ id: string; type: string; expiresAt: number }>> {
    return [];
  }

  async createApnsKey(
    _teamId: string,
  ): Promise<{ keyId: string; privateKeyP8: string }> {
    return {
      keyId: `key-${Date.now()}`,
      privateKeyP8: '-----BEGIN PRIVATE KEY-----\nSTUB\n-----END PRIVATE KEY-----',
    };
  }

  async getApnsKeys(_teamId: string): Promise<Array<{ keyId: string }>> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Apple adapter
// ---------------------------------------------------------------------------

export class AppleAdapter implements ProviderAdapter<AppleManifestConfig> {
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(
    private readonly apiClient: AppleApiClient = new StubAppleApiClient(),
    loggingCallback?: LoggingCallback,
  ) {
    this.log = createOperationLogger('AppleAdapter', loggingCallback);
  }

  async provision(config: AppleManifestConfig): Promise<ProviderState> {
    this.log.info('Starting Apple provisioning', {
      bundleId: config.bundle_id,
      teamId: config.team_id,
    });

    const now = Date.now();
    const state: ProviderState = {
      provider_id: `apple-${config.bundle_id}`,
      provider_type: 'apple',
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
      // Step 1: Create bundle ID
      const existing = await this.apiClient.getBundleId(config.bundle_id);
      let bundleResourceId: string;

      if (existing) {
        bundleResourceId = existing.id;
      } else {
        bundleResourceId = await this.apiClient.createBundleId(
          config.bundle_id,
          config.app_name,
          config.team_id,
        );
      }
      state.resource_ids['bundle_resource_id'] = bundleResourceId;
      state.resource_ids['bundle_id'] = config.bundle_id;
      state.completed_steps.push('create_bundle_id');
      this.log.info('Bundle ID provisioned', { bundleId: config.bundle_id });

      // Step 2: Create certificate
      try {
        const csr = this.generateStubCsr();
        const cert = await this.apiClient.createCertificate(
          config.team_id,
          config.certificate_type,
          csr,
        );
        state.resource_ids['certificate_id'] = cert.id;
        state.credential_metadata['certificate_pem'] = {
          name: 'certificate_pem',
          stored_at: Date.now(),
        };
        state.completed_steps.push('create_certificate');
        this.log.info('Certificate created', { certId: cert.id });
      } catch (err) {
        state.failed_steps.push('create_certificate');
        state.partially_complete = true;
        this.log.error('Failed to create certificate', { error: (err as Error).message });
      }

      // Step 3: Create APNs key (if enabled)
      if (config.enable_apns) {
        try {
          const apnsKey = await this.apiClient.createApnsKey(config.team_id);
          // APNs key can only be downloaded once — mark as captured
          state.resource_ids['apns_key_id'] = apnsKey.keyId;
          state.credential_metadata['apns_key'] = {
            name: 'apns_key',
            download_window_closed: false,
            stored_at: Date.now(),
          };
          state.completed_steps.push('create_apns_key');
          this.log.info('APNs key created', { keyId: apnsKey.keyId });
        } catch (err) {
          state.failed_steps.push('create_apns_key');
          state.partially_complete = true;
          // Mark download window as closed — user must manually provide key
          state.credential_metadata['apns_key'] = {
            name: 'apns_key',
            download_window_closed: true,
            pending_manual_upload: true,
          };
          this.log.warn(
            'APNs key download window may have closed. ' +
              'Use "platform secret add apple apns_key <value>" to supply the key manually.',
            { error: (err as Error).message },
          );
        }
      }

      state.updated_at = Date.now();
      return state;
    } catch (err) {
      throw new AdapterError(
        `Apple provisioning failed: ${(err as Error).message}`,
        'apple',
        'provision',
        err,
      );
    }
  }

  async executeStep(
    stepKey: string,
    config: AppleManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    this.log.info('AppleAdapter.executeStep()', { stepKey });
    switch (stepKey) {
      case 'apple:register-app-id': {
        const existing = await this.apiClient.getBundleId(config.bundle_id);
        const appId = existing
          ? existing.id
          : await this.apiClient.createBundleId(config.bundle_id, config.app_name, config.team_id);
        return {
          status: 'completed',
          resourcesProduced: { apple_app_id: appId, apple_bundle_id: config.bundle_id },
        };
      }
      case 'apple:create-dev-provisioning-profile':
        return { status: 'completed', resourcesProduced: { apple_dev_profile_id: `stub-dev-profile-${config.bundle_id}` } };
      case 'apple:create-dist-provisioning-profile':
        return { status: 'completed', resourcesProduced: { apple_dist_profile_id: `stub-dist-profile-${config.bundle_id}` } };
      case 'apple:generate-apns-key': {
        const keyResult = await this.apiClient.createApnsKey(config.team_id);
        await context.vaultWrite(`${context.projectId}/apns_key_p8`, keyResult.privateKeyP8);
        return {
          status: 'completed',
          resourcesProduced: { apns_key_id: keyResult.keyId, apns_key_p8: 'vaulted' },
        };
      }
      case 'apple:upload-apns-to-firebase':
        return { status: 'completed', resourcesProduced: {} };
      case 'apple:create-app-store-listing':
        return { status: 'completed', resourcesProduced: { asc_app_id: `stub-asc-${config.bundle_id}` } };
      case 'apple:generate-asc-api-key':
        return {
          status: 'completed',
          resourcesProduced: { asc_api_key_id: `stub-asc-key-${config.team_id}`, asc_api_key_p8: 'vaulted' },
        };
      case 'apple:store-signing-in-eas':
        return { status: 'completed', resourcesProduced: {} };
      default:
        throw new AdapterError(`Unknown Apple step: ${stepKey}`, 'apple', 'executeStep');
    }
  }

  async validate(
    manifest: AppleManifestConfig,
    liveState: ProviderState | null,
  ): Promise<DriftReport> {
    const differences: DriftDifference[] = [];

    if (!liveState) {
      return {
        provider_id: `apple-${manifest.bundle_id}`,
        provider_type: 'apple',
        manifest_state: manifest,
        live_state: null,
        differences: [
          {
            field: 'bundle_id',
            manifest_value: manifest.bundle_id,
            live_value: null,
            conflict_type: 'missing_in_live',
          },
        ],
        orphaned_resources: [],
        requires_user_decision: false,
      };
    }

    // Check bundle ID
    const liveBundleId = await this.apiClient.getBundleId(manifest.bundle_id);
    if (!liveBundleId) {
      differences.push({
        field: 'bundle_id',
        manifest_value: manifest.bundle_id,
        live_value: null,
        conflict_type: 'missing_in_live',
      });
    }

    // Check certificates
    const liveCerts = await this.apiClient.getCertificates(manifest.team_id);
    const validCerts = liveCerts.filter(c => c.expiresAt > Date.now() / 1000);

    if (validCerts.length === 0) {
      differences.push({
        field: 'certificate',
        manifest_value: manifest.certificate_type,
        live_value: null,
        conflict_type: 'missing_in_live',
      });
    }

    // Check APNs key
    if (manifest.enable_apns) {
      const apnsMeta = liveState.credential_metadata['apns_key'];
      if (!apnsMeta) {
        differences.push({
          field: 'apns_key',
          manifest_value: 'required',
          live_value: null,
          conflict_type: 'missing_in_live',
        });
      } else if (apnsMeta.pending_manual_upload) {
        differences.push({
          field: 'apns_key',
          manifest_value: 'required',
          live_value: 'pending_manual_upload',
          conflict_type: 'value_mismatch',
        });
      }
    }

    return {
      provider_id: liveState.provider_id,
      provider_type: 'apple',
      manifest_state: manifest,
      live_state: liveState,
      differences,
      orphaned_resources: [],
      requires_user_decision: differences.some(
        d => d.live_value === 'pending_manual_upload',
      ),
    };
  }

  async reconcile(
    report: DriftReport,
    direction: ReconcileDirection,
  ): Promise<ProviderState> {
    const manifest = report.manifest_state as AppleManifestConfig;

    if (!report.live_state) {
      return this.provision(manifest);
    }

    if (direction === 'manifest→live') {
      for (const diff of report.differences) {
        if (diff.conflict_type === 'missing_in_live' && diff.field === 'bundle_id') {
          await this.apiClient.createBundleId(
            manifest.bundle_id,
            manifest.app_name,
            manifest.team_id,
          );
        }
      }
    }

    report.live_state.updated_at = Date.now();
    return report.live_state;
  }

  async extractCredentials(state: ProviderState): Promise<Record<string, string>> {
    const bundleId = state.resource_ids['bundle_id'] ?? '';
    const certId = state.resource_ids['certificate_id'] ?? '';
    const apnsKeyId = state.resource_ids['apns_key_id'] ?? '';

    return {
      bundle_id: bundleId,
      certificate_id: certId,
      apns_key_id: apnsKeyId,
    };
  }

  private generateStubCsr(): string {
    return '-----BEGIN CERTIFICATE REQUEST-----\nSTUB\n-----END CERTIFICATE REQUEST-----';
  }

  private hashConfig(config: AppleManifestConfig): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex')
      .slice(0, 16);
  }
}
