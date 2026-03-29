/**
 * Step Registry — the complete catalog of provisioning steps and user action gates.
 *
 * All nodes in the provisioning graph are defined here. The buildProvisioningPlan()
 * function assembles a ProvisioningPlan from the selected providers and environments.
 */

import type { ProviderType } from '../providers/types.js';
import type {
  UserActionNode,
  ProvisioningStepNode,
  ProvisioningNode,
  ProvisioningPlan,
  NodeState,
} from './graph.types.js';
import {
  mergeContributorNodes,
  type ProvisioningContributor,
  type ProvisioningContributorContext,
} from './contributors.js';
import {
  DEFAULT_MODULE_IDS,
  type ModuleId,
  MODULE_CATALOG,
  resolveModuleDependencies,
  getProvidersForModules,
  getStepKeysForModules,
} from './module-catalog.js';

// ---------------------------------------------------------------------------
// User Actions (Gates)
// ---------------------------------------------------------------------------

export const USER_ACTIONS: UserActionNode[] = [
  {
    type: 'user-action',
    key: 'user:enroll-apple-developer',
    label: 'Apple Developer Program',
    description:
      'Enroll in the Apple Developer Program ($99/year). Required for App IDs, certificates, and App Store distribution.',
    category: 'account-enrollment',
    provider: 'apple',
    verification: { type: 'api-check', description: 'Verify team ID via App Store Connect API' },
    helpUrl: 'https://developer.apple.com/programs/enroll/',
    dependencies: [],
    produces: [
      {
        key: 'apple_team_id',
        label: 'Apple Team ID',
        description: 'Team ID from Apple Developer account',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:enroll-google-play',
    label: 'Google Play Developer Account',
    description:
      'Register a Google Play Developer account ($25 one-time). Required for Play Console app listings.',
    category: 'account-enrollment',
    provider: 'google-play',
    verification: { type: 'manual-confirm' },
    helpUrl: 'https://play.google.com/console/signup',
    dependencies: [],
    produces: [
      {
        key: 'play_developer_id',
        label: 'Play Developer ID',
        description: 'Google Play developer account ID',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:setup-gcp-billing',
    label: 'GCP Billing Account',
    description:
      'Create or link a Google Cloud billing account. Required for Firebase project creation with paid services.',
    category: 'account-enrollment',
    provider: 'firebase',
    verification: {
      type: 'api-check',
      description: 'Verify billing account via Cloud Billing API',
    },
    helpUrl: 'https://console.cloud.google.com/billing',
    dependencies: [],
    produces: [
      {
        key: 'gcp_billing_account_id',
        label: 'Billing Account ID',
        description: 'GCP billing account identifier',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:acquire-domain',
    label: 'Domain Name',
    description:
      'Purchase or verify ownership of a domain for deep links, universal links, and web presence.',
    category: 'external-configuration',
    provider: 'cloudflare',
    verification: { type: 'manual-confirm' },
    dependencies: [],
    produces: [
      { key: 'domain_name', label: 'Domain', description: 'The registered domain name' },
    ],
  },
  {
    type: 'user-action',
    key: 'user:confirm-dns-nameservers',
    label: 'Update DNS Nameservers',
    description: "Point your domain's nameservers to Cloudflare at your registrar.",
    category: 'external-configuration',
    provider: 'cloudflare',
    verification: {
      type: 'api-check',
      description: 'Cloudflare zone activation check',
    },
    helpUrl: 'https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/',
    dependencies: [{ nodeKey: 'cloudflare:add-domain-zone', required: true }],
    produces: [],
  },
  {
    type: 'user-action',
    key: 'user:provide-github-pat',
    label: 'GitHub Personal Access Token',
    description: 'Generate a GitHub PAT with repo, workflow, and admin:org scopes.',
    category: 'credential-upload',
    provider: 'github',
    verification: { type: 'credential-upload', secretKey: 'github_token' },
    helpUrl: 'https://github.com/settings/tokens',
    dependencies: [],
    produces: [
      { key: 'github_token', label: 'GitHub Token', description: 'PAT for GitHub API access' },
    ],
  },
  {
    type: 'user-action',
    key: 'user:provide-expo-token',
    label: 'Expo Robot Token',
    description: 'Generate an Expo robot token for EAS Build and Submit automation.',
    category: 'credential-upload',
    provider: 'eas',
    verification: { type: 'credential-upload', secretKey: 'expo_token' },
    helpUrl: 'https://expo.dev/accounts/[account]/settings/access-tokens',
    dependencies: [],
    produces: [
      { key: 'expo_token', label: 'Expo Token', description: 'Robot token for EAS API' },
    ],
  },
  {
    type: 'user-action',
    key: 'user:upload-initial-aab',
    label: 'Upload Initial App Bundle',
    description:
      'Google Play requires an initial AAB upload before API access works. Build and upload manually or via EAS.',
    category: 'external-configuration',
    provider: 'google-play',
    verification: {
      type: 'api-check',
      description: 'Check Play Console for existing release via API',
    },
    dependencies: [{ nodeKey: 'google-play:create-app-listing', required: true }],
    produces: [],
  },
];

// ---------------------------------------------------------------------------
// Firebase Steps
// ---------------------------------------------------------------------------

export const FIREBASE_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'firebase:create-gcp-project',
    label: 'Create GCP Project',
    description:
      'Sign in with Google (or use a service account key already in the vault), then create or link the GCP project for this app.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'user:setup-gcp-billing', required: true }],
    interactiveAction: { type: 'oauth', provider: 'firebase', label: 'Connect with Google' },
    produces: [
      {
        key: 'gcp_project_id',
        label: 'GCP Project ID',
        description: 'st-<slug>-<hash6>',
      },
    ],
    estimatedDurationMs: 15000,
  },
  {
    type: 'step',
    key: 'firebase:enable-firebase',
    label: 'Enable Firebase',
    description: 'Activate Firebase services on the GCP project.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:create-gcp-project', required: true }],
    produces: [
      {
        key: 'firebase_project_id',
        label: 'Firebase Project ID',
        description: 'Firebase project identifier',
      },
    ],
    estimatedDurationMs: 10000,
  },
  {
    type: 'step',
    key: 'firebase:create-provisioner-sa',
    label: 'Create Provisioner Service Account',
    description: 'Service account used for project-scoped provisioning operations.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-firebase', required: true }],
    produces: [
      {
        key: 'provisioner_sa_email',
        label: 'Provisioner SA',
        description: 'platform-provisioner@<project>.iam.gserviceaccount.com',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'firebase:bind-provisioner-iam',
    label: 'Bind Provisioner IAM Roles',
    description: 'Grant project-level IAM roles to the provisioner service account.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:create-provisioner-sa', required: true }],
    produces: [],
    estimatedDurationMs: 8000,
  },
  {
    type: 'step',
    key: 'firebase:generate-sa-key',
    label: 'Generate Service Account Key',
    description: 'JSON key generated and stored in the encrypted local vault.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:bind-provisioner-iam', required: true }],
    produces: [
      {
        key: 'service_account_json',
        label: 'SA Key',
        description: 'Vaulted service account JSON',
      },
    ],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'firebase:enable-services',
    label: 'Enable Firebase Services',
    description: 'Enable requested services: Auth, Firestore, Storage, FCM, Analytics, etc.',
    provider: 'firebase',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-firebase', required: true }],
    produces: [
      {
        key: 'enabled_services',
        label: 'Enabled Services',
        description: 'Comma-separated list of enabled Firebase services',
      },
    ],
    estimatedDurationMs: 20000,
  },
  {
    type: 'step',
    key: 'firebase:register-ios-app',
    label: 'Register iOS App',
    description:
      'Register the iOS bundle ID with Firebase to generate GoogleService-Info.plist values.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-firebase', required: true }],
    produces: [
      {
        key: 'firebase_ios_app_id',
        label: 'Firebase iOS App',
        description: 'Firebase app ID for iOS',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'firebase:register-android-app',
    label: 'Register Android App',
    description:
      'Register the Android package name with Firebase to generate google-services.json values.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-firebase', required: true }],
    produces: [
      {
        key: 'firebase_android_app_id',
        label: 'Firebase Android App',
        description: 'Firebase app ID for Android',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'firebase:configure-firestore-rules',
    label: 'Configure Firestore Rules',
    description: 'Deploy Firestore security rules for the target environment.',
    provider: 'firebase',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-services', required: true }],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'firebase:configure-storage-rules',
    label: 'Configure Storage Rules',
    description: 'Deploy Cloud Storage security rules for the target environment.',
    provider: 'firebase',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-services', required: true }],
    produces: [],
    estimatedDurationMs: 3000,
  },
];

