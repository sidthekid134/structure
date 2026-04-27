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
  appleSignInServiceIdVaultPath,
  findAuthKeyByCapability,
  readAppleAuthKeyRegistry,
} from './apple.js';
import {
  addFirebaseAuthorizedDomain,
  configureAppleSignInProvider,
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
    target?: 'all' | 'web' | 'ios' | 'android',
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
    context?: StepContext,
  ): Promise<void>;
  configureAppleSignIn(
    firebaseProjectId: string,
    input: {
      teamId: string;
      keyId: string;
      serviceId: string;
      privateKey?: string;
      bundleIds?: string[];
    },
    context?: StepContext,
  ): Promise<void>;
  getFirebaseAuthProviders(firebaseProjectId: string, context?: StepContext): Promise<string[]>;
  configureRedirectDomains?(
    firebaseProjectId: string,
    domains: string[],
    context?: StepContext,
  ): Promise<void>;
  getAuthorizedDomains?(firebaseProjectId: string, context?: StepContext): Promise<string[]>;
}

export class StubOAuthApiClient implements OAuthApiClient {
  async resolveGoogleClientIds(
    _context: StepContext,
    _target: 'all' | 'web' | 'ios' | 'android' = 'all',
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
    _provider: 'google' | 'github' | 'apple',
    _redirectUri: string,
    _scopes: string[],
    _context?: StepContext,
  ): Promise<{ clientId: string; clientSecret: string }> {
    throw new Error(
      'StubOAuthApiClient cannot create OAuth clients. Configure OAuthAdapter with a real OAuth API client.',
    );
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
    _context?: StepContext,
  ): Promise<void> {
    throw new Error(
      'StubOAuthApiClient cannot wire Firebase auth providers. Configure StudioOAuthApiClient.',
    );
  }

  async configureAppleSignIn(
    _firebaseProjectId: string,
    _input: {
      teamId: string;
      keyId: string;
      serviceId: string;
      privateKey?: string;
      bundleIds?: string[];
    },
    _context?: StepContext,
  ): Promise<void> {
    throw new Error(
      'StubOAuthApiClient cannot configure Apple Sign-In. Configure StudioOAuthApiClient.',
    );
  }

  async getFirebaseAuthProviders(
    _firebaseProjectId: string,
    _context?: StepContext,
  ): Promise<string[]> {
    throw new Error(
      'StubOAuthApiClient cannot read Firebase auth provider state. Configure StudioOAuthApiClient.',
    );
  }

  async configureRedirectDomains(
    _firebaseProjectId: string,
    _domains: string[],
    _context?: StepContext,
  ): Promise<void> {
    throw new Error(
      'StubOAuthApiClient cannot configure redirect domains. Configure StudioOAuthApiClient.',
    );
  }

