/**
 * Step Registry — the complete catalog of provisioning steps and user action gates.
 *
 * All nodes in the provisioning graph are defined here. The buildProvisioningPlan()
 * function assembles a ProvisioningPlan from the selected providers and environments.
 */

import type { ProviderType } from '../providers/types.js';
import type {
  MobilePlatform,
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
  platformMaskAllows,
  getEffectiveModuleCatalog,
} from './module-catalog.js';
import { globalPluginRegistry } from '../plugins/plugin-registry.js';

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
    platforms: ['ios'],
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
    platforms: ['android'],
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
    key: 'user:provide-cloudflare-token',
    label: 'Connect Cloudflare API Token',
    description:
      'Provide a Cloudflare API token with Zone:Read and DNS:Edit permissions so Studio can manage domain, DNS, SSL, and auth routing.',
    category: 'credential-upload',
    provider: 'cloudflare',
    verification: { type: 'credential-upload', secretKey: 'cloudflare_token' },
    helpUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    dependencies: [],
    produces: [
      {
        key: 'cloudflare_token',
        label: 'Cloudflare Token',
        description: 'Cloudflare API token stored in project credentials',
      },
    ],
  },
  {
    type: 'user-action',
    key: 'user:confirm-dns-nameservers',
    label: 'Verify Main Domain Ownership',
    description: "Point your domain's nameservers to Cloudflare at your registrar.",
    category: 'external-configuration',
    provider: 'cloudflare',
    verification: {
      type: 'api-check',
      description: 'Cloudflare zone activation check',
    },
    helpUrl: 'https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/',
    dependencies: [
      { nodeKey: 'user:provide-cloudflare-token', required: true },
      { nodeKey: 'cloudflare:add-domain-zone', required: true },
    ],
    produces: [
      {
        key: 'cloudflare_zone_status',
        label: 'Zone Activation Status',
        description: 'Cloudflare zone activation status for the main domain',
      },
    ],
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
    key: 'user:install-expo-github-app',
    label: 'Install Expo GitHub App',
    description:
      'In Expo account settings, install/activate the Expo GitHub App for your GitHub user/org and grant it access to this repository.',
    category: 'external-configuration',
    provider: 'eas',
    verification: {
      type: 'api-check',
      description:
        'Expo GraphQL: this Expo project must show the same GitHub repo linked as in Studio (owner + repo from your created repository)',
    },
    helpUrl: 'https://docs.expo.dev/eas-update/github-integration/',
    dependencies: [
      { nodeKey: 'eas:create-project', required: true },
      { nodeKey: 'github:create-repository', required: true },
    ],
    produces: [],
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
    platforms: ['android'],
    dependencies: [{ nodeKey: 'google-play:create-app-listing', required: true }],
    produces: [],
  },
  {
    type: 'user-action',
    key: 'user:verify-auth-integration-kit',
    label: 'Verify App Integration Kit Applied',
    description:
      'Confirm the generated auth integration kit was applied in your app repository and auth session behavior is verified end-to-end.',
    category: 'approval',
    provider: 'oauth',
    verification: { type: 'manual-confirm' },
    dependencies: [{ nodeKey: 'oauth:prepare-app-integration-kit', required: true }],
    produces: [
      {
        key: 'auth_integration_verified',
        label: 'Auth Integration Verified',
        description: 'User confirmed app-level auth integration was applied and validated.',
      },
    ],
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
    key: 'firebase:register-ios-app',
    label: 'Register iOS App',
    description:
      'Register the iOS bundle ID with Firebase to generate GoogleService-Info.plist values.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    platforms: ['ios'],
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
    platforms: ['android'],
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
    key: 'firebase:register-android-sha1',
    label: 'Register Android Signing SHA-1 with Firebase',
    description:
      'Attach an Android signing certificate SHA-1 fingerprint to the Firebase Android app. ' +
      'Firebase only emits an Android OAuth client ID in google-services.json once a SHA-1 is registered, ' +
      'so this is required for native Google Sign-In on Android. ' +
      'Sources (in priority order): the SHA-1 produced upstream by `google-play:extract-fingerprints` (Play App Signing), ' +
      'the value pasted into the `signing_sha1` input field below (e.g. from `eas credentials` or your debug keystore), ' +
      'or, if neither is available, this step pauses and waits for the user to register one in the Firebase Console.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    platforms: ['android'],
    dependencies: [
      { nodeKey: 'firebase:register-android-app', required: true },
      // Optional: when google-play-publishing is selected, the upstream
      // `signing_sha1` resource flows through and we skip the input field.
      {
        nodeKey: 'google-play:extract-fingerprints',
        required: false,
        description:
          'When the Google Play module is enabled, the SHA-1 from Play App Signing is reused automatically.',
      },
    ],
    inputFields: [
      {
        key: 'signing_sha1',
        label: 'Android Signing SHA-1',
        description:
          'SHA-1 fingerprint (40 hex chars, with or without colon separators). Get it from `eas credentials → Android → Production → Keystore → SHA1 Fingerprint`, ' +
          'Google Play Console → App signing, or from your local debug keystore via `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android`. ' +
          'Leave blank if it has already been registered upstream by `google-play:extract-fingerprints` or directly in the Firebase Console.',
        type: 'text',
        placeholder: 'AB:CD:EF:01:23:45:...',
        required: false,
      },
    ],
    produces: [
      {
        key: 'android_signing_sha1',
        label: 'Android SHA-1 (registered)',
        description:
          'Normalized SHA-1 fingerprint that has been attached to the Firebase Android app.',
      },
    ],
    estimatedDurationMs: 4000,
  },
  {
    type: 'step',
    key: 'firebase:create-firestore-db',
    label: 'Create Firestore Database',
    description: 'Enable Firestore APIs and create a Firestore database instance in native or datastore mode at the selected region.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-firebase', required: true }],
    inputFields: [
      {
        key: 'database_id',
        label: 'Database ID',
        description: 'Firestore database ID. Defaults to your app name. Use "(default)" for the GCP default database.',
        type: 'text',
        placeholder: 'my-app',
        defaultValue: '{slug}',
        required: true,
      },
      {
        key: 'location_id',
        label: 'Location',
        description: 'GCP region for the Firestore database. Cannot be changed after creation.',
        type: 'select',
        defaultValue: 'us-central1',
        options: [
          'us-central1',
          'us-east1',
          'us-east4',
          'us-west1',
          'europe-west1',
          'europe-west2',
          'europe-west3',
          'asia-east1',
          'asia-northeast1',
          'asia-south1',
          'australia-southeast1',
          'southamerica-east1',
        ],
        required: true,
      },
      {
        key: 'database_type',
        label: 'Mode',
        description: 'Firestore mode. Native is the standard document database; Datastore mode is for Datastore-compatible workloads.',
        type: 'select',
        defaultValue: 'FIRESTORE_NATIVE',
        options: ['FIRESTORE_NATIVE', 'DATASTORE_MODE'],
        required: true,
      },
    ],
    produces: [
      {
        key: 'firestore_database_id',
        label: 'Firestore Database',
        description: 'Firestore database ID (e.g. "(default)")',
      },
      {
        key: 'firestore_location',
        label: 'Firestore Location',
        description: 'GCP region where the database is hosted',
      },
    ],
    estimatedDurationMs: 30000,
  },
  {
    type: 'step',
    key: 'firebase:configure-firestore-rules',
    label: 'Configure Firestore Rules',
    description:
      'Deploy Firestore security rules for the target database and verify users/{userId} auth-scoped access is present.',
    provider: 'firebase',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:create-firestore-db', required: true }],
    produces: [
      {
        key: 'user_persistence_store',
        label: 'User Persistence Store',
        description: 'Backing store used for user records',
      },
      {
        key: 'users_collection_path',
        label: 'Users Collection Path',
        description: 'Canonical Firestore collection used for app user records',
      },
      {
        key: 'firestore_database_id',
        label: 'Firestore Database',
        description: 'Database ID where users collection rules are enforced',
      },
    ],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'firebase:enable-auth',
    label: 'Enable Firebase Auth',
    description: 'Enable the Firebase Authentication API on the GCP project.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-firebase', required: true }],
    produces: [
      {
        key: 'enabled_auth_api',
        label: 'Auth API',
        description: 'identitytoolkit.googleapis.com enabled',
      },
    ],
    estimatedDurationMs: 10000,
  },
  {
    type: 'step',
    key: 'firebase:enable-storage',
    label: 'Enable Cloud Storage',
    description: 'Enable the Cloud Storage and Firebase Rules APIs on the GCP project.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-firebase', required: true }],
    produces: [
      {
        key: 'enabled_storage_api',
        label: 'Storage API',
        description: 'storage.googleapis.com + firebaserules.googleapis.com enabled',
      },
    ],
    estimatedDurationMs: 10000,
  },
  {
    type: 'step',
    key: 'firebase:enable-fcm',
    label: 'Enable Firebase Messaging',
    description: 'Enable the Firebase Cloud Messaging API on the GCP project.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-firebase', required: true }],
    produces: [
      {
        key: 'enabled_fcm_api',
        label: 'FCM API',
        description: 'fcmregistrations.googleapis.com enabled',
      },
    ],
    estimatedDurationMs: 10000,
  },
  {
    type: 'step',
    key: 'firebase:configure-storage-rules',
    label: 'Configure Storage Rules',
    description: 'Deploy Cloud Storage security rules for the target environment.',
    provider: 'firebase',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'firebase:enable-storage', required: true }],
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
    dependencies: [{ nodeKey: 'user:provide-cloudflare-token', required: true }],
    produces: [
      {
        key: 'cloudflare_zone_id',
        label: 'Zone ID',
        description: 'Cloudflare zone identifier',
      },
      {
        key: 'cloudflare_zone_domain',
        label: 'Zone Domain',
        description: 'Cloudflare managed zone (apex domain)',
      },
      {
        key: 'cloudflare_app_domain',
        label: 'App Domain',
        description: 'Domain/host used by auth callbacks and deep links',
      },
      {
        key: 'cloudflare_domain_mode',
        label: 'Domain Mode',
        description: 'Whether app domain is the zone root or a subdomain',
      },
      {
        key: 'cloudflare_zone_status',
        label: 'Zone Status',
        description: 'Cloudflare zone status (pending / active)',
      },
      {
        key: 'cloudflare_zone_nameservers',
        label: 'Assigned Nameservers',
        description: 'Cloudflare nameservers that must be set at registrar',
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
    produces: [
      {
        key: 'cloudflare_dns_record_name',
        label: 'DNS Record Name',
        description: 'Record name inside the Cloudflare zone (e.g. @ or app)',
      },
    ],
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
    platforms: ['ios'],
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
    platforms: ['android'],
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
      {
        key: 'oauth_redirect_uri_deep_link',
        label: 'Deep Link Redirect URI',
        description: 'OAuth callback path hosted on the deep-link domain',
      },
      {
        key: 'auth_landing_url',
        label: 'Auth Landing URL',
        description: 'Hosted landing endpoint used for auth return flow',
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
    inputFields: [
      {
        key: 'github_owner',
        label: 'GitHub Owner / Org',
        description: 'Optional override for where the repository should be created (user or organization name).',
        type: 'text',
        placeholder: 'my-org',
        required: false,
      },
    ],
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
];

// ---------------------------------------------------------------------------
// Apple Steps
// ---------------------------------------------------------------------------

export const APPLE_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'apple:register-app-id',
    label: 'Register App ID',
    description:
      'Register (or verify) the bundle ID as an App ID in Apple Developer / App Store Connect. Fully automated via the org-level Apple integration — no manual App ID input is required.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'full',
    platforms: ['ios'],
    dependencies: [{ nodeKey: 'user:enroll-apple-developer', required: true }],
    produces: [
      {
        key: 'apple_app_id',
        label: 'App ID',
        description: 'Apple Developer Portal App ID (Team Prefix + bundle identifier)',
      },
      {
        key: 'apple_bundle_id',
        label: 'Bundle ID',
        description: 'Registered bundle identifier (sourced from the project)',
      },
    ],
    estimatedDurationMs: 5000,
  },
  // NOTE: apple:create-dev-provisioning-profile and
  // apple:create-dist-provisioning-profile used to live here as manual
  // "open Apple Developer → Profiles, paste the UUID into the vault" steps.
  // They were removed once we standardized on EAS-managed iOS signing:
  //   - EAS Build manages certificates + provisioning profiles
  //     automatically using the same App Store Connect Team Key configured
  //     at the org level (see apple:store-signing-in-eas).
  //   - Dev profiles also require ≥1 registered device UDID, which Studio
  //     does not collect — making full automation impractical.
  // If you need to re-introduce Studio-owned profile creation, restore the
  // step definitions from git history and the executeStep handlers in
  // src/providers/apple.ts.
  // Both apple:generate-apns-key and apple:create-sign-in-key share a
  // unified input model around a single "Apple Auth Key" (.p8) per project.
  // Apple's keys are NOT capability-bound: one .p8 can carry APNs + Sign In
  // with Apple + DeviceCheck + MusicKit by toggling capability checkboxes in
  // Apple Developer Portal. So both steps ask for the same Key ID + .p8
  // shape; the wizard hides the .p8 upload when the typed Key ID matches a
  // key that's already in the project's Apple Auth Key registry (the user
  // just enabled an additional capability on an existing key, no re-upload
  // needed). The backend reads/writes a unified registry under
  // <projectId>/apple/auth-keys; legacy single-purpose vault entries are
  // migrated on first read.
  {
    type: 'step',
    key: 'apple:generate-apns-key',
    label: 'Register APNs Capability on Apple Auth Key',
    description:
      "Adds (or confirms) APNs on the project's Apple Auth Key. Apple does not expose key creation or capability toggles via any public API \u2014 the .p8 download is one-time-only and capability checkboxes are toggled in Apple Developer \u2192 Keys. If you've already vaulted an Apple Auth Key in this project (e.g. via Sign In with Apple), reuse it from the picker and only the capability annotation is recorded. Otherwise, create a fresh key, check the APNs capability, and drop the AuthKey_<KEYID>.p8 here \u2014 Studio extracts the Key ID from the filename automatically.",
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'assisted',
    platforms: ['ios'],
    dependencies: [{ nodeKey: 'apple:register-app-id', required: true }],
    inputFields: [
      {
        key: 'apple_auth_key_p8',
        label: 'Apple Auth Key',
        description:
          'Drop the AuthKey_<KEYID>.p8 file Apple let you download once \u2014 Studio extracts the 10-character Key ID from the filename, validates the PEM in-browser, and stores it encrypted in the project vault. If the project already has a vaulted key, the picker above lets you add this capability without re-uploading.',
        type: 'p8',
        required: false,
      },
    ],
    produces: [
      {
        key: 'apple_auth_key_id_apns',
        label: 'Apple Auth Key (APNs capability)',
        description: 'Key ID of the Apple Auth Key bearing the APNs capability for this project.',
      },
      {
        key: 'apple_auth_key_p8_apns',
        label: 'APNs PEM',
        description:
          "Marker (vaulted) — the .p8 is stored in the project's unified Apple Auth Key registry, keyed by Key ID.",
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'apple:create-sign-in-key',
    label: 'Register Sign-In Capability on Apple Auth Key',
    description:
      "Configures Sign in with Apple in Apple Developer in this order: App ID Edit Configuration, Services ID, then Auth Key capability (or key reuse). Like the APNs step: if you already vaulted an Apple Auth Key in this project (e.g. for APNs), reuse it by typing the same Key ID and only the capability annotation is recorded — no second .p8 upload. Otherwise, create a fresh key with the Sign in with Apple capability and drop the .p8. Conditionally added when the project enables OAuth + Apple as a sign-in provider.",
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'assisted',
    platforms: ['ios'],
    dependencies: [{ nodeKey: 'apple:register-app-id', required: true }],
    inputFields: [
      {
        key: 'apple_sign_in_service_id',
        label: 'Apple Services ID',
        description:
          'Reverse-DNS Services ID used as the OAuth client identifier (e.g. {bundleId}.signin). Created under Apple Developer \u2192 Identifiers \u2192 Services IDs with Sign In with Apple enabled. The Return URL must point at your Firebase auth handler (https://<gcp-project>.firebaseapp.com/__/auth/handler). This is a separate Apple resource and does not replace enabling Sign In with Apple on the App ID configuration page.',
        type: 'text',
        placeholder: '{bundleId}.signin',
        defaultValue: '{bundleId}.signin',
        required: true,
      },
      {
        key: 'apple_auth_key_p8',
        label: 'Apple Auth Key',
        description:
          'Drop the AuthKey_<KEYID>.p8 file Apple let you download once \u2014 Studio extracts the 10-character Key ID from the filename, validates the PEM in-browser, and stores it encrypted in the project vault. The .p8 must come from a key that has the Sign in with Apple capability checked AND is bound to your App ID. If the project already has a vaulted key, the picker above lets you add this capability without re-uploading.',
        type: 'p8',
        required: false,
      },
    ],
    produces: [
      {
        key: 'apple_auth_key_id_sign_in_with_apple',
        label: 'Apple Auth Key (Sign In capability)',
        description: 'Key ID of the Apple Auth Key bearing the Sign In with Apple capability for this project.',
      },
      {
        key: 'apple_auth_key_p8_sign_in_with_apple',
        label: 'Sign In PEM',
        description:
          "Marker (vaulted) — the .p8 is stored in the project's unified Apple Auth Key registry, keyed by Key ID.",
      },
      {
        key: 'apple_sign_in_service_id',
        label: 'Apple Services ID',
        description: 'Service ID used as the OAuth client id when wiring SIWA into Firebase Auth.',
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
    // Manual: Firebase Console does not expose an API for uploading APNs auth
    // keys, so the user has to drop the .p8 in via the Cloud Messaging tab
    // (the step renders a deep link + checklist via MANUAL_INSTRUCTION_REGISTRY).
    automationLevel: 'manual',
    bridgeTarget: 'firebase',
    platforms: ['ios'],
    dependencies: [
      { nodeKey: 'apple:generate-apns-key', required: true },
      { nodeKey: 'firebase:enable-fcm', required: true, description: 'FCM must be enabled' },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'apple:create-app-store-listing',
    label: 'Create App Store Connect Listing',
    description:
      'Apple does not allow App Store Connect apps to be created via API — only GET / UPDATE. Create the listing once in App Store Connect (Apps → "+" → New App) using your registered bundle ID; Studio detects it via filter[bundleId] and stores asc_app_id. Optional project-vault override at <projectId>/asc_app_id is honored when set.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'assisted',
    platforms: ['ios'],
    dependencies: [{ nodeKey: 'apple:register-app-id', required: true }],
    inputFields: [
      {
        key: 'asc_app_name',
        label: 'App Store Connect listing name',
        description:
          'The exact name you used (or will use) when creating the listing in App Store Connect. Defaults to your project name. Update this if you had to use a different name (App Store names must be globally unique, so you may need a suffix like "Flow Mobile" if "Flow" was taken).',
        type: 'text',
        placeholder: 'Flow',
        defaultValue: '{name}',
        required: true,
      },
    ],
    produces: [
      {
        key: 'asc_app_id',
        label: 'ASC App ID',
        description: 'App Store Connect app identifier',
      },
      {
        key: 'asc_app_name',
        label: 'ASC App Name',
        description: 'App Store Connect listing name as shown to users (sourced from Apple).',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'apple:configure-testflight-group',
    label: 'Create TestFlight Beta Group',
    description:
      "Creates (or reuses) a TestFlight beta group on the App Store Connect listing and optionally seeds it with tester emails. Required so that EAS Submit / manual TestFlight builds have a default group to assign new builds to. Defaults to an INTERNAL group (skips Beta App Review, builds available immediately) — internal testers must be existing App Store Connect users; Studio verifies that and fails fast if any tester email isn't an ASC user. Switch to EXTERNAL if you want to invite arbitrary emails (Beta App Review required on first build of each version). Idempotent: re-running with the same group name reuses the existing group and only adds testers that aren't already members.",
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'full',
    platforms: ['ios'],
    dependencies: [
      { nodeKey: 'apple:create-app-store-listing', required: true },
    ],
    inputFields: [
      {
        key: 'testflight_group_name',
        label: 'TestFlight group name',
        description:
          "Display name for the beta group in App Store Connect → TestFlight → Groups. Defaults to your app name suffixed with 'Testers'. Must be unique within the app.",
        type: 'text',
        placeholder: '{name} Testers',
        defaultValue: '{name} Testers',
        required: true,
      },
      {
        key: 'testflight_group_type',
        label: 'Group type',
        description:
          "Internal groups skip Beta App Review and get builds immediately, but every tester must already exist as an App Store Connect user with the Developer/App Manager/Marketing/Customer Support role and the 'Access to TestFlight' checkbox enabled. External groups accept any email but the first build of each version requires Beta App Review (24–48h). Default is internal — the typical 'add my own email' workflow.",
        type: 'select',
        options: ['internal', 'external'],
        defaultValue: 'internal',
        required: true,
      },
      {
        key: 'testflight_tester_emails',
        label: 'Tester emails (optional)',
        description:
          "Comma- or newline-separated email addresses to add as testers in this group. For INTERNAL groups, each email must already be an App Store Connect user (Users and Access in ASC) — Studio looks them up and fails loudly if any aren't. For EXTERNAL groups, any email is accepted and gets a TestFlight invite once a build is assigned. Leave blank to create an empty group.",
        type: 'text',
        placeholder: 'qa@example.com, founder@example.com',
        required: false,
      },
    ],
    produces: [
      {
        key: 'testflight_group_id',
        label: 'TestFlight Group ID',
        description: 'App Store Connect betaGroups resource id (used by EAS Submit and manual build assignment).',
      },
      {
        key: 'testflight_group_name',
        label: 'TestFlight Group Name',
        description: 'Display name of the beta group as stored in App Store Connect.',
      },
    ],
    estimatedDurationMs: 8_000,
  },
  {
    type: 'step',
    key: 'apple:store-signing-in-eas',
    label: 'Configure EAS-Managed iOS Signing',
    description:
      'Mints an iOS Distribution certificate + App Store provisioning profile against Apple App Store Connect (using the org-level Team Key) and uploads them to EAS as the app\'s APP_STORE iosAppBuildCredentials. Subsequent `eas build --platform ios` runs reuse these credentials without prompting. Idempotent: skips minting if EAS already has both attached. Apple Developer dev/ad-hoc profiles are out of scope (require device UDIDs Studio does not collect).',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'eas',
    platforms: ['ios'],
    dependencies: [
      { nodeKey: 'apple:register-app-id', required: true },
      { nodeKey: 'apple:create-app-store-listing', required: true },
      { nodeKey: 'eas:create-project', required: true },
    ],
    produces: [
      {
        key: 'apple_distribution_cert_id',
        label: 'Apple Distribution Certificate (EAS)',
        description: 'Expo GraphQL id of the iOS distribution certificate.',
      },
      {
        key: 'apple_distribution_cert_serial',
        label: 'Distribution Certificate Serial',
        description: 'Apple-assigned serial number of the issued distribution certificate.',
      },
      {
        key: 'apple_app_store_profile_id',
        label: 'App Store Provisioning Profile (EAS)',
        description: 'Expo GraphQL id of the App Store provisioning profile.',
      },
      {
        key: 'eas_ios_build_credentials_id',
        label: 'EAS iOS Build Credentials',
        description: 'Expo GraphQL id of the APP_STORE iosAppBuildCredentials record.',
      },
    ],
    estimatedDurationMs: 30_000,
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
      {
        key: 'expo_account',
        label: 'Expo Account Slug',
        description: 'Expo organization / account slug owning the EAS project (when set).',
      },
      {
        key: 'eas_project_slug',
        label: 'EAS Project Slug',
        description: 'Project slug used in expo.dev URLs (matches manifest project_name).',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'eas:configure-build-profiles',
    label: 'Configure Build Profiles',
    description:
      'Registers each Studio environment on the Expo app as an EAS env-var slot (marker variable). You must still edit eas.json in your repository for real build profile names, settings, and credentials.',
    provider: 'eas',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'eas:create-project', required: true }],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'eas:store-token-in-github',
    label: 'Store Expo Token in GitHub',
    description:
      'Creates or updates the EXPO_TOKEN repository-level secret on the linked GitHub repo. Repository scope (not environment) so every workflow job — including jobs that don\'t declare `environment:` — can read it via ${{ secrets.EXPO_TOKEN }}. Same value applies to every env, so a single repo-level secret avoids per-env drift after token rotation.',
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
    key: 'eas:write-eas-json',
    label: 'Commit eas.json to Repo',
    description:
      'Commits a production-shaped `eas.json` (production profile holds the real iOS/Android settings; development/preview extend it) and wires `submit.production.ios` with the App Store Connect app id and Apple team id when those upstream resources exist. If `app.json` is present and there is no `app.config.ts/js` overriding it, also patches `expo.extra.eas.projectId`. Existing `eas.json` is left untouched so manual edits are preserved.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'github',
    dependencies: [
      { nodeKey: 'eas:create-project', required: true },
      { nodeKey: 'github:create-repository', required: true },
    ],
    produces: [
      {
        key: 'eas_json_path',
        label: 'eas.json path',
        description: 'Repo-relative path of the committed eas.json (always `eas.json`).',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'eas:configure-submit-apple',
    label: 'Configure EAS Submit (Apple)',
    description:
      'Uploads the App Store Connect API key to Expo and attaches it to this app for EAS Submit. Requires Issuer ID, Key ID, and .p8 in the vault; you still need eas.json submit config and valid iOS app identifiers in Expo.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'apple',
    platforms: ['ios'],
    dependencies: [
      { nodeKey: 'eas:create-project', required: true },
      {
        nodeKey: 'apple:create-app-store-listing',
        required: true,
        description: 'ASC listing must exist before EAS Submit can target it; ASC API credentials come from the org-level Apple integration.',
      },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'eas:configure-submit-android',
    label: 'Configure EAS Submit (Android)',
    description:
      'Uploads the Play Console service account JSON to Expo and wires it for EAS Submit. Store the JSON in the project vault; confirm eas.json submit and Play API access separately.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    bridgeTarget: 'google-play',
    platforms: ['android'],
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
    platforms: ['android'],
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
    platforms: ['android'],
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
    platforms: ['android'],
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
    platforms: ['android'],
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
    platforms: ['android'],
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
    platforms: ['android'],
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
      'Wires \"Sign In with Apple\" into Firebase Auth using the Service ID, Key ID, and .p8 already vaulted by apple:create-sign-in-key. Team ID is reused from the org-level Apple integration; the .p8 is forwarded so both the native iOS path AND the web/redirect path work.',
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
    teardownOf: 'firebase:enable-fcm',
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
    key: 'firebase:delete-firestore-db',
    label: 'Delete Firestore Database',
    description: 'Delete the Firestore database instance and all its data.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    direction: 'teardown',
    teardownOf: 'firebase:create-firestore-db',
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
      { nodeKey: 'firebase:delete-firestore-db', required: true },
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
    key: 'github:delete-repository',
    label: 'Delete GitHub Repository',
    description: 'Delete the GitHub repository for this project.',
    provider: 'github',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'github:create-repository',
    dependencies: [{ nodeKey: 'github:delete-workflows', required: true }],
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
    description:
      'Revoke EAS-managed certificates and provisioning profiles (via `eas credentials --platform ios`), plus any APNs/ASC keys. Complete in Apple Developer + App Store Connect for any assets EAS does not manage.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'apple:store-signing-in-eas',
    platforms: ['ios'],
    dependencies: [],
    produces: [],
  },
  {
    type: 'step',
    key: 'apple:remove-app-store-listing',
    label: 'Remove App Store Listing',
    description:
      'Archive/remove App Store Connect listing and Apple app registration where permitted. Some published records cannot be permanently deleted and require manual archival.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'manual',
    direction: 'teardown',
    teardownOf: 'apple:create-app-store-listing',
    platforms: ['ios'],
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
    platforms: ['android'],
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
    platforms: ['android'],
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

// ---------------------------------------------------------------------------
// Master catalog: all nodes by provider
// ---------------------------------------------------------------------------

/**
 * Static fallback — used before the plugin registry is populated.
 * After registerBuiltinPlugins() runs, use globalPluginRegistry.getStepsForProvider().
 */
const STATIC_STEPS_BY_PROVIDER: Record<string, ProvisioningStepNode[]> = {
  firebase: FIREBASE_STEPS,
  github: GITHUB_STEPS,
  eas: EAS_STEPS,
  apple: APPLE_STEPS,
  'google-play': GOOGLE_PLAY_STEPS,
  cloudflare: CLOUDFLARE_STEPS,
  oauth: OAUTH_STEPS,
};

/** @deprecated Use globalPluginRegistry.getStepsForProvider() after plugin bootstrap */
export function getStepsForProvider(provider: string): ProvisioningStepNode[] {
  if (globalPluginRegistry.hasPlugin('firebase-core')) {
    return globalPluginRegistry.getStepsForProvider(provider);
  }
  return STATIC_STEPS_BY_PROVIDER[provider] ?? [];
}

/** Flat catalog for enriching persisted plans with fields added after first save (e.g. `interactiveAction`). */
export const ALL_PROVISIONING_STEPS: ProvisioningStepNode[] = Object.values(
  STATIC_STEPS_BY_PROVIDER,
).flat();

/**
 * Dynamic version — returns all steps from registry when bootstrapped.
 * Falls back to static arrays when registry is empty.
 */
export function getAllProvisioningSteps(): ProvisioningStepNode[] {
  if (globalPluginRegistry.hasPlugin('firebase-core')) {
    return globalPluginRegistry.getAllSteps();
  }
  return ALL_PROVISIONING_STEPS;
}

const STATIC_TEARDOWN_STEPS_BY_PROVIDER: Record<string, ProvisioningStepNode[]> = {
  firebase: FIREBASE_TEARDOWN_STEPS,
  github: GITHUB_TEARDOWN_STEPS,
  eas: EAS_TEARDOWN_STEPS,
  apple: APPLE_TEARDOWN_STEPS,
  'google-play': GOOGLE_PLAY_TEARDOWN_STEPS,
  cloudflare: CLOUDFLARE_TEARDOWN_STEPS,
  oauth: OAUTH_TEARDOWN_STEPS,
};

/** @deprecated Use globalPluginRegistry.getTeardownStepsForProvider() after plugin bootstrap */
export function getTeardownStepsForProvider(provider: string): ProvisioningStepNode[] {
  if (globalPluginRegistry.hasPlugin('firebase-core')) {
    return globalPluginRegistry.getTeardownStepsForProvider(provider);
  }
  return STATIC_TEARDOWN_STEPS_BY_PROVIDER[provider] ?? [];
}

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
 * Drop nodes whose `platforms` mask doesn't intersect the project's platform
 * selection, then strip dependencies that point at filtered-out nodes from
 * the survivors.
 *
 * Untagged nodes (no `platforms`) and an empty `projectPlatforms` array
 * disable filtering entirely (treated as "all platforms").
 */
export function filterNodesByPlatforms(
  nodes: ProvisioningNode[],
  projectPlatforms: ReadonlyArray<MobilePlatform>,
): ProvisioningNode[] {
  if (!projectPlatforms || projectPlatforms.length === 0) return nodes;

  const removed = new Set<string>();
  const survivors: ProvisioningNode[] = [];
  for (const node of nodes) {
    if (platformMaskAllows(node.platforms, projectPlatforms)) {
      survivors.push(node);
    } else {
      removed.add(node.key);
    }
  }

  if (removed.size === 0) return survivors;

  return survivors.map((node) => {
    if (!node.dependencies?.length) return node;
    const trimmed = node.dependencies.filter((dep) => !removed.has(dep.nodeKey));
    if (trimmed.length === node.dependencies.length) return node;
    return { ...node, dependencies: trimmed };
  });
}

/**
 * Returns the subset of moduleIds whose own `platforms` mask intersects
 * the project's selection. Modules without a platform mask always pass.
 * Used in plan building to skip platform-irrelevant modules entirely
 * (their steps + user actions don't even need to be considered).
 */
export function filterModulesByPlatforms(
  moduleIds: ModuleId[],
  projectPlatforms: ReadonlyArray<MobilePlatform>,
): ModuleId[] {
  if (!projectPlatforms || projectPlatforms.length === 0) return moduleIds;
  const catalog = getEffectiveModuleCatalog();
  return moduleIds.filter((moduleId) => {
    const definition = catalog[moduleId];
    if (!definition) return true;
    return platformMaskAllows(definition.platforms, projectPlatforms);
  });
}

/**
 * Returns user action nodes relevant to the given set of providers.
 * A user action is included if at least one of its dependents' provider
 * is in the selected set, or if it has no dependents and its own provider
 * is in the set.
 */
function getRelevantUserActions(selectedProviders: string[]): UserActionNode[] {
  const allActions = globalPluginRegistry.hasPlugin('firebase-core')
    ? globalPluginRegistry.getAllUserActions()
    : USER_ACTIONS;

  const selectedSet = new Set<string>(selectedProviders);

  // Build a set of all step keys for the selected providers
  const selectedStepKeys = new Set<string>();
  for (const provider of selectedProviders) {
    for (const step of getStepsForProvider(provider)) {
      selectedStepKeys.add(step.key);
    }
  }

  // A user action is relevant if any selected step depends on it
  return allActions.filter((action) => {
    if (action.provider && selectedSet.has(action.provider)) return true;
    // Also include if any selected step directly depends on this action
    for (const provider of selectedProviders) {
      for (const step of getStepsForProvider(provider)) {
        if (step.dependencies.some((dep) => dep.nodeKey === action.key)) return true;
      }
    }
    // Include transitive: other user actions that depend on this one
    for (const otherAction of allActions) {
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
      steps.push(...getStepsForProvider(provider));
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
 *
 * @param platforms Mobile platforms the project targets. When provided and
 * non-empty, nodes whose `platforms` mask doesn't intersect are dropped and
 * surviving nodes have dependencies on the dropped peers stripped.
 */
export function buildProvisioningPlan(
  projectId: string,
  selectedProviders: ProviderType[],
  environments: string[],
  selectedModules?: ModuleId[],
  platforms: ReadonlyArray<MobilePlatform> = [],
): ProvisioningPlan {
  const merged = assembleMergedNodes(projectId, selectedProviders, environments, selectedModules);
  const nodes = pruneNodesWithUnresolvedDependencies(filterNodesByPlatforms(merged, platforms));

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
    platforms: [...platforms],
    nodes,
    nodeStates,
  };
}

export function buildTeardownPlan(
  projectId: string,
  selectedProviders: ProviderType[],
  environments: string[],
  selectedModules?: ModuleId[],
  platforms: ReadonlyArray<MobilePlatform> = [],
): ProvisioningPlan {
  const teardownSteps: ProvisioningStepNode[] = [];
  for (const provider of selectedProviders) {
    teardownSteps.push(...getTeardownStepsForProvider(provider));
  }
  const nodes = pruneNodesWithUnresolvedDependencies(
    filterNodesByPlatforms(teardownSteps as ProvisioningNode[], platforms),
  );

  const nodeStates = new Map<string, NodeState>();
  for (const node of nodes) {
    if (node.type !== 'step') continue;
    if (node.environmentScope === 'per-environment') {
      for (const env of environments) {
        const stateKey = `${node.key}@${env}`;
        nodeStates.set(stateKey, { nodeKey: node.key, status: 'not-started', environment: env });
      }
    } else {
      nodeStates.set(node.key, { nodeKey: node.key, status: 'not-started' });
    }
  }

  return {
    projectId,
    environments,
    selectedModules: selectedModules ? resolveModuleDependencies(selectedModules) : [],
    platforms: [...platforms],
    nodes,
    nodeStates,
  };
}

export function buildProvisioningPlanForModules(
  projectId: string,
  selectedModules: ModuleId[],
  environments: string[],
  platforms: ReadonlyArray<MobilePlatform> = [],
): ProvisioningPlan {
  // Drop platform-irrelevant modules entirely before resolving deps so that
  // e.g. an iOS-only project doesn't auto-pull `google-play-publishing` via
  // a transitive optional dependency.
  const platformFilteredModules = filterModulesByPlatforms(selectedModules, platforms);
  const resolvedModules = filterModulesByPlatforms(
    resolveModuleDependencies(platformFilteredModules),
    platforms,
  );
  const providerSet = new Set(getProvidersForModules(resolvedModules));
  const stepKeySet = new Set(getStepKeysForModules(resolvedModules));
  const selectedProviders = Array.from(providerSet);

  const fullPlan = buildProvisioningPlan(
    projectId,
    selectedProviders,
    environments,
    resolvedModules,
    platforms,
  );
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
    platforms: [...platforms],
    nodes: prunedNodes,
    nodeStates,
  };
}

export function recomputePlanForModules(
  previousPlan: ProvisioningPlan,
  selectedModules: ModuleId[],
  platforms?: ReadonlyArray<MobilePlatform>,
): ProvisioningPlan {
  const nextPlan = buildProvisioningPlanForModules(
    previousPlan.projectId,
    selectedModules,
    previousPlan.environments,
    platforms ?? previousPlan.platforms ?? [],
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
    steps.push(...getStepsForProvider(provider));
  }
  const userActions = getRelevantUserActions(providers);
  return [...userActions, ...steps];
}

export function getAllTeardownNodesForProviders(providers: ProviderType[]): ProvisioningStepNode[] {
  const steps: ProvisioningStepNode[] = [];
  for (const provider of providers) {
    steps.push(...getTeardownStepsForProvider(provider));
  }
  return steps;
}

export function getAllModuleDefinitions() {
  return MODULE_CATALOG;
}