// ---------------------------------------------------------------------------
// Cloudflare Steps
// ---------------------------------------------------------------------------

export const CLOUDFLARE_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'cloudflare:add-domain-zone',
    label: 'Add Domain to Cloudflare',
    description: 'Create a Cloudflare zone for the project domain.',
    provider: 'cloudflare',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'user:acquire-domain', required: true }],
    produces: [
      {
        key: 'cloudflare_zone_id',
        label: 'Zone ID',
        description: 'Cloudflare zone identifier',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'cloudflare:configure-dns',
    label: 'Configure DNS Records',
    description: 'Create A/CNAME records for deep link and API routing.',
    provider: 'cloudflare',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'cloudflare:add-domain-zone', required: true },
      { nodeKey: 'user:confirm-dns-nameservers', required: true },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'cloudflare:configure-ssl',
    label: 'Configure SSL',
    description: 'Set SSL mode (full/strict) for the domain.',
    provider: 'cloudflare',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'cloudflare:configure-dns', required: true }],
    produces: [],
    estimatedDurationMs: 2000,
  },
  {
    type: 'step',
    key: 'cloudflare:setup-apple-app-site-association',
    label: 'Deploy apple-app-site-association',
    description: 'Host the AASA file for iOS Universal Links.',
    provider: 'cloudflare',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'apple',
    dependencies: [
      { nodeKey: 'cloudflare:configure-dns', required: true },
      {
        nodeKey: 'apple:register-app-id',
        required: true,
        description: 'Needs bundle ID and team ID for AASA content',
      },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'cloudflare:setup-android-asset-links',
    label: 'Deploy assetlinks.json',
    description: 'Host the Digital Asset Links file for Android App Links.',
    provider: 'cloudflare',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'google-play',
    dependencies: [
      { nodeKey: 'cloudflare:configure-dns', required: true },
      {
        nodeKey: 'google-play:extract-fingerprints',
        required: true,
        description: 'Needs SHA-256 fingerprint for asset links',
      },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'cloudflare:configure-deep-link-routes',
    label: 'Configure Deep Link Routes',
    description: 'Set up Cloudflare Workers or Page Rules for deep link routing.',
    provider: 'cloudflare',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'cloudflare:configure-ssl', required: true }],
    produces: [
      {
        key: 'deep_link_base_url',
        label: 'Deep Link URL',
        description: 'Base URL for deep link routing',
      },
    ],
    estimatedDurationMs: 5000,
  },
];