  async getAuthorizedDomains(
    _firebaseProjectId: string,
    _context?: StepContext,
  ): Promise<string[]> {
    throw new Error(
      'StubOAuthApiClient cannot read Firebase authorized domains. Configure StudioOAuthApiClient.',
    );
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
    target: 'all' | 'web' | 'ios' | 'android' = 'all',
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

    // Platform-decoupled mode: resolve only what the caller requested.
    // This prevents the iOS-only step from failing on Android SHA-1 issues
    // (and vice versa).
    const iosAppId =
      context.upstreamResources['firebase_ios_app_id']?.trim() ||
      (await context.vaultRead(`${studioProjectId}/firebase_ios_app_id`))?.trim() ||
      '';
    const androidAppId =
      context.upstreamResources['firebase_android_app_id']?.trim() ||
      (await context.vaultRead(`${studioProjectId}/firebase_android_app_id`))?.trim() ||
      '';
    const token = await this.getAccessTokenForProject(
      studioProjectId,
      'oauth:register-oauth-client-ids',
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

    let iosClientId = '';
    if ((target === 'all' || target === 'ios') && iosAppId) {
      const iosConfigPlist = await downloadFirebaseIosAppConfig(
        token,
        gcpProjectId,
        iosAppId,
      );
      iosClientId = this.extractIosClientId(iosConfigPlist);
    }

    let androidClientId = '';
    if ((target === 'all' || target === 'android') && androidAppId) {
      const androidConfigJson = await downloadFirebaseAndroidAppConfig(
        token,
        gcpProjectId,
        androidAppId,
      );
      androidClientId = this.extractAndroidClientId(androidConfigJson);
    }

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
    const ids = await this.resolveGoogleClientIds(context, 'web');
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
    context?: StepContext,
  ): Promise<void> {
    if (provider === 'github') {
      throw new Error('GitHub auth wiring is not implemented in StudioOAuthApiClient.');
    }
    const studioProjectId = context?.projectId?.trim() || firebaseProjectId;
    const token = await this.getAccessTokenForProject(
      studioProjectId,
      'oauth:wire-firebase-auth-provider',
    );
    const firebaseProvider = provider === 'google' ? 'google.com' : 'apple.com';
    await configureFirebaseOAuthProvider(token, firebaseProjectId, firebaseProvider, clientId, clientSecret);
  }

  async configureAppleSignIn(
    firebaseProjectId: string,
    input: {
      teamId: string;
      keyId: string;
      serviceId: string;
      privateKey?: string;
      bundleIds?: string[];
    },
    context?: StepContext,
  ): Promise<void> {
    const studioProjectId = context?.projectId?.trim() || firebaseProjectId;
    const token = await this.getAccessTokenForProject(
      studioProjectId,
      'oauth:configure-apple-sign-in',
    );
    await configureAppleSignInProvider(
      token,
      firebaseProjectId,
      input.teamId,
      input.keyId,
      input.serviceId,
      input.privateKey,
      input.bundleIds,
    );
  }

  async getFirebaseAuthProviders(
    firebaseProjectId: string,
    context?: StepContext,
  ): Promise<string[]> {
    const studioProjectId = context?.projectId?.trim() || firebaseProjectId;
    const token = await this.getAccessTokenForProject(
      studioProjectId,
      'oauth:get-firebase-auth-providers',
    );
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
    try {
      const appleIdp = await getFirebaseDefaultSupportedIdpConfig(token, firebaseProjectId, 'apple.com');
      if (appleIdp.enabled) out.push('apple');
    } catch {
      // Missing Apple provider config is a valid state.
    }
    return out;
  }

  async configureRedirectDomains(
    firebaseProjectId: string,
    domains: string[],
    context?: StepContext,
  ): Promise<void> {
    const studioProjectId = context?.projectId?.trim() || firebaseProjectId;
    const token = await this.getAccessTokenForProject(
      studioProjectId,
      'oauth:configure-redirect-uris',
    );
    for (const domain of domains) {
      await addFirebaseAuthorizedDomain(token, firebaseProjectId, domain);
    }
  }

  async getAuthorizedDomains(
    firebaseProjectId: string,
    context?: StepContext,
  ): Promise<string[]> {
    const studioProjectId = context?.projectId?.trim() || firebaseProjectId;
    const token = await this.getAccessTokenForProject(
      studioProjectId,
      'oauth:get-authorized-domains',
    );
    const config = await getFirebaseAuthConfig(token, firebaseProjectId) as {
      authorizedDomains?: string[];
    };
    return Array.isArray(config.authorizedDomains)
      ? config.authorizedDomains.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
      : [];
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
      `Firebase only emits an Android OAuth client once a signing certificate SHA-1 is attached to the Firebase Android app. ` +
      `Run "Register Android Signing SHA-1 with Firebase" (firebase:register-android-sha1) — it accepts a SHA-1 from EAS credentials, ` +
      `Google Play App Signing, or your local debug keystore — then retry. ` +
      `If you opted into the google-play-publishing module, the steps "google-play:extract-fingerprints" and ` +
      `"google-play:add-fingerprints-to-firebase" wire the SHA-1 in automatically.`,
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
    const toHost = (value: string, label: string): string => {
      const trimmed = value.trim();
      if (!trimmed) {
        throw new AdapterError(`${label} is empty.`, 'oauth', 'executeStep');
      }
      if (!trimmed.includes('://')) return trimmed.toLowerCase();
      let host = '';
      try {
        host = new URL(trimmed).hostname.trim().toLowerCase();
      } catch {
        throw new AdapterError(
          `${label} must be a valid hostname or URL. Got: "${value}"`,
          'oauth',
          'executeStep',
        );
      }
      if (!host) {
        throw new AdapterError(`${label} did not resolve to a hostname.`, 'oauth', 'executeStep');
      }
      return host;
    };
    switch (stepKey) {
      case 'oauth:register-oauth-client-web':
      case 'oauth:register-oauth-client-ios':
      case 'oauth:register-oauth-client-android': {
        if (config.oauth_provider !== 'google') {
          throw new AdapterError(
            `${stepKey} currently supports oauth_provider="google", got "${config.oauth_provider}".`,
            'oauth',
            'executeStep',
          );
        }
        if (!this.apiClient.resolveGoogleClientIds) {
          throw new AdapterError(
            `OAuthAdapter is missing a real OAuth API client. Configure StudioOAuthApiClient for ${stepKey}.`,
            'oauth',
            'executeStep',
          );
        }
        const target: 'web' | 'ios' | 'android' =
          stepKey === 'oauth:register-oauth-client-web'
            ? 'web'
            : stepKey === 'oauth:register-oauth-client-ios'
              ? 'ios'
              : 'android';
        const ids = await this.apiClient.resolveGoogleClientIds(context, target);
        const produced: Record<string, string> = {};
        if (stepKey === 'oauth:register-oauth-client-web') {
          produced['oauth_client_id_web'] = ids.webClientId;
        }
        if (stepKey === 'oauth:register-oauth-client-ios') {
          if (!ids.iosClientId) {
            throw new AdapterError(
              'iOS OAuth client ID is missing. Run "Register iOS App" first, then retry this step.',
              'oauth',
              'executeStep',
            );
          }
          produced['oauth_client_id_ios'] = ids.iosClientId;
        }
        if (stepKey === 'oauth:register-oauth-client-android') {
          if (!ids.androidClientId) {
            throw new AdapterError(
              'Android OAuth client ID is missing. Ensure the Firebase Android app exists and has SHA-1 attached, then retry this step.',
              'oauth',
              'executeStep',
            );
          }
          produced['oauth_client_id_android'] = ids.androidClientId;
        }
        return {
          status: 'completed',
          resourcesProduced: produced,
        };
      }
      case 'oauth:configure-apple-sign-in':
      {
        // Decoupled from any specific Apple-side step: this consumer reads
        // the project's unified Apple Auth Key registry and finds whatever
        // key bears the "sign_in_with_apple" capability. Future modules that
        // need a different capability (e.g. Firebase Cloud Messaging proper
        // for the APNs cap) will follow the same pattern.
        const gcpProjectId =
          context.upstreamResources['gcp_project_id']?.trim() ||
          context.upstreamResources['firebase_project_id']?.trim() ||
          (await context.vaultRead(`${context.projectId}/gcp_project_id`))?.trim() ||
          config.firebase_project_id;
        const teamId =
          context.upstreamResources['apple_team_id']?.trim() ||
          (await context.vaultRead('apple/team_id'))?.trim() ||
          (await context.vaultRead(`${context.projectId}/apple_team_id`))?.trim();
        if (!teamId) {
          throw new AdapterError(
            'Apple Team ID is missing. Reconnect the organization-level Apple integration so apple_team_id is seeded into upstream resources before configuring Apple Sign-In.',
            'oauth',
            'executeStep',
          );
        }
        if (!gcpProjectId) {
          throw new AdapterError(
            'Firebase/GCP project ID is missing for Apple Sign-In configuration. Run firebase:create-gcp-project (or set firebase_project_id) before this step.',
            'oauth',
            'executeStep',
          );
        }
        const registry = await readAppleAuthKeyRegistry(context);
        const siwaKey = findAuthKeyByCapability(registry, 'sign_in_with_apple');
        const serviceId =
          context.upstreamResources['apple_sign_in_service_id']?.trim() ||
          (
            await context.vaultRead(appleSignInServiceIdVaultPath(context.projectId))
          )?.trim();
        if (!siwaKey || !serviceId) {
          throw new AdapterError(
            'Apple Sign-In credentials are missing. Run "Register Sign-In Capability on Apple Auth Key" (apple:create-sign-in-key) first \u2014 it registers a key with the Sign In with Apple capability, ensures the App ID config has Sign In with Apple enabled, and collects the Services ID.',
            'oauth',
            'executeStep',
          );
        }
        const { keyId, record } = siwaKey;
        const privateKey = record.p8.trim();
        const bundleIdsRaw =
          context.upstreamResources['apple_bundle_id']?.trim() ||
          (await context.vaultRead(`${context.projectId}/apple_bundle_id`))?.trim();
        const bundleIds = bundleIdsRaw
          ? bundleIdsRaw
              .split(',')
              .map((b) => b.trim())
              .filter(Boolean)
          : undefined;
        await this.apiClient.configureAppleSignIn(
          gcpProjectId,
          {
            teamId,
            keyId,
            serviceId,
            privateKey: privateKey || undefined,
            bundleIds,
          },
          context,
        );
        const webPathNote = privateKey
          ? 'Both the native iOS path AND the web/redirect path are wired (Firebase has the .p8 to mint client secrets).'
          : 'WARNING: no .p8 was found in the project vault, so only the native iOS path will work. The web/redirect path needs the .p8 to mint client secrets at appleid.apple.com/auth/token. Re-run apple:create-sign-in-key.';
        return {
          status: 'completed',
          resourcesProduced: {
            apple_sign_in_service_id: serviceId,
            apple_team_id: teamId,
            apple_auth_key_id_sign_in_with_apple: keyId,
            ...(privateKey ? { apple_auth_key_p8_sign_in_with_apple: 'vaulted' } : {}),
          },
          userPrompt:
            `Apple Sign-In is configured in Firebase using Apple Auth Key "${keyId}" (capabilities: ${record.capabilities.join(', ')}). ${webPathNote} ` +
            `Verify the Services ID Return URL is https://${gcpProjectId}.firebaseapp.com/__/auth/handler in Apple Developer.`,
        };
      }
      case 'oauth:configure-redirect-uris':
      {
        if (!this.apiClient.configureRedirectDomains || !this.apiClient.getAuthorizedDomains) {
          throw new AdapterError(
            'OAuthAdapter is missing redirect-domain support. Configure StudioOAuthApiClient for oauth:configure-redirect-uris.',
            'oauth',
            'executeStep',
          );
        }
        const gcpProjectId =
          context.upstreamResources['gcp_project_id']?.trim() ||
          context.upstreamResources['firebase_project_id']?.trim() ||
          (await context.vaultRead(`${context.projectId}/gcp_project_id`))?.trim() ||
          config.firebase_project_id;
        if (!gcpProjectId) {
          throw new AdapterError(
            'Firebase/GCP project ID is missing. Run firebase:create-gcp-project before configuring redirect URIs.',
            'oauth',
            'executeStep',
          );
        }
        const projectDomainRaw = context.upstreamResources['domain_name']?.trim();
        if (!projectDomainRaw) {
          throw new AdapterError(
            'Project domain is missing. Set the app domain before configuring redirect URIs.',
            'oauth',
            'executeStep',
          );
        }
        const projectDomain = toHost(projectDomainRaw, 'domain_name');
        const deepLinkBaseRaw = context.upstreamResources['deep_link_base_url']?.trim();
        const deepLinkDomain = deepLinkBaseRaw ? toHost(deepLinkBaseRaw, 'deep_link_base_url') : null;
        const firebaseDefaultDomain = `${gcpProjectId}.firebaseapp.com`;
        const firebaseWebDomain = `${gcpProjectId}.web.app`;
        const domains = Array.from(
          new Set(
            [projectDomain, firebaseDefaultDomain, firebaseWebDomain, deepLinkDomain]
              .filter((d): d is string => typeof d === 'string' && d.trim().length > 0),
          ),
        );
        await this.apiClient.configureRedirectDomains(gcpProjectId, domains, context);
        const authorized = await this.apiClient.getAuthorizedDomains(gcpProjectId, context);
        const missingDomains = domains.filter((domain) => !authorized.includes(domain));
        if (missingDomains.length > 0) {
          throw new AdapterError(
            `Firebase authorized domain verification failed for: ${missingDomains.join(', ')}.`,
            'oauth',
            'executeStep',
          );
        }
        const handlerUriPrimary = `https://${projectDomain}/__/auth/handler`;
        const handlerUriFirebase = `https://${firebaseDefaultDomain}/__/auth/handler`;
        return {
          status: 'completed',
          resourcesProduced: {
            oauth_redirect_uri_primary: handlerUriPrimary,
            oauth_redirect_uri_firebase: handlerUriFirebase,
            oauth_authorized_domain_primary: projectDomain,
            ...(deepLinkDomain ? { oauth_authorized_domain_deep_link: deepLinkDomain } : {}),
          },
          userPrompt:
            `Configured Firebase Auth authorized domains for ${context.environment} and verified ${domains.length} domains. ` +
            `Primary redirect handler: ${handlerUriPrimary}`,
        };
      }
      case 'oauth:link-deep-link-domain':
      {
        if (!this.apiClient.configureRedirectDomains || !this.apiClient.getAuthorizedDomains) {
          throw new AdapterError(
            'OAuthAdapter is missing redirect-domain support. Configure StudioOAuthApiClient for oauth:link-deep-link-domain.',
            'oauth',
            'executeStep',
          );
        }
        const deepLinkBase = context.upstreamResources['deep_link_base_url']?.trim();
        if (!deepLinkBase) {
          throw new AdapterError(
            'Deep link base URL is missing. Complete cloudflare:configure-deep-link-routes before linking auth domain.',
            'oauth',
            'executeStep',
          );
        }
        const deepLinkHost = toHost(deepLinkBase, 'deep_link_base_url');
        const gcpProjectId =
          context.upstreamResources['gcp_project_id']?.trim() ||
          context.upstreamResources['firebase_project_id']?.trim() ||
          (await context.vaultRead(`${context.projectId}/gcp_project_id`))?.trim() ||
          config.firebase_project_id;
        if (!gcpProjectId) {
          throw new AdapterError(
            'Firebase/GCP project ID is missing. Run firebase:create-gcp-project before linking auth deep-link domain.',
            'oauth',
            'executeStep',
          );
        }
        await this.apiClient.configureRedirectDomains(gcpProjectId, [deepLinkHost], context);
        const authorized = await this.apiClient.getAuthorizedDomains(gcpProjectId, context);
        if (!authorized.includes(deepLinkHost)) {
          throw new AdapterError(
            `Deep-link auth domain verification failed: "${deepLinkHost}" is not present in Firebase authorized domains.`,
            'oauth',
            'executeStep',
          );
        }
        return {
          status: 'completed',
          resourcesProduced: {
            deep_link_base_url: deepLinkBase,
            oauth_authorized_domain_deep_link: deepLinkHost,
            oauth_redirect_uri_deep_link: `https://${deepLinkHost}/__/auth/handler`,
          },
          userPrompt:
            `Linked deep-link host "${deepLinkHost}" into Firebase Auth authorized domains. ` +
            'Validate Apple Universal Links and Android App Links in a device test build.',
        };
      }
      case 'oauth:prepare-app-integration-kit': {
        const kitBase = `/api/projects/${encodeURIComponent(context.projectId)}/integration-kit/auth`;
        return {
          status: 'completed',
          resourcesProduced: {
            auth_integration_kit_zip: `${kitBase}/zip`,
            auth_integration_prompt: `${kitBase}/prompt`,
          },
        };
      }
      default:
        throw new AdapterError(`Unknown OAuth step: ${stepKey}`, 'oauth', 'executeStep');
    }
  }

  async checkStep(
    stepKey: string,
    config: OAuthManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    switch (stepKey) {
      case 'oauth:enable-auth-providers':
        return { status: 'completed', resourcesProduced: {} };
      case 'oauth:enable-google-sign-in': {
        const providers = await this.apiClient.getFirebaseAuthProviders(
          config.firebase_project_id,
          context,
        );
        if (!providers.includes('google')) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'Google Sign-In is not enabled in Firebase Auth. Enable provider in Firebase Console and re-run provisioning.',
          };
        }
        return { status: 'completed', resourcesProduced: { google_sign_in_enabled: 'true' } };
      }
      case 'oauth:register-oauth-client-web': {
        const web = context.upstreamResources['oauth_client_id_web']?.trim() ?? '';
        if (!web) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'Web OAuth client ID is missing. Re-run the web OAuth client registration step after Google Sign-In is enabled.',
          };
        }
        return {
          status: 'completed',
          resourcesProduced: { oauth_client_id_web: web },
        };
      }
      case 'oauth:register-oauth-client-ios': {
        const ios = context.upstreamResources['oauth_client_id_ios']?.trim() ?? '';
        if (!ios) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'iOS OAuth client ID is missing. Re-run the iOS OAuth client registration step after the Firebase iOS app is registered.',
          };
        }
        return {
          status: 'completed',
          resourcesProduced: { oauth_client_id_ios: ios },
        };
      }
      case 'oauth:register-oauth-client-android': {
        const android = context.upstreamResources['oauth_client_id_android']?.trim() ?? '';
        if (!android) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'Android OAuth client ID is missing. Re-run the Android OAuth client registration step after Firebase Android app + SHA-1 are configured.',
          };
        }
        return {
          status: 'completed',
          resourcesProduced: { oauth_client_id_android: android },
        };
      }
      case 'oauth:configure-apple-sign-in': {
        const providers = await this.apiClient.getFirebaseAuthProviders(
          config.firebase_project_id,
          context,
        );
        const serviceId = context.upstreamResources['apple_sign_in_service_id']?.trim();
        if (!providers.includes('apple') || !serviceId) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'Apple Sign-In is not fully configured. Ensure Firebase Apple provider is enabled and service ID is recorded.',
          };
        }
        return {
          status: 'completed',
          resourcesProduced: { apple_sign_in_service_id: serviceId },
        };
      }
      case 'oauth:configure-redirect-uris': {
        if (!this.apiClient.getAuthorizedDomains) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'OAuthAdapter is missing authorized-domain read support. Configure StudioOAuthApiClient for oauth:configure-redirect-uris.',
          };
        }
        const gcpProjectId =
          context.upstreamResources['gcp_project_id']?.trim() ||
          context.upstreamResources['firebase_project_id']?.trim() ||
          (await context.vaultRead(`${context.projectId}/gcp_project_id`))?.trim() ||
          config.firebase_project_id;
        const domain = context.upstreamResources['domain_name']?.trim()?.toLowerCase();
        if (!gcpProjectId || !domain) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'Project domain or GCP project ID is missing. Set the app domain and complete Firebase project setup before configuring OAuth redirect URIs.',
          };
        }
        const deepLinkBase = context.upstreamResources['deep_link_base_url']?.trim();
        let deepLinkDomain: string | null = null;
        if (deepLinkBase) {
          try {
            deepLinkDomain = new URL(deepLinkBase).hostname.trim().toLowerCase();
          } catch {
            return {
              status: 'failed',
              resourcesProduced: {},
              error:
                `Deep link base URL is invalid ("${deepLinkBase}"). Re-run deep-link configuration before validating OAuth redirect URIs.`,
            };
          }
        }
        const authorizedDomains = await this.apiClient.getAuthorizedDomains(gcpProjectId, context);
        const expectedDomains = Array.from(
          new Set(
            [domain, `${gcpProjectId}.firebaseapp.com`, `${gcpProjectId}.web.app`, deepLinkDomain]
              .filter((d): d is string => typeof d === 'string' && d.length > 0),
          ),
        );
        const missingDomains = expectedDomains.filter((d) => !authorizedDomains.includes(d));
        if (missingDomains.length > 0) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              `Firebase authorized domains are missing: ${missingDomains.join(', ')}. Re-run Configure OAuth Redirect URIs.`,
          };
        }
        return {
          status: 'completed',
          resourcesProduced: {
            oauth_redirect_uri_primary: `https://${domain}/__/auth/handler`,
            oauth_redirect_uri_firebase: `https://${gcpProjectId}.firebaseapp.com/__/auth/handler`,
            oauth_authorized_domain_primary: domain,
            ...(deepLinkDomain ? { oauth_authorized_domain_deep_link: deepLinkDomain } : {}),
          },
        };
      }
      case 'oauth:link-deep-link-domain': {
        const deepLinkBase = context.upstreamResources['deep_link_base_url']?.trim();
        if (!deepLinkBase) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'Deep link base URL is missing. Complete Cloudflare deep-link route setup before linking auth domain.',
          };
        }
        if (!this.apiClient.getAuthorizedDomains) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'OAuthAdapter is missing authorized-domain read support. Configure StudioOAuthApiClient for oauth:link-deep-link-domain.',
          };
        }
        const gcpProjectId =
          context.upstreamResources['gcp_project_id']?.trim() ||
          context.upstreamResources['firebase_project_id']?.trim() ||
          (await context.vaultRead(`${context.projectId}/gcp_project_id`))?.trim() ||
          config.firebase_project_id;
        if (!gcpProjectId) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'Firebase/GCP project ID is missing. Complete Firebase project setup before linking auth deep-link domain.',
          };
        }
        let deepLinkHost = '';
        try {
          deepLinkHost = new URL(deepLinkBase).hostname.trim().toLowerCase();
        } catch {
          return {
            status: 'failed',
            resourcesProduced: {},
            error: `Deep link base URL is invalid ("${deepLinkBase}").`,
          };
        }
        if (!deepLinkHost) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error: `Deep link base URL did not resolve to a hostname ("${deepLinkBase}").`,
          };
        }
        const authorizedDomains = await this.apiClient.getAuthorizedDomains(gcpProjectId, context);
        if (!authorizedDomains.includes(deepLinkHost)) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              `Firebase authorized domains do not include deep-link host "${deepLinkHost}". Re-run Link Auth Deep Link Domain.`,
          };
        }
        return {
          status: 'completed',
          resourcesProduced: {
            deep_link_base_url: deepLinkBase,
            oauth_authorized_domain_deep_link: deepLinkHost,
            oauth_redirect_uri_deep_link: `https://${deepLinkHost}/__/auth/handler`,
          },
        };
      }
      case 'oauth:prepare-app-integration-kit': {
        const zipUrl = context.upstreamResources['auth_integration_kit_zip']?.trim();
        const promptUrl = context.upstreamResources['auth_integration_prompt']?.trim();
        if (!zipUrl || !promptUrl) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'Auth integration kit URLs are missing. Re-run this step to regenerate downloadable integration assets.',
          };
        }
        return {
          status: 'completed',
          resourcesProduced: {
            auth_integration_kit_zip: zipUrl,
            auth_integration_prompt: promptUrl,
          },
        };
      }
      default:
        return { status: 'completed', resourcesProduced: {} };
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
