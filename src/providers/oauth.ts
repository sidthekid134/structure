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
import {
  configureFirebaseOAuthProvider,
  downloadFirebaseAndroidAppConfig,
  downloadFirebaseIosAppConfig,
  getFirebaseAuthConfig,
  getFirebaseDefaultSupportedIdpConfig,
} from '../core/gcp/gcp-api-client.js';

// ---------------------------------------------------------------------------
// API client interface
// ---------------------------------------------------------------------------

export interface OAuthApiClient {
  resolveGoogleClientIds?(
    context: StepContext,
  ): Promise<{
    iosClientId: string;
    androidClientId: string;
    webClientId: string;
    webClientSecret: string;
  }>;
  createClient(
    provider: 'google' | 'github' | 'apple',
    redirectUri: string,
    scopes: string[],
    context?: StepContext,
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
  async resolveGoogleClientIds(
    _context: StepContext,
  ): Promise<{
    iosClientId: string;
    androidClientId: string;
    webClientId: string;
    webClientSecret: string;
  }> {
    throw new Error(
      'StubOAuthApiClient cannot resolve real OAuth client IDs. Configure OAuthAdapter with StudioOAuthApiClient.',
    );
  }

  async createClient(
    provider: 'google' | 'github' | 'apple',
    _redirectUri: string,
    _scopes: string[],
    _context?: StepContext,
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

export class StudioOAuthApiClient implements OAuthApiClient {
  constructor(
    private readonly getAccessTokenForProject: (
      studioProjectId: string,
      reason: string,
    ) => Promise<string>,
  ) {}

  async resolveGoogleClientIds(
    context: StepContext,
  ): Promise<{
    iosClientId: string;
    androidClientId: string;
    webClientId: string;
    webClientSecret: string;
  }> {
    const studioProjectId = context.projectId;
    const gcpProjectId =
      context.upstreamResources['gcp_project_id']?.trim() ||
      context.upstreamResources['firebase_project_id']?.trim() ||
      (await context.vaultRead(`${studioProjectId}/gcp_project_id`))?.trim();
    if (!gcpProjectId) {
      throw new Error(
        `Missing gcp_project_id for "${studioProjectId}". Complete "Create GCP Project" before registering OAuth client IDs.`,
      );
    }

    const iosAppId =
      context.upstreamResources['firebase_ios_app_id']?.trim() ||
      (await context.vaultRead(`${studioProjectId}/firebase_ios_app_id`))?.trim();
    if (!iosAppId) {
      throw new Error(
        `Missing firebase_ios_app_id for "${studioProjectId}". Complete "Register iOS App" before registering OAuth client IDs.`,
      );
    }

    const androidAppId =
      context.upstreamResources['firebase_android_app_id']?.trim() ||
      (await context.vaultRead(`${studioProjectId}/firebase_android_app_id`))?.trim();
    if (!androidAppId) {
      throw new Error(
        `Missing firebase_android_app_id for "${studioProjectId}". Complete "Register Android App" before registering OAuth client IDs.`,
      );
    }

    const token = await this.getAccessTokenForProject(
      studioProjectId,
      'oauth:register-oauth-clients',
    );

    const googleIdp = await getFirebaseDefaultSupportedIdpConfig(
      token,
      gcpProjectId,
      'google.com',
    );
    if (!googleIdp.clientId?.trim()) {
      throw new Error(
        `Google Sign-In clientId is missing on Firebase project "${gcpProjectId}". Enable Google Sign-In and re-run.`,
      );
    }
    if (!googleIdp.clientSecret?.trim()) {
      throw new Error(
        `Google Sign-In clientSecret is missing on Firebase project "${gcpProjectId}". Reconfigure Google Sign-In and re-run.`,
      );
    }

    const iosConfigPlist = await downloadFirebaseIosAppConfig(
      token,
      gcpProjectId,
      iosAppId,
    );
    const iosClientId = this.extractIosClientId(iosConfigPlist);

    const androidConfigJson = await downloadFirebaseAndroidAppConfig(
      token,
      gcpProjectId,
      androidAppId,
    );
    const androidClientId = this.extractAndroidClientId(androidConfigJson);

    return {
      iosClientId,
      androidClientId,
      webClientId: googleIdp.clientId,
      webClientSecret: googleIdp.clientSecret,
    };
  }

  async createClient(
    provider: 'google' | 'github' | 'apple',
    _redirectUri: string,
    _scopes: string[],
    context?: StepContext,
  ): Promise<{ clientId: string; clientSecret: string }> {
    if (provider !== 'google') {
      throw new Error(`Studio OAuth client creation is only implemented for provider "${provider}".`);
    }
    if (!context) {
      throw new Error('StepContext is required to resolve OAuth client IDs for Google.');
    }
    const ids = await this.resolveGoogleClientIds(context);
    return { clientId: ids.webClientId, clientSecret: ids.webClientSecret };
  }

  async getClient(
    _provider: 'google' | 'github' | 'apple',
    _clientId: string,
  ): Promise<{ clientId: string } | null> {
    return null;
  }

  async wireFirebaseAuthProvider(
    firebaseProjectId: string,
    provider: 'google' | 'github' | 'apple',
    clientId: string,
    clientSecret: string,
  ): Promise<void> {
    if (provider === 'github') {
      throw new Error('GitHub auth wiring is not implemented in StudioOAuthApiClient.');
    }
    const token = await this.getAccessTokenForProject(firebaseProjectId, 'oauth:wire-firebase-auth-provider');
    const firebaseProvider = provider === 'google' ? 'google.com' : 'apple.com';
    await configureFirebaseOAuthProvider(token, firebaseProjectId, firebaseProvider, clientId, clientSecret);
  }

  async getFirebaseAuthProviders(firebaseProjectId: string): Promise<string[]> {
    const token = await this.getAccessTokenForProject(firebaseProjectId, 'oauth:get-firebase-auth-providers');
    const config = await getFirebaseAuthConfig(token, firebaseProjectId) as {
      signIn?: { email?: { enabled?: boolean } };
    };
    const out: string[] = [];
    if (config.signIn?.email?.enabled) out.push('email');
    try {
      const googleIdp = await getFirebaseDefaultSupportedIdpConfig(token, firebaseProjectId, 'google.com');
      if (googleIdp.enabled) out.push('google');
    } catch {
      // Missing Google provider config is a valid state.
    }
    return out;
  }

  private extractIosClientId(plist: string): string {
    const match = plist.match(/<key>\s*CLIENT_ID\s*<\/key>\s*<string>\s*([^<]+)\s*<\/string>/);
    if (!match?.[1]) {
      throw new Error('Could not parse CLIENT_ID from GoogleService-Info.plist.');
    }
    return match[1].trim();
  }

  private extractAndroidClientId(json: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new Error(`google-services.json is not valid JSON: ${(err as Error).message}`);
    }
    const root = parsed as {
      client?: Array<{
        client_info?: { android_client_info?: { package_name?: string } };
        oauth_client?: Array<{
          client_id?: string;
          client_type?: number;
          android_info?: { package_name?: string };
        }>;
      }>;
    };
    const clients = root.client ?? [];

    // Primary: Firebase android oauth entries are marked with client_type=1.
    for (const client of clients) {
      const androidOauth = (client.oauth_client ?? []).find(
        (entry) =>
          entry.client_type === 1 &&
          typeof entry.client_id === 'string' &&
          entry.client_id.trim().length > 0,
      );
      if (androidOauth?.client_id) {
        return androidOauth.client_id.trim();
      }
    }

    const observedClientTypes = clients
      .flatMap((client) => client.oauth_client ?? [])
      .map((entry) => entry.client_type)
      .filter((t): t is number => typeof t === 'number');
    throw new Error(
      `Could not locate Android OAuth client_id in google-services.json (expected oauth_client.client_type=1). ` +
      `Observed client types: ${observedClientTypes.length ? observedClientTypes.join(', ') : 'none'}. ` +
      `Run "google-play:extract-fingerprints" and "google-play:add-fingerprints-to-firebase" first ` +
      `or add an Android SHA-1 fingerprint in Firebase Console, then retry.`,
    );
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
      case 'oauth:register-oauth-clients': {
        if (config.oauth_provider !== 'google') {
          throw new AdapterError(
            `oauth:register-oauth-clients currently supports oauth_provider="google", got "${config.oauth_provider}".`,
            'oauth',
            'executeStep',
          );
        }
        if (!this.apiClient.resolveGoogleClientIds) {
          throw new AdapterError(
            'OAuthAdapter is missing a real OAuth API client. Configure StudioOAuthApiClient for oauth:register-oauth-clients.',
            'oauth',
            'executeStep',
          );
        }
        const ids = await this.apiClient.resolveGoogleClientIds(context);
        return {
          status: 'completed',
          resourcesProduced: {
            oauth_client_id_ios: ids.iosClientId,
            oauth_client_id_android: ids.androidClientId,
            oauth_client_id_web: ids.webClientId,
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