// ---------------------------------------------------------------------------
// GitHub Steps
// ---------------------------------------------------------------------------

export const GITHUB_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'github:create-repository',
    label: 'Create Repository',
    description: 'Create or link the GitHub repository for the project.',
    provider: 'github',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'user:provide-github-pat', required: true }],
    produces: [
      {
        key: 'github_repo_url',
        label: 'Repository',
        description: 'GitHub repository URL (opens in browser)',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'github:create-environments',
    label: 'Create GitHub Environments',
    description: 'Create deployment environments with protection rules.',
    provider: 'github',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'github:create-repository', required: true }],
    produces: [
      {
        key: 'github_environment_id',
        label: 'Environment ID',
        description: 'GitHub environment identifier',
      },
    ],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'github:inject-secrets',
    label: 'Inject Environment Secrets',
    description:
      'Store Firebase SA key, API keys, and provider tokens as GitHub environment secrets.',
    provider: 'github',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    bridgeTarget: 'firebase',
    dependencies: [
      { nodeKey: 'github:create-environments', required: true },
      {
        nodeKey: 'firebase:generate-sa-key',
        required: true,
        description: 'Firebase service account key to inject',
      },
    ],
    produces: [],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'github:deploy-workflows',
    label: 'Deploy CI/CD Workflows',
    description: 'Create build, test, and deploy workflow YAML files.',
    provider: 'github',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'github:create-repository', required: true }],
    produces: [],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'github:configure-webhook',
    label: 'Configure Webhook',
    description: 'Set up webhook for drift detection and event triggers.',
    provider: 'github',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'github:create-repository', required: true }],
    produces: [
      {
        key: 'github_webhook_id',
        label: 'Webhook ID',
        description: 'GitHub webhook identifier',
      },
    ],
    estimatedDurationMs: 3000,
  },
];

// ---------------------------------------------------------------------------
// Apple Steps
// ---------------------------------------------------------------------------

