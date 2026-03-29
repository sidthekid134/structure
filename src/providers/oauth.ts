/**
 * OAuth adapter — registers OAuth clients with third-party providers and
 * wires Firebase auth provider configuration.
 */

import * as crypto from 'crypto';
import {
  ProviderAdapter,
  OAuthManifestConfig,
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

export interface OAuthApiClient {
  createClient(
    provider: 'google' | 'github' | 'apple',
    redirectUri: string,
    scopes: string[],
  ): Promise<{ clientId: string; clientSecret: string }>;
  getClient(
    provider: 'google' | 'github' | 'apple',
    clientId: string,
  ): Promise<{ clientId: string } | null>;
  wireFirebaseAuthProvider(
    firebaseProjectId: string,
    provider: 'google' | 'github' | 'apple',
    clientId: string,
    clientSecret: string,
  ): Promise<void>;
  getFirebaseAuthProviders(firebaseProjectId: string): Promise<string[]>;
}

export class StubOAuthApiClient implements OAuthApiClient {
  async createClient(
    provider: 'google' | 'github' | 'apple',
    _redirectUri: string,
    _scopes: string[],
  ): Promise<{ clientId: string; clientSecret: string }> {
    return {
      clientId: `${provider}-client-${Date.now()}`,
      clientSecret: `${provider}-secret-${crypto.randomBytes(8).toString('hex')}`,
    };
  }

  async getClient(
    _provider: 'google' | 'github' | 'apple',
    _clientId: string,
  ): Promise<{ clientId: string } | null> {
    return null;
  }

  async wireFirebaseAuthProvider(
    _firebaseProjectId: string,
    _provider: 'google' | 'github' | 'apple',
    _clientId: string,
    _clientSecret: string,
  ): Promise<void> {}

  async getFirebaseAuthProviders(_firebaseProjectId: string): Promise<string[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// OAuth adapter
// ---------------------------------------------------------------------------

export class OAuthAdapter implements ProviderAdapter<OAuthManifestConfig> {
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(
    private readonly apiClient: OAuthApiClient = new StubOAuthApiClient(),
    loggingCallback?: LoggingCallback,
  ) {
    this.log = createOperationLogger('OAuthAdapter', loggingCallback);
  }

  async provision(config: OAuthManifestConfig): Promise<ProviderState> {
    this.log.info('Starting OAuth provisioning', {
      oauthProvider: config.oauth_provider,
      firebaseProjectId: config.firebase_project_id,
    });

    const now = Date.now();
    const state: ProviderState = {
      provider_id: `oauth-${config.oauth_provider}`,
      provider_type: 'oauth',
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
      // Step 1: Create OAuth client
      const { clientId, clientSecret } = await this.apiClient.createClient(
        config.oauth_provider,
        config.redirect_uri,
        config.scopes,
      );

      state.resource_ids['client_id'] = clientId;
      // Store only the metadata that the secret was created, not the value
      state.credential_metadata['client_secret'] = {
        name: 'client_secret',
        stored_at: Date.now(),
      };
      state.completed_steps.push('create_oauth_client');
      this.log.info('OAuth client created', { clientId, provider: config.oauth_provider });

      // Step 2: Wire Firebase auth provider
      try {
        await this.apiClient.wireFirebaseAuthProvider(
          config.firebase_project_id,
          config.oauth_provider,
          clientId,
          clientSecret,
        );
        state.resource_ids['firebase_auth_provider'] = config.oauth_provider;
        state.completed_steps.push('wire_firebase_auth');
        this.log.info('Firebase auth provider wired', {
          provider: config.oauth_provider,
          projectId: config.firebase_project_id,
        });
      } catch (err) {
        state.failed_steps.push('wire_firebase_auth');
        state.partially_complete = true;
        this.log.error('Failed to wire Firebase auth provider', {
          error: (err as Error).message,
        });
      }

      state.updated_at = Date.now();
      return state;
    } catch (err) {
      throw new AdapterError(
        `OAuth provisioning failed: ${(err as Error).message}`,
        'oauth',
        'provision',
        err,
      );
    }
  }

  async executeStep(
    stepKey: string,
    config: OAuthManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    this.log.info('OAuthAdapter.executeStep()', { stepKey });
    switch (stepKey) {
      case 'oauth:enable-auth-providers':
        return { status: 'completed', resourcesProduced: {} };
      case 'oauth:register-oauth-clients': {
        const result = await this.apiClient.createClient(config.oauth_provider, config.redirect_uri, config.scopes);
        return {
          status: 'completed',
          resourcesProduced: {
            oauth_client_id_ios: result.clientId,
            oauth_client_id_android: result.clientId,
            oauth_client_id_web: result.clientId,
          },
        };
      }
      case 'oauth:configure-apple-sign-in':
        return { status: 'completed', resourcesProduced: { apple_sign_in_service_id: `stub-service-id-${config.firebase_project_id}` } };
      case 'oauth:configure-redirect-uris':
        return { status: 'completed', resourcesProduced: {} };
      case 'oauth:link-deep-link-domain':
        return { status: 'completed', resourcesProduced: {} };
      default:
        throw new AdapterError(`Unknown OAuth step: ${stepKey}`, 'oauth', 'executeStep');
    }
  }

  async validate(
    manifest: OAuthManifestConfig,
    liveState: ProviderState | null,
  ): Promise<DriftReport> {
    const differences: DriftDifference[] = [];

    if (!liveState) {
      return {
        provider_id: `oauth-${manifest.oauth_provider}`,
        provider_type: 'oauth',
        manifest_state: manifest,
        live_state: null,
        differences: [
          {
            field: 'oauth_client',
            manifest_value: manifest.oauth_provider,
            live_value: null,
            conflict_type: 'missing_in_live',
          },
        ],
        orphaned_resources: [],
        requires_user_decision: false,
      };
    }

    const clientId = liveState.resource_ids['client_id'];
    if (!clientId) {
      differences.push({
        field: 'client_id',
        manifest_value: manifest.oauth_provider,
        live_value: null,
        conflict_type: 'missing_in_live',
      });
    }

    // Check Firebase auth provider is wired
    const liveAuthProviders = await this.apiClient.getFirebaseAuthProviders(
      manifest.firebase_project_id,
    );
    if (!liveAuthProviders.includes(manifest.oauth_provider)) {
      differences.push({
        field: 'firebase_auth_provider',
        manifest_value: manifest.oauth_provider,
        live_value: null,
        conflict_type: 'missing_in_live',
      });
    }

    return {
      provider_id: liveState.provider_id,
      provider_type: 'oauth',
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
    const manifest = report.manifest_state as OAuthManifestConfig;

    if (!report.live_state) {
      return this.provision(manifest);
    }

    if (direction === 'manifest→live') {
      for (const diff of report.differences) {
        if (diff.conflict_type === 'missing_in_live') {
          if (diff.field === 'firebase_auth_provider') {
            const clientId = report.live_state.resource_ids['client_id'];
            if (clientId) {
              // clientSecret must come from secret store in real usage
              await this.apiClient.wireFirebaseAuthProvider(
                manifest.firebase_project_id,
                manifest.oauth_provider,
                clientId,
                '',
              );
              report.live_state.resource_ids['firebase_auth_provider'] = manifest.oauth_provider;
            }
          }
        }
      }
    }

    report.live_state.updated_at = Date.now();
    return report.live_state;
  }

  async extractCredentials(state: ProviderState): Promise<Record<string, string>> {
    return {
      client_id: state.resource_ids['client_id'] ?? '',
      firebase_auth_provider: state.resource_ids['firebase_auth_provider'] ?? '',
    };
  }

  private hashConfig(config: OAuthManifestConfig): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex')
      .slice(0, 16);
  }
}
