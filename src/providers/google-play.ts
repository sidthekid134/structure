/**
 * Google Play adapter — creates Play Store app listings and registers
 * SHA-1 fingerprints from GitHub secrets.
 */

import * as crypto from 'crypto';
import {
  ProviderAdapter,
  GooglePlayManifestConfig,
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

export interface GooglePlayApiClient {
  createApp(packageName: string, title: string, language: string): Promise<string>;
  getApp(packageName: string): Promise<{ packageName: string; title: string } | null>;
  registerFingerprint(packageName: string, sha1: string): Promise<void>;
  getFingerprints(packageName: string): Promise<string[]>;
}

export class StubGooglePlayApiClient implements GooglePlayApiClient {
  async createApp(
    packageName: string,
    _title: string,
    _language: string,
  ): Promise<string> {
    throw new Error(
      'StubGooglePlayApiClient cannot create Play apps. Configure GooglePlayAdapter with a real Google Play API client.',
    );
  }

  async getApp(
    _packageName: string,
  ): Promise<{ packageName: string; title: string } | null> {
    throw new Error(
      'StubGooglePlayApiClient cannot query Play apps. Configure GooglePlayAdapter with a real Google Play API client.',
    );
  }

  async registerFingerprint(_packageName: string, _sha1: string): Promise<void> {
    throw new Error(
      'StubGooglePlayApiClient cannot register fingerprints. Configure GooglePlayAdapter with a real Google Play API client.',
    );
  }

  async getFingerprints(_packageName: string): Promise<string[]> {
    throw new Error(
      'StubGooglePlayApiClient cannot list fingerprints. Configure GooglePlayAdapter with a real Google Play API client.',
    );
  }
}

// ---------------------------------------------------------------------------
// Google Play adapter
// ---------------------------------------------------------------------------

export class GooglePlayAdapter implements ProviderAdapter<GooglePlayManifestConfig> {
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(
    private readonly apiClient: GooglePlayApiClient = new StubGooglePlayApiClient(),
    loggingCallback?: LoggingCallback,
  ) {
    this.log = createOperationLogger('GooglePlayAdapter', loggingCallback);
  }

  async provision(config: GooglePlayManifestConfig): Promise<ProviderState> {
    this.log.info('Starting Google Play provisioning', {
      packageName: config.package_name,
    });

    const now = Date.now();
    const state: ProviderState = {
      provider_id: `google-play-${config.package_name}`,
      provider_type: 'google-play',
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
      // Step 1: Create or reuse app
      const existing = await this.apiClient.getApp(config.package_name);
      if (!existing) {
        await this.apiClient.createApp(
          config.package_name,
          config.app_title,
          config.default_language,
        );
        this.log.info('Google Play app created', { packageName: config.package_name });
      }

      state.resource_ids['package_name'] = config.package_name;
      state.completed_steps.push('create_app');

      state.updated_at = Date.now();
      return state;
    } catch (err) {
      throw new AdapterError(
        `Google Play provisioning failed: ${(err as Error).message}`,
        'google-play',
        'provision',
        err,
      );
    }
  }

  /**
   * Registers a SHA-1 fingerprint from GitHub secrets with Google Play.
   * Called after GitHub provisioning has stored the signing key fingerprint.
   */
  async registerFingerprintFromSecret(
    packageName: string,
    sha1Fingerprint: string,
  ): Promise<void> {
    await this.apiClient.registerFingerprint(packageName, sha1Fingerprint);
    this.log.info('SHA-1 fingerprint registered with Google Play', { packageName });
  }

  async executeStep(
    stepKey: string,
    config: GooglePlayManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    this.log.info('GooglePlayAdapter.executeStep()', { stepKey });
    switch (stepKey) {
      case 'google-play:create-app-listing': {
        const existing = await this.apiClient.getApp(config.package_name);
        const appId = existing
          ? existing.packageName
          : await this.apiClient.createApp(config.package_name, config.app_title, config.default_language);
        return { status: 'completed', resourcesProduced: { play_app_id: appId } };
      }
      case 'google-play:create-service-account':
      {
        const email = context.upstreamResources['play_service_account_email']?.trim();
        if (!email) {
          return {
            status: 'waiting-on-user',
            resourcesProduced: {},
            userPrompt:
              'Create a Play Console service account and grant API access, then provide play_service_account_email before continuing.',
          };
        }
        return { status: 'completed', resourcesProduced: { play_service_account_email: email } };
      }
      case 'google-play:setup-internal-testing':
        return { status: 'completed', resourcesProduced: {} };
      case 'google-play:configure-app-signing':
        return { status: 'completed', resourcesProduced: {} };
      case 'google-play:extract-fingerprints':
      {
        const sha1 = context.upstreamResources['signing_sha1']?.trim();
        const sha256 = context.upstreamResources['signing_sha256']?.trim();
        if (!sha1 || !sha256) {
          return {
            status: 'waiting-on-user',
            resourcesProduced: {},
            userPrompt:
              'Extract SHA-1 and SHA-256 signing fingerprints from Play Console and provide signing_sha1/signing_sha256.',
          };
        }
        return {
          status: 'completed',
          resourcesProduced: { signing_sha1: sha1, signing_sha256: sha256 },
        };
      }
      case 'google-play:add-fingerprints-to-firebase':
        return { status: 'completed', resourcesProduced: {} };
      default:
        throw new AdapterError(`Unknown Google Play step: ${stepKey}`, 'google-play', 'executeStep');
    }
  }

  async validate(
    manifest: GooglePlayManifestConfig,
    liveState: ProviderState | null,
  ): Promise<DriftReport> {
    const differences: DriftDifference[] = [];

    if (!liveState) {
      return {
        provider_id: `google-play-${manifest.package_name}`,
        provider_type: 'google-play',
        manifest_state: manifest,
        live_state: null,
        differences: [
          {
            field: 'app',
            manifest_value: manifest.package_name,
            live_value: null,
            conflict_type: 'missing_in_live',
          },
        ],
        orphaned_resources: [],
        requires_user_decision: false,
      };
    }

    const liveApp = await this.apiClient.getApp(manifest.package_name);
    if (!liveApp) {
      differences.push({
        field: 'package_name',
        manifest_value: manifest.package_name,
        live_value: null,
        conflict_type: 'missing_in_live',
      });
    } else if (liveApp.title !== manifest.app_title) {
      differences.push({
        field: 'app_title',
        manifest_value: manifest.app_title,
        live_value: liveApp.title,
        conflict_type: 'value_mismatch',
      });
    }

    return {
      provider_id: liveState.provider_id,
      provider_type: 'google-play',
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
    const manifest = report.manifest_state as GooglePlayManifestConfig;

    if (!report.live_state) {
      return this.provision(manifest);
    }

    if (direction === 'manifest→live') {
      const missing = report.differences.filter(d => d.conflict_type === 'missing_in_live');
      if (missing.length > 0) {
        await this.provision(manifest);
      }
    }

    report.live_state.updated_at = Date.now();
    return report.live_state;
  }

  async extractCredentials(state: ProviderState): Promise<Record<string, string>> {
    return {
      package_name: state.resource_ids['package_name'] ?? '',
    };
  }

  private hashConfig(config: GooglePlayManifestConfig): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex')
      .slice(0, 16);
  }
}