export const APPLE_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'apple:register-app-id',
    label: 'Register App ID',
    description: 'Register the bundle ID as an App ID in Apple Developer Portal.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'user:enroll-apple-developer', required: true }],
    produces: [
      {
        key: 'apple_app_id',
        label: 'App ID',
        description: 'Apple Developer Portal App ID',
      },
      {
        key: 'apple_bundle_id',
        label: 'Bundle ID',
        description: 'Registered bundle identifier',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'apple:create-dev-provisioning-profile',
    label: 'Create Dev Provisioning Profile',
    description: 'Generate a development provisioning profile for local builds.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'apple:register-app-id', required: true }],
    produces: [
      {
        key: 'apple_dev_profile_id',
        label: 'Dev Profile',
        description: 'Development provisioning profile UUID',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'apple:create-dist-provisioning-profile',
    label: 'Create Distribution Profile',
    description: 'Generate a distribution provisioning profile for TestFlight and App Store.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'apple:register-app-id', required: true }],
    produces: [
      {
        key: 'apple_dist_profile_id',
        label: 'Dist Profile',
        description: 'Distribution provisioning profile UUID',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'apple:generate-apns-key',
    label: 'Generate APNs Key',
    description: 'Create an APNs authentication key (.p8). Can only be downloaded once from Apple.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'assisted',
    dependencies: [{ nodeKey: 'apple:register-app-id', required: true }],
    produces: [
      {
        key: 'apns_key_id',
        label: 'APNs Key ID',
        description: 'Key ID for push notifications',
      },
      {
        key: 'apns_key_p8',
        label: 'APNs Key',
        description: '.p8 private key (one-time download)',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'apple:upload-apns-to-firebase',
    label: 'Upload APNs Key to Firebase',
    description:
      'Register the APNs key with Firebase Cloud Messaging for push notification delivery.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'firebase',
    dependencies: [
      { nodeKey: 'apple:generate-apns-key', required: true },
      { nodeKey: 'firebase:enable-services', required: true, description: 'FCM must be enabled' },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'apple:create-app-store-listing',
    label: 'Create App Store Connect Listing',
    description: 'Create the app record in App Store Connect.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'apple:register-app-id', required: true }],
    produces: [
      {
        key: 'asc_app_id',
        label: 'ASC App ID',
        description: 'App Store Connect app identifier',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'apple:generate-asc-api-key',
    label: 'Generate ASC API Key',
    description: 'Create an App Store Connect API key for automated submissions.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'assisted',
    dependencies: [{ nodeKey: 'apple:create-app-store-listing', required: true }],
    produces: [
      {
        key: 'asc_api_key_id',
        label: 'ASC Key ID',
        description: 'App Store Connect API key ID',
      },
      { key: 'asc_api_key_p8', label: 'ASC Key', description: 'API key for EAS Submit' },
    ],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'apple:store-signing-in-eas',
    label: 'Store Signing Credentials in EAS',
    description:
      'Upload Apple code signing certificates and profiles to EAS for managed signing.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'eas',
    dependencies: [
      { nodeKey: 'apple:create-dist-provisioning-profile', required: true },
      { nodeKey: 'eas:create-project', required: true },
    ],
    produces: [],
    estimatedDurationMs: 5000,
  },
];

// ---------------------------------------------------------------------------
// EAS Steps
// ---------------------------------------------------------------------------

export const EAS_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'eas:create-project',
    label: 'Create EAS Project',
    description: 'Create or link the Expo Application Services project.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'user:provide-expo-token', required: true }],
    produces: [
      {
        key: 'eas_project_id',
        label: 'EAS Project ID',
        description: 'Expo project identifier',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'eas:configure-build-profiles',
    label: 'Configure Build Profiles',
    description:
      'Set up EAS build profiles for each environment (development, preview, production).',
    provider: 'eas',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'eas:create-project', required: true }],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'eas:link-github',
    label: 'Link GitHub Repository',
    description: 'Connect the EAS project to the GitHub repository for automated builds.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'github',
    dependencies: [
      { nodeKey: 'eas:create-project', required: true },
      { nodeKey: 'github:create-repository', required: true },
    ],
    produces: [],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'eas:store-token-in-github',
    label: 'Store EAS Token in GitHub',
    description: 'Add the Expo robot token as a GitHub Actions secret.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'github',
    dependencies: [
      { nodeKey: 'eas:create-project', required: true },
      { nodeKey: 'github:create-repository', required: true },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'eas:configure-submit-apple',
    label: 'Configure EAS Submit (Apple)',
    description: 'Link the ASC API key to EAS for automated iOS submission.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'apple',
    dependencies: [
      { nodeKey: 'eas:create-project', required: true },
      { nodeKey: 'apple:generate-asc-api-key', required: true },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'eas:configure-submit-android',
    label: 'Configure EAS Submit (Android)',
    description: 'Link the Google Play service account to EAS for automated Android submission.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'google-play',
    dependencies: [
      { nodeKey: 'eas:create-project', required: true },
      { nodeKey: 'google-play:create-service-account', required: true },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
];

// ---------------------------------------------------------------------------
// Google Play Steps
// ---------------------------------------------------------------------------

export const GOOGLE_PLAY_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'google-play:create-app-listing',
    label: 'Create Play Console Listing',
    description: 'Create the app in Google Play Console.',
    provider: 'google-play',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'user:enroll-google-play', required: true }],
    produces: [
      {
        key: 'play_app_id',
        label: 'Play App ID',
        description: 'Google Play application ID',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'google-play:create-service-account',
    label: 'Create Play Service Account',
    description:
      'Create a GCP service account with Play Console API access for automated uploads.',
    provider: 'google-play',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'google-play:create-app-listing', required: true },
      {
        nodeKey: 'firebase:create-gcp-project',
        required: true,
        description: 'SA created in the same GCP project',
      },
    ],
    produces: [
      {
        key: 'play_service_account_email',
        label: 'Play SA',
        description: 'Service account for Play Console API',
      },
    ],
    estimatedDurationMs: 8000,
  },
  {
    type: 'step',
    key: 'google-play:setup-internal-testing',
    label: 'Set Up Internal Testing Track',
    description: 'Configure the internal testing track for development builds.',
    provider: 'google-play',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'google-play:create-app-listing', required: true },
      { nodeKey: 'user:upload-initial-aab', required: true },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'google-play:configure-app-signing',
    label: 'Configure App Signing',
    description: 'Enable Google-managed signing and delegate upload key.',
    provider: 'google-play',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'google-play:create-app-listing', required: true },
      { nodeKey: 'user:upload-initial-aab', required: true },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'google-play:extract-fingerprints',
    label: 'Extract Signing Fingerprints',
    description: 'Extract SHA-1 and SHA-256 fingerprints from the Google-managed signing key.',
    provider: 'google-play',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'google-play:configure-app-signing', required: true }],
    produces: [
      {
        key: 'signing_sha1',
        label: 'SHA-1',
        description: 'Signing certificate SHA-1 fingerprint',
      },
      {
        key: 'signing_sha256',
        label: 'SHA-256',
        description: 'Signing certificate SHA-256 fingerprint',
      },
    ],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'google-play:add-fingerprints-to-firebase',
    label: 'Add Fingerprints to Firebase',
    description:
      'Register signing fingerprints with the Firebase Android app for OAuth and deep links.',
    provider: 'google-play',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'firebase',
    dependencies: [
      { nodeKey: 'google-play:extract-fingerprints', required: true },
      { nodeKey: 'firebase:register-android-app', required: true },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
];

// ---------------------------------------------------------------------------
// OAuth Steps
// ---------------------------------------------------------------------------

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
        nodeKey: 'firebase:enable-services',
        required: true,
        description: 'Firebase Auth must be enabled',
      },
    ],
    produces: [],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'oauth:register-oauth-clients',
    label: 'Register OAuth Client IDs',
    description: 'Create Google OAuth client IDs for iOS, Android, and Web.',
    provider: 'oauth',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'oauth:enable-auth-providers', required: true },
      { nodeKey: 'firebase:create-gcp-project', required: true },
    ],
    produces: [
      {
        key: 'oauth_client_id_ios',
        label: 'iOS Client ID',
        description: 'Google OAuth client for iOS',
      },
      {
        key: 'oauth_client_id_android',
        label: 'Android Client ID',
        description: 'Google OAuth client for Android',
      },
      {
        key: 'oauth_client_id_web',
        label: 'Web Client ID',
        description: 'Google OAuth client for Web',
      },
    ],
    estimatedDurationMs: 8000,
  },
  {
    type: 'step',
    key: 'oauth:configure-apple-sign-in',
    label: 'Configure Apple Sign-In',
    description: 'Set up Apple Sign-In service ID and link to Firebase Auth.',
    provider: 'oauth',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'apple',
    dependencies: [
      { nodeKey: 'oauth:enable-auth-providers', required: true },
      { nodeKey: 'apple:register-app-id', required: true },
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
    dependencies: [{ nodeKey: 'oauth:register-oauth-clients', required: true }],
    produces: [],
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
    produces: [],
    estimatedDurationMs: 3000,
  },
];

