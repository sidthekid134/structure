import type { ProvisioningStepNode } from '../graph.types.js';

export const OAUTH_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'oauth:enable-auth-providers',
    label: 'Enable Firebase Auth Providers',
    description: 'Enable Google, Apple, and/or GitHub sign-in in Firebase Authentication.',
    provider: 'oauth',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      {
        nodeKey: 'firebase:enable-auth',
        required: true,
        description: 'Firebase Auth API must be enabled',
      },
      {
        nodeKey: 'user:setup-gcp-billing',
        required: true,
        description: 'GCP billing must be linked — Identity Platform requires an active billing account',
      },
    ],
    produces: [],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'oauth:enable-google-sign-in',
    label: 'Enable Google Sign-In',
    description: 'Enable Google as a sign-in provider in Firebase Authentication.',
    provider: 'oauth',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      {
        nodeKey: 'oauth:enable-auth-providers',
        required: true,
        description: 'Identity Platform must be initialised first',
      },
    ],
    produces: [
      {
        key: 'google_sign_in_enabled',
        label: 'Google Sign-In',
        description: 'Google sign-in provider enabled in Firebase Auth',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'oauth:register-oauth-client-web',
    label: 'Register OAuth Client ID (Web)',
    description:
      'Resolve the Google OAuth web client ID from Firebase Google provider configuration. This can run independently of native platform registration.',
    provider: 'oauth',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'oauth:enable-auth-providers', required: true },
      { nodeKey: 'oauth:enable-google-sign-in', required: true },
      { nodeKey: 'firebase:create-gcp-project', required: true },
    ],
    produces: [
      {
        key: 'oauth_client_id_web',
        label: 'Web Client ID',
        description: 'Google OAuth client for Web',
      },
    ],
    estimatedDurationMs: 4000,
  },
  {
    type: 'step',
    key: 'oauth:register-oauth-client-ios',
    label: 'Register OAuth Client ID (iOS)',
    description:
      'Resolve the Google OAuth iOS client ID from GoogleService-Info.plist for the registered Firebase iOS app.',
    provider: 'oauth',
    environmentScope: 'global',
    automationLevel: 'full',
    platforms: ['ios'],
    dependencies: [
      { nodeKey: 'oauth:enable-auth-providers', required: true },
      { nodeKey: 'oauth:enable-google-sign-in', required: true },
      { nodeKey: 'firebase:create-gcp-project', required: true },
      { nodeKey: 'firebase:register-ios-app', required: true },
    ],
    refreshTriggers: [
      'firebase:register-ios-app',
      // SIWA setup often changes iOS auth plumbing; refresh iOS client IDs.
      'apple:create-sign-in-key',
      'oauth:configure-apple-sign-in',
    ],
    produces: [
      {
        key: 'oauth_client_id_ios',
        label: 'iOS Client ID',
        description: 'Google OAuth client for iOS',
      },
    ],
    estimatedDurationMs: 4000,
  },
  {
    type: 'step',
    key: 'oauth:register-oauth-client-android',
    label: 'Register OAuth Client ID (Android)',
    description:
      'Resolve the Google OAuth Android client ID from google-services.json for the registered Firebase Android app. Requires Android SHA-1 to be attached first.',
    provider: 'oauth',
    environmentScope: 'global',
    automationLevel: 'full',
    platforms: ['android'],
    dependencies: [
      { nodeKey: 'oauth:enable-auth-providers', required: true },
      { nodeKey: 'oauth:enable-google-sign-in', required: true },
      { nodeKey: 'firebase:create-gcp-project', required: true },
      { nodeKey: 'firebase:register-android-app', required: true },
      {
        nodeKey: 'firebase:register-android-sha1',
        required: true,
        description:
          'Android OAuth client IDs require a SHA-1 attached to the Firebase Android app.',
      },
      {
        nodeKey: 'google-play:add-fingerprints-to-firebase',
        required: false,
        description:
          'Optional path: when firebase-messaging / google-play-publishing is enabled, SHA-1 can flow from Play App Signing.',
      },
    ],
    refreshTriggers: [
      'firebase:register-android-sha1',
      'google-play:extract-fingerprints',
      'google-play:add-fingerprints-to-firebase',
    ],
    produces: [
      {
        key: 'oauth_client_id_android',
        label: 'Android Client ID',
        description: 'Google OAuth client for Android',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'oauth:configure-apple-sign-in',
    label: 'Configure Apple Sign-In in Firebase',
    description:
      'Wires "Sign In with Apple" into Firebase Auth using the Service ID, Key ID, and .p8 already vaulted by apple:create-sign-in-key. Team ID is reused from the org-level Apple integration; the .p8 is forwarded so both the native iOS path AND the web/redirect path work.',
    provider: 'oauth',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'apple',
    platforms: ['ios'],
    dependencies: [
      { nodeKey: 'oauth:enable-auth-providers', required: true },
      { nodeKey: 'apple:create-sign-in-key', required: true },
    ],
    produces: [
      {
        key: 'apple_sign_in_service_id',
        label: 'Apple Sign-In Service ID',
        description: 'Service ID for Apple OAuth',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'oauth:configure-redirect-uris',
    label: 'Configure OAuth Redirect URIs',
    description: 'Set environment-specific redirect URIs for each OAuth provider.',
    provider: 'oauth',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'oauth:register-oauth-client-web', required: true }],
    produces: [
      {
        key: 'oauth_redirect_uri_primary',
        label: 'Primary OAuth Redirect URI',
        description: 'Primary auth callback URI used for hosted OAuth redirect handling.',
      },
      {
        key: 'oauth_redirect_uri_firebase',
        label: 'Firebase OAuth Redirect URI',
        description: 'Firebase hosted auth callback URI.',
      },
      {
        key: 'oauth_authorized_domain_primary',
        label: 'Primary Authorized Domain',
        description: 'App domain written to Firebase Auth authorized domains.',
      },
      {
        key: 'oauth_authorized_domain_deep_link',
        label: 'Deep Link Authorized Domain',
        description: 'Deep link domain host written to Firebase Auth authorized domains when available.',
      },
    ],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'oauth:link-deep-link-domain',
    label: 'Link Auth Deep Link Domain',
    description:
      'Configure Firebase Auth to use the Cloudflare domain for auth redirects.',
    provider: 'oauth',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    bridgeTarget: 'cloudflare',
    dependencies: [
      { nodeKey: 'oauth:configure-redirect-uris', required: true },
      { nodeKey: 'cloudflare:configure-deep-link-routes', required: true },
    ],
    produces: [
      {
        key: 'deep_link_base_url',
        label: 'Deep Link Base URL',
        description: 'Canonical deep-link base URL used by auth return/deep-link routing.',
      },
      {
        key: 'oauth_authorized_domain_deep_link',
        label: 'Deep Link Authorized Domain',
        description: 'Deep-link host verified in Firebase Auth authorized domains.',
      },
      {
        key: 'oauth_redirect_uri_deep_link',
        label: 'Deep Link Redirect URI',
        description: 'Deep-link hosted OAuth callback URI.',
      },
    ],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'oauth:prepare-app-integration-kit',
    label: 'Prepare App Integration Kit',
    description:
      'Generate a downloadable auth integration kit and LLM-ready prompt for wiring these OAuth settings into your app repository.',
    provider: 'oauth',
    environmentScope: 'global',
    automationLevel: 'manual',
    dependencies: [
      {
        nodeKey: 'oauth:register-oauth-client-web',
        required: false,
        description:
          'When available, resolved OAuth client IDs are embedded into the generated handoff artifacts.',
      },
      {
        nodeKey: 'oauth:configure-apple-sign-in',
        required: false,
        description:
          'If Apple Sign-In is enabled, include Apple provider values in the generated handoff artifacts.',
      },
      {
        nodeKey: 'oauth:link-deep-link-domain',
        required: false,
        description:
          'When deep-link-domain wiring is enabled, include it before generating the final app integration handoff.',
      },
    ],
    refreshTriggers: [
      'oauth:register-oauth-client-web',
      'oauth:register-oauth-client-ios',
      'oauth:register-oauth-client-android',
      'oauth:configure-apple-sign-in',
      'apple:store-signing-in-eas',
    ],
    produces: [
      {
        key: 'auth_integration_kit_zip',
        label: 'Auth Integration Kit',
        description: 'Download URL for the generated auth integration kit zip archive.',
      },
      {
        key: 'auth_integration_prompt',
        label: 'Auth LLM Prompt',
        description: 'Download URL for the generated copy/paste prompt with embedded auth values.',
      },
    ],
    estimatedDurationMs: 1000,
  },
];

export const OAUTH_TEARDOWN_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'oauth:delete-oauth-clients',
    label: 'Delete OAuth Clients',
    description: 'Delete OAuth clients and redirect URI registrations.',
    provider: 'oauth',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'oauth:register-oauth-client-web',
    dependencies: [],
    produces: [],
  },
  {
    type: 'step',
    key: 'oauth:disable-auth-providers',
    label: 'Disable Auth Providers',
    description: 'Disable configured social auth providers in Firebase Auth.',
    provider: 'oauth',
    environmentScope: 'global',
    automationLevel: 'full',
    direction: 'teardown',
    teardownOf: 'oauth:enable-auth-providers',
    dependencies: [{ nodeKey: 'oauth:delete-oauth-clients', required: true }],
    produces: [],
  },
];