// ---------------------------------------------------------------------------
// Teardown Steps (reverse-order cleanup)
// ---------------------------------------------------------------------------

export const FIREBASE_TEARDOWN_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'firebase:disable-messaging',
    label: 'Disable Firebase Messaging',
    description: 'Disable FCM configuration and messaging integrations.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'firebase:enable-services',
    dependencies: [],
    produces: [],
  },
  {
    type: 'step',
    key: 'firebase:delete-storage-buckets',
    label: 'Delete Firebase Storage',
    description: 'Remove storage buckets and associated rules for this project.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'firebase:configure-storage-rules',
    dependencies: [],
    produces: [],
  },
  {
    type: 'step',
    key: 'firebase:delete-firestore-data',
    label: 'Delete Firestore Data',
    description: 'Delete Firestore database data and security rules.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'firebase:configure-firestore-rules',
    dependencies: [],
    produces: [],
  },
  {
    type: 'step',
    key: 'firebase:delete-gcp-project',
    label: 'Delete GCP Project',
    description: 'Delete the backing GCP/Firebase project and all managed resources.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'firebase:create-gcp-project',
    dependencies: [
      { nodeKey: 'firebase:delete-storage-buckets', required: true },
      { nodeKey: 'firebase:delete-firestore-data', required: true },
      { nodeKey: 'firebase:disable-messaging', required: true },
    ],
    produces: [],
  },
];

export const GITHUB_TEARDOWN_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'github:delete-workflows',
    label: 'Delete GitHub Workflows',
    description: 'Remove repository workflow files and CI/CD automation.',
    provider: 'github',
    environmentScope: 'global',
    automationLevel: 'full',
    direction: 'teardown',
    teardownOf: 'github:deploy-workflows',
    dependencies: [],
    produces: [],
  },
  {
    type: 'step',
    key: 'github:delete-environments',
    label: 'Delete GitHub Environments',
    description: 'Delete project environments and associated secrets.',
    provider: 'github',
    environmentScope: 'global',
    automationLevel: 'full',
    direction: 'teardown',
    teardownOf: 'github:create-environments',
    dependencies: [{ nodeKey: 'github:delete-workflows', required: true }],
    produces: [],
  },
  {
    type: 'step',
    key: 'github:delete-repository',
    label: 'Delete GitHub Repository',
    description: 'Delete the GitHub repository for this project.',
    provider: 'github',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'github:create-repository',
    dependencies: [{ nodeKey: 'github:delete-environments', required: true }],
    produces: [],
  },
];

export const EAS_TEARDOWN_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'eas:remove-submit-targets',
    label: 'Remove EAS Submit Targets',
    description: 'Remove configured store submission targets from EAS.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    direction: 'teardown',
    teardownOf: 'eas:configure-submit-android',
    dependencies: [],
    produces: [],
  },
  {
    type: 'step',
    key: 'eas:delete-project',
    label: 'Delete EAS Project',
    description: 'Delete the EAS project and build profile configuration.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'eas:create-project',
    dependencies: [{ nodeKey: 'eas:remove-submit-targets', required: true }],
    produces: [],
  },
];

export const APPLE_TEARDOWN_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'apple:revoke-signing-assets',
    label: 'Revoke Apple Signing Assets',
    description: 'Revoke certificates, provisioning profiles, and APNs/ASC keys.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'apple:create-dist-provisioning-profile',
    dependencies: [],
    produces: [],
  },
  {
    type: 'step',
    key: 'apple:remove-app-store-listing',
    label: 'Remove App Store Listing',
    description: 'Delete App Store Connect listing and Apple app registration.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'manual',
    direction: 'teardown',
    teardownOf: 'apple:create-app-store-listing',
    dependencies: [{ nodeKey: 'apple:revoke-signing-assets', required: true }],
    produces: [],
  },
];

export const GOOGLE_PLAY_TEARDOWN_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'google-play:revoke-service-account',
    label: 'Revoke Play Service Account',
    description: 'Remove Google Play API access service account permissions.',
    provider: 'google-play',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'google-play:create-service-account',
    dependencies: [],
    produces: [],
  },
  {
    type: 'step',
    key: 'google-play:remove-app-listing',
    label: 'Remove Play Console Listing',
    description: 'Delete the app listing from Google Play Console.',
    provider: 'google-play',
    environmentScope: 'global',
    automationLevel: 'manual',
    direction: 'teardown',
    teardownOf: 'google-play:create-app-listing',
    dependencies: [{ nodeKey: 'google-play:revoke-service-account', required: true }],
    produces: [],
  },
];

export const CLOUDFLARE_TEARDOWN_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'cloudflare:remove-domain-zone',
    label: 'Remove Domain Zone',
    description: 'Delete Cloudflare zone and DNS configuration for the project domain.',
    provider: 'cloudflare',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'cloudflare:add-domain-zone',
    dependencies: [],
    produces: [],
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
    teardownOf: 'oauth:register-oauth-clients',
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

// ---------------------------------------------------------------------------
// Master catalog: all nodes by provider
// ---------------------------------------------------------------------------

const STEPS_BY_PROVIDER: Record<ProviderType, ProvisioningStepNode[]> = {
  firebase: FIREBASE_STEPS,
  github: GITHUB_STEPS,
  eas: EAS_STEPS,
  apple: APPLE_STEPS,
  'google-play': GOOGLE_PLAY_STEPS,
  cloudflare: CLOUDFLARE_STEPS,
  oauth: OAUTH_STEPS,
};

/** Flat catalog for enriching persisted plans with fields added after first save (e.g. `interactiveAction`). */
export const ALL_PROVISIONING_STEPS: ProvisioningStepNode[] = (
  Object.keys(STEPS_BY_PROVIDER) as ProviderType[]
).flatMap((k) => STEPS_BY_PROVIDER[k]);

const TEARDOWN_STEPS_BY_PROVIDER: Record<ProviderType, ProvisioningStepNode[]> = {
  firebase: FIREBASE_TEARDOWN_STEPS,
  github: GITHUB_TEARDOWN_STEPS,
  eas: EAS_TEARDOWN_STEPS,
  apple: APPLE_TEARDOWN_STEPS,
  'google-play': GOOGLE_PLAY_TEARDOWN_STEPS,
  cloudflare: CLOUDFLARE_TEARDOWN_STEPS,
  oauth: OAUTH_TEARDOWN_STEPS,
};

/**
 * Drop nodes whose required dependencies are absent from the same list.
 * Runs to a fixed point so chains like A → B → missing prune A and B.
 *
 * Cross-provider step edges (e.g. EAS submit → Apple ASC key) are omitted when
 * the dependency's provider is not selected; without this, merge validation fails.
 */
export function pruneNodesWithUnresolvedDependencies(nodes: ProvisioningNode[]): ProvisioningNode[] {
  let current = nodes;
  let changed = true;
  while (changed) {
    changed = false;
    const keys = new Set(current.map((n) => n.key));
    const next = current.filter((n) => {
      for (const dep of n.dependencies) {
        if (dep.required && !keys.has(dep.nodeKey)) {
          changed = true;
          return false;
        }
      }
      return true;
    });
    current = next;
  }
  return current;
}

/**
 * Returns user action nodes relevant to the given set of providers.
 * A user action is included if at least one of its dependents' provider
 * is in the selected set, or if it has no dependents and its own provider
 * is in the set.
 */
function getRelevantUserActions(selectedProviders: ProviderType[]): UserActionNode[] {
  const selectedSet = new Set<ProviderType>(selectedProviders);

  // Build a set of all step keys for the selected providers
  const selectedStepKeys = new Set<string>();
  for (const provider of selectedProviders) {
    for (const step of STEPS_BY_PROVIDER[provider]) {
      selectedStepKeys.add(step.key);
    }
  }

  // A user action is relevant if any selected step depends on it
  return USER_ACTIONS.filter((action) => {
    if (action.provider && selectedSet.has(action.provider)) return true;
    // Also include if any selected step directly depends on this action
    for (const provider of selectedProviders) {
      for (const step of STEPS_BY_PROVIDER[provider]) {
        if (step.dependencies.some((dep) => dep.nodeKey === action.key)) return true;
      }
    }
    // Include transitive: other user actions that depend on this one
    for (const otherAction of USER_ACTIONS) {
      if (
        otherAction.key !== action.key &&
        otherAction.dependencies.some((dep) => dep.nodeKey === action.key)
      ) {
        // Check if otherAction is itself relevant
        if (action.provider && selectedSet.has(action.provider)) return true;
      }
    }
    return false;
  });
}

const coreProvisioningContributor: ProvisioningContributor = {
  id: 'core',
  contributeNodes(ctx: ProvisioningContributorContext): ProvisioningNode[] {
    const steps: ProvisioningStepNode[] = [];
    for (const provider of ctx.selectedProviders) {
      steps.push(...STEPS_BY_PROVIDER[provider]);
    }
    const nodes = [...getRelevantUserActions(ctx.selectedProviders), ...steps];
    return pruneNodesWithUnresolvedDependencies(nodes);
  },
};

/** Core first; push additional contributors for plugin-extended provisioning graphs. */
export const PROVISIONING_CONTRIBUTORS: ProvisioningContributor[] = [coreProvisioningContributor];

function assembleMergedNodes(
  projectId: string,
  selectedProviders: ProviderType[],
  environments: string[],
  selectedModules?: ModuleId[],
): ProvisioningNode[] {
  return mergeContributorNodes(PROVISIONING_CONTRIBUTORS, {
    projectId,
    selectedProviders,
    environments,
    selectedModules,
  });
}

/**
 * Build a ProvisioningPlan for the given project, selected providers, and environments.
 *
 * Steps are gathered from the step catalog for each selected provider.
 * User action gates are inferred from the dependency graph.
 * All nodes start in 'not-started' state.
 */
export function buildProvisioningPlan(
  projectId: string,
  selectedProviders: ProviderType[],
  environments: string[],
  selectedModules?: ModuleId[],
): ProvisioningPlan {
  const nodes = assembleMergedNodes(projectId, selectedProviders, environments, selectedModules);

  const nodeStates = new Map<string, NodeState>();
  for (const node of nodes) {
    if (node.type === 'step' && node.environmentScope === 'per-environment') {
      for (const env of environments) {
        const stateKey = `${node.key}@${env}`;
        nodeStates.set(stateKey, {
          nodeKey: node.key,
          status: 'not-started',
          environment: env,
        });
      }
    } else {
      nodeStates.set(node.key, {
        nodeKey: node.key,
        status: 'not-started',
      });
    }
  }

  return {
    projectId,
    environments,
    selectedModules: selectedModules ? resolveModuleDependencies(selectedModules) : [],
    nodes,
    nodeStates,
  };
}

export function buildTeardownPlan(
  projectId: string,
  selectedProviders: ProviderType[],
  environments: string[],
  selectedModules?: ModuleId[],
): ProvisioningPlan {
  const steps: ProvisioningStepNode[] = [];
  for (const provider of selectedProviders) {
    steps.push(...TEARDOWN_STEPS_BY_PROVIDER[provider]);
  }

  const nodes: ProvisioningNode[] = [...steps];
  const nodeStates = new Map<string, NodeState>();
  for (const step of steps) {
    if (step.environmentScope === 'per-environment') {
      for (const env of environments) {
        const stateKey = `${step.key}@${env}`;
        nodeStates.set(stateKey, { nodeKey: step.key, status: 'not-started', environment: env });
      }
    } else {
      nodeStates.set(step.key, { nodeKey: step.key, status: 'not-started' });
    }
  }

  return {
    projectId,
    environments,
    selectedModules: selectedModules ? resolveModuleDependencies(selectedModules) : [],
    nodes,
    nodeStates,
  };
}

export function buildProvisioningPlanForModules(
  projectId: string,
  selectedModules: ModuleId[],
  environments: string[],
): ProvisioningPlan {
  const resolvedModules = resolveModuleDependencies(selectedModules);
  const providerSet = new Set(getProvidersForModules(resolvedModules));
  const stepKeySet = new Set(getStepKeysForModules(resolvedModules));
  const selectedProviders = Array.from(providerSet);

  const fullPlan = buildProvisioningPlan(projectId, selectedProviders, environments, resolvedModules);
  const filteredNodes = fullPlan.nodes.filter((node) => {
    if (node.type === 'user-action') return true;
    return stepKeySet.has(node.key);
  });
  const prunedNodes = pruneNodesWithUnresolvedDependencies(filteredNodes);

  const nodeStates = new Map<string, NodeState>();
  for (const node of prunedNodes) {
    if (node.type === 'step' && node.environmentScope === 'per-environment') {
      for (const env of environments) {
        nodeStates.set(`${node.key}@${env}`, { nodeKey: node.key, status: 'not-started', environment: env });
      }
      continue;
    }
    nodeStates.set(node.key, { nodeKey: node.key, status: 'not-started' });
  }

  return {
    projectId,
    environments,
    selectedModules: resolvedModules,
    nodes: prunedNodes,
    nodeStates,
  };
}

export function recomputePlanForModules(
  previousPlan: ProvisioningPlan,
  selectedModules: ModuleId[],
): ProvisioningPlan {
  const nextPlan = buildProvisioningPlanForModules(
    previousPlan.projectId,
    selectedModules,
    previousPlan.environments,
  );

  // Preserve all known states/resources for nodes that still exist after module recomputation.
  for (const [stateKey, oldState] of previousPlan.nodeStates.entries()) {
    if (!nextPlan.nodeStates.has(stateKey)) continue;
    nextPlan.nodeStates.set(stateKey, { ...oldState });
  }

  return nextPlan;
}

/**
 * Returns all nodes in the registry for the given providers (no filtering).
 * Useful for display / preview purposes.
 */
export function getAllNodesForProviders(providers: ProviderType[]): ProvisioningNode[] {
  const steps: ProvisioningStepNode[] = [];
  for (const provider of providers) {
    steps.push(...STEPS_BY_PROVIDER[provider]);
  }
  const userActions = getRelevantUserActions(providers);
  return [...userActions, ...steps];
}

export function getAllTeardownNodesForProviders(providers: ProviderType[]): ProvisioningStepNode[] {
  const steps: ProvisioningStepNode[] = [];
  for (const provider of providers) {
    steps.push(...TEARDOWN_STEPS_BY_PROVIDER[provider]);
  }
  return steps;
}

export function getAllModuleDefinitions() {
  return MODULE_CATALOG;
}
