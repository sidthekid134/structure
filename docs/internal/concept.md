The Design: Step-Level Provisioning with User Actions and Environments
1. New Core Types
This is the new type system that replaces the flat PROVIDER_INTEGRATION_BLUEPRINTS and upgrades the orchestrator's unit of work from "provider" to "step." This would live in a new file like src/provisioning/graph.types.ts.

// ---------------------------------------------------------------------------
// Environment as a primary concept
// ---------------------------------------------------------------------------
type EnvironmentScope = 'global' | 'per-environment';
// ---------------------------------------------------------------------------
// Automation level — what the system can do vs what the user must do
// ---------------------------------------------------------------------------
type AutomationLevel =
  | 'full'       // system executes without user input
  | 'assisted'   // system initiates, user must complete a handoff (e.g., download a key)
  | 'manual';    // user does it entirely outside the platform
// ---------------------------------------------------------------------------
// User action categories
// ---------------------------------------------------------------------------
type UserActionCategory =
  | 'account-enrollment'       // sign up for Apple Dev, Google Play, etc.
  | 'credential-upload'        // upload a .p8 key, service account JSON, etc.
  | 'external-configuration'   // change DNS nameservers, configure something in a portal
  | 'approval';                // approve a TestFlight build, respond to review
// ---------------------------------------------------------------------------
// How the platform verifies a user action was completed
// ---------------------------------------------------------------------------
type VerificationMethod =
  | { type: 'api-check'; description: string }
  | { type: 'credential-upload'; secretKey: string }
  | { type: 'manual-confirm' };
// ---------------------------------------------------------------------------
// Dependency reference — points to any node in the graph
// ---------------------------------------------------------------------------
interface DependencyRef {
  nodeKey: string;         // e.g., 'firebase:create-gcp-project' or 'user:enroll-apple-developer'
  required: boolean;
  description?: string;    // why this dependency exists
}
// ---------------------------------------------------------------------------
// Resource — something a step produces that downstream steps can consume
// ---------------------------------------------------------------------------
interface ResourceOutput {
  key: string;             // e.g., 'gcp_project_id', 'clone_url'
  label: string;
  description: string;
}
// ---------------------------------------------------------------------------
// The two node types in the provisioning graph
// ---------------------------------------------------------------------------
interface UserActionNode {
  type: 'user-action';
  key: string;             // e.g., 'user:enroll-apple-developer'
  label: string;
  description: string;
  category: UserActionCategory;
  provider?: ProviderType;
  verification: VerificationMethod;
  helpUrl?: string;
  dependencies: DependencyRef[];
  produces: ResourceOutput[];
}
interface ProvisioningStepNode {
  type: 'step';
  key: string;             // e.g., 'firebase:create-gcp-project'
  label: string;
  description: string;
  provider: ProviderType;
  environmentScope: EnvironmentScope;
  automationLevel: AutomationLevel;
  dependencies: DependencyRef[];
  produces: ResourceOutput[];
  estimatedDurationMs?: number;
  bridgeTarget?: ProviderType;  // non-null = this step writes to another provider
}
type ProvisioningNode = UserActionNode | ProvisioningStepNode;
// ---------------------------------------------------------------------------
// Node execution state
// ---------------------------------------------------------------------------
type NodeStatus =
  | 'not-started'
  | 'blocked'            // dependencies not met
  | 'ready'              // all deps met, can execute
  | 'in-progress'
  | 'waiting-on-user'    // user action pending
  | 'completed'
  | 'failed'
  | 'skipped';
interface NodeState {
  nodeKey: string;
  status: NodeStatus;
  environment?: string;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  resourcesProduced?: Record<string, string>;
}
// ---------------------------------------------------------------------------
// Step execution context — what the adapter receives
// ---------------------------------------------------------------------------
interface StepContext {
  projectId: string;
  environment: string;
  upstreamResources: Record<string, string>;  // all resources produced by completed deps
  vaultRead: (key: string) => Promise<string | null>;
  vaultWrite: (key: string, value: string) => Promise<void>;
}
interface StepResult {
  status: 'completed' | 'failed' | 'waiting-on-user';
  resourcesProduced: Record<string, string>;
  error?: string;
  userPrompt?: string;  // what to show the user if waiting-on-user
}
// ---------------------------------------------------------------------------
// Provider blueprint — replaces IntegrationBlueprintDescriptor
// ---------------------------------------------------------------------------
interface ProviderBlueprint {
  provider: ProviderType;
  scope: IntegrationScope;
  steps: ProvisioningStepNode[];
  userActions: UserActionNode[];
}
// ---------------------------------------------------------------------------
// The full provisioning plan for a project
// ---------------------------------------------------------------------------
interface ProvisioningPlan {
  projectId: string;
  environments: string[];
  nodes: ProvisioningNode[];
  nodeStates: Map<string, NodeState>;  // keyed by nodeKey (or nodeKey:env for per-env)
}
2. The Adapter Interface Change
Your current ProviderAdapter has a single provision() method. With step-level control, the orchestrator needs to call individual steps:

interface ProviderAdapter<T extends ProviderConfig> {
  executeStep(stepKey: string, config: T, context: StepContext): Promise<StepResult>;
  validate(manifest: T, liveState: ProviderState | null): Promise<DriftReport>;
  reconcile(report: DriftReport, direction: ReconcileDirection): Promise<ProviderState>;
  extractCredentials(state: ProviderState): Promise<Record<string, string>>;
}
The existing FirebaseAdapter.provision() method currently does this internally:


firebase.ts
Lines 89-148
  async provision(config: FirebaseManifestConfig): Promise<ProviderState> {
    // ...
    try {
      // Step 1: Create or reuse Firebase project
      // ...
      // Step 2: Enable each service
      for (const service of config.services) {
        // ...
      }
    }
  }
That monolithic method would be refactored into an executeStep dispatch:

async executeStep(stepKey: string, config: FirebaseManifestConfig, context: StepContext): Promise<StepResult> {
  switch (stepKey) {
    case 'firebase:create-gcp-project':
      return this.createGcpProject(config, context);
    case 'firebase:enable-firebase':
      return this.enableFirebase(config, context);
    case 'firebase:create-provisioner-sa':
      return this.createProvisionerSa(config, context);
    case 'firebase:generate-sa-key':
      return this.generateSaKey(config, context);
    case 'firebase:enable-services':
      return this.enableServices(config, context);
    case 'firebase:register-ios-app':
      return this.registerIosApp(config, context);
    case 'firebase:register-android-app':
      return this.registerAndroidApp(config, context);
    case 'firebase:configure-firestore-rules':
      return this.configureFirestoreRules(config, context);
    case 'firebase:configure-storage-rules':
      return this.configureStorageRules(config, context);
    default:
      throw new AdapterError(`Unknown step: ${stepKey}`, 'firebase', 'executeStep');
  }
}
Each sub-method returns a StepResult with the resources it produced, which the orchestrator feeds into downstream steps via StepContext.upstreamResources.

3. The Complete Step + User Action Catalog
Here's every node in the graph for a mobile app. I'll use the naming convention provider:step-name for steps and user:action-name for user actions.

User Actions (Gates)
const USER_ACTIONS: UserActionNode[] = [
  // --- Account enrollment ---
  {
    type: 'user-action',
    key: 'user:enroll-apple-developer',
    label: 'Apple Developer Program',
    description: 'Enroll in the Apple Developer Program ($99/year). Required for App IDs, certificates, and App Store distribution.',
    category: 'account-enrollment',
    provider: 'apple',
    verification: { type: 'api-check', description: 'Verify team ID via App Store Connect API' },
    helpUrl: 'https://developer.apple.com/programs/enroll/',
    dependencies: [],
    produces: [{ key: 'apple_team_id', label: 'Apple Team ID', description: 'Team ID from Apple Developer account' }],
  },
  {
    type: 'user-action',
    key: 'user:enroll-google-play',
    label: 'Google Play Developer Account',
    description: 'Register a Google Play Developer account ($25 one-time). Required for Play Console app listings.',
    category: 'account-enrollment',
    provider: 'google-play',
    verification: { type: 'manual-confirm' },
    helpUrl: 'https://play.google.com/console/signup',
    dependencies: [],
    produces: [{ key: 'play_developer_id', label: 'Play Developer ID', description: 'Google Play developer account ID' }],
  },
  {
    type: 'user-action',
    key: 'user:setup-gcp-billing',
    label: 'GCP Billing Account',
    description: 'Create or link a Google Cloud billing account. Required for Firebase project creation with paid services.',
    category: 'account-enrollment',
    provider: 'firebase',
    verification: { type: 'api-check', description: 'Verify billing account via Cloud Billing API' },
    helpUrl: 'https://console.cloud.google.com/billing',
    dependencies: [],
    produces: [{ key: 'gcp_billing_account_id', label: 'Billing Account ID', description: 'GCP billing account identifier' }],
  },
  {
    type: 'user-action',
    key: 'user:acquire-domain',
    label: 'Domain Name',
    description: 'Purchase or verify ownership of a domain for deep links, universal links, and web presence.',
    category: 'external-configuration',
    provider: 'cloudflare',
    verification: { type: 'manual-confirm' },
    dependencies: [],
    produces: [{ key: 'domain_name', label: 'Domain', description: 'The registered domain name' }],
  },
  {
    type: 'user-action',
    key: 'user:confirm-dns-nameservers',
    label: 'Update DNS Nameservers',
    description: 'Point your domain\'s nameservers to Cloudflare at your registrar.',
    category: 'external-configuration',
    provider: 'cloudflare',
    verification: { type: 'api-check', description: 'Cloudflare zone activation check' },
    helpUrl: 'https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/',
    dependencies: [
      { nodeKey: 'cloudflare:add-domain-zone', required: true },
    ],
    produces: [],
  },
  // --- Credential uploads ---
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
    produces: [{ key: 'github_token', label: 'GitHub Token', description: 'PAT for GitHub API access' }],
  },
  {
    type: 'user-action',
    key: 'user:provide-gcp-auth',
    label: 'GCP Authentication',
    description: 'Authenticate via Google OAuth or upload a service account JSON key.',
    category: 'credential-upload',
    provider: 'firebase',
    verification: { type: 'credential-upload', secretKey: 'gcp_credentials' },
    dependencies: [
      { nodeKey: 'user:setup-gcp-billing', required: true },
    ],
    produces: [{ key: 'gcp_credentials', label: 'GCP Credentials', description: 'OAuth token or service account JSON' }],
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
    produces: [{ key: 'expo_token', label: 'Expo Token', description: 'Robot token for EAS API' }],
  },
  {
    type: 'user-action',
    key: 'user:upload-initial-aab',
    label: 'Upload Initial App Bundle',
    description: 'Google Play requires an initial AAB upload before API access works. Build and upload manually or via EAS.',
    category: 'external-configuration',
    provider: 'google-play',
    verification: { type: 'api-check', description: 'Check Play Console for existing release via API' },
    dependencies: [
      { nodeKey: 'google-play:create-app-listing', required: true },
    ],
    produces: [],
  },
];
Firebase Steps
const FIREBASE_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'firebase:create-gcp-project',
    label: 'Create GCP Project',
    description: 'Create or link GCP project as the backing infrastructure container.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'user:provide-gcp-auth', required: true },
    ],
    produces: [
      { key: 'gcp_project_id', label: 'GCP Project ID', description: 'st-<slug>-<hash6>' },
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
    dependencies: [
      { nodeKey: 'firebase:create-gcp-project', required: true },
    ],
    produces: [
      { key: 'firebase_project_id', label: 'Firebase Project ID', description: 'Firebase project identifier' },
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
    dependencies: [
      { nodeKey: 'firebase:enable-firebase', required: true },
    ],
    produces: [
      { key: 'provisioner_sa_email', label: 'Provisioner SA', description: 'platform-provisioner@<project>.iam.gserviceaccount.com' },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'firebase:generate-sa-key',
    label: 'Generate Service Account Key',
    description: 'JSON key generated and stored in the encrypted local vault.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'firebase:create-provisioner-sa', required: true },
    ],
    produces: [
      { key: 'service_account_json', label: 'SA Key', description: 'Vaulted service account JSON' },
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
    dependencies: [
      { nodeKey: 'firebase:enable-firebase', required: true },
    ],
    produces: [
      { key: 'enabled_services', label: 'Enabled Services', description: 'Comma-separated list of enabled Firebase services' },
    ],
    estimatedDurationMs: 20000,
  },
  {
    type: 'step',
    key: 'firebase:register-ios-app',
    label: 'Register iOS App',
    description: 'Register the iOS bundle ID with Firebase to generate GoogleService-Info.plist values.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'firebase:enable-firebase', required: true },
    ],
    produces: [
      { key: 'firebase_ios_app_id', label: 'Firebase iOS App', description: 'Firebase app ID for iOS' },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'firebase:register-android-app',
    label: 'Register Android App',
    description: 'Register the Android package name with Firebase to generate google-services.json values.',
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'firebase:enable-firebase', required: true },
    ],
    produces: [
      { key: 'firebase_android_app_id', label: 'Firebase Android App', description: 'Firebase app ID for Android' },
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
    dependencies: [
      { nodeKey: 'firebase:enable-services', required: true },
    ],
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
    dependencies: [
      { nodeKey: 'firebase:enable-services', required: true },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
];
Cloudflare Steps
const CLOUDFLARE_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'cloudflare:add-domain-zone',
    label: 'Add Domain to Cloudflare',
    description: 'Create a Cloudflare zone for the project domain.',
    provider: 'cloudflare',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'user:acquire-domain', required: true },
    ],
    produces: [
      { key: 'cloudflare_zone_id', label: 'Zone ID', description: 'Cloudflare zone identifier' },
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
    dependencies: [
      { nodeKey: 'cloudflare:configure-dns', required: true },
    ],
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
      { nodeKey: 'apple:register-app-id', required: true, description: 'Needs bundle ID and team ID for AASA content' },
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
      { nodeKey: 'google-play:extract-fingerprints', required: true, description: 'Needs SHA-256 fingerprint for asset links' },
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
    dependencies: [
      { nodeKey: 'cloudflare:configure-ssl', required: true },
    ],
    produces: [
      { key: 'deep_link_base_url', label: 'Deep Link URL', description: 'Base URL for deep link routing' },
    ],
    estimatedDurationMs: 5000,
  },
];
GitHub Steps
const GITHUB_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'github:create-repository',
    label: 'Create Repository',
    description: 'Create or link the GitHub repository for the project.',
    provider: 'github',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'user:provide-github-pat', required: true },
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
    key: 'github:configure-branch-protection',
    label: 'Configure Branch Protection',
    description: 'Set up branch protection rules for main and develop branches.',
    provider: 'github',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'github:create-repository', required: true },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'github:create-environments',
    label: 'Create GitHub Environments',
    description: 'Create deployment environments with protection rules.',
    provider: 'github',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'github:create-repository', required: true },
    ],
    produces: [
      { key: 'github_environment_id', label: 'Environment ID', description: 'GitHub environment identifier' },
    ],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'github:inject-secrets',
    label: 'Inject Environment Secrets',
    description: 'Store Firebase SA key, API keys, and provider tokens as GitHub environment secrets.',
    provider: 'github',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    bridgeTarget: 'firebase',
    dependencies: [
      { nodeKey: 'github:create-environments', required: true },
      { nodeKey: 'firebase:generate-sa-key', required: true, description: 'Firebase service account key to inject' },
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
    dependencies: [
      { nodeKey: 'github:create-repository', required: true },
    ],
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
    dependencies: [
      { nodeKey: 'github:create-repository', required: true },
    ],
    produces: [
      { key: 'github_webhook_id', label: 'Webhook ID', description: 'GitHub webhook identifier' },
    ],
    estimatedDurationMs: 3000,
  },
];
Apple Steps
const APPLE_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'apple:register-app-id',
    label: 'Register App ID',
    description: 'Register the bundle ID as an App ID in Apple Developer Portal.',
    provider: 'apple',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'user:enroll-apple-developer', required: true },
    ],
    produces: [
      { key: 'apple_app_id', label: 'App ID', description: 'Apple Developer Portal App ID' },
      { key: 'apple_bundle_id', label: 'Bundle ID', description: 'Registered bundle identifier' },
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
    dependencies: [
      { nodeKey: 'apple:register-app-id', required: true },
    ],
    produces: [
      { key: 'apple_dev_profile_id', label: 'Dev Profile', description: 'Development provisioning profile UUID' },
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
    dependencies: [
      { nodeKey: 'apple:register-app-id', required: true },
    ],
    produces: [
      { key: 'apple_dist_profile_id', label: 'Dist Profile', description: 'Distribution provisioning profile UUID' },
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
    dependencies: [
      { nodeKey: 'apple:register-app-id', required: true },
    ],
    produces: [
      { key: 'apns_key_id', label: 'APNs Key ID', description: 'Key ID for push notifications' },
      { key: 'apns_key_p8', label: 'APNs Key', description: '.p8 private key (one-time download)' },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'apple:upload-apns-to-firebase',
    label: 'Upload APNs Key to Firebase',
    description: 'Register the APNs key with Firebase Cloud Messaging for push notification delivery.',
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
    dependencies: [
      { nodeKey: 'apple:register-app-id', required: true },
    ],
    produces: [
      { key: 'asc_app_id', label: 'ASC App ID', description: 'App Store Connect app identifier' },
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
    dependencies: [
      { nodeKey: 'apple:create-app-store-listing', required: true },
    ],
    produces: [
      { key: 'asc_api_key_id', label: 'ASC Key ID', description: 'App Store Connect API key ID' },
      { key: 'asc_api_key_p8', label: 'ASC Key', description: 'API key for EAS Submit' },
    ],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'apple:store-signing-in-eas',
    label: 'Store Signing Credentials in EAS',
    description: 'Upload Apple code signing certificates and profiles to EAS for managed signing.',
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
EAS Steps
const EAS_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'eas:create-project',
    label: 'Create EAS Project',
    description: 'Create or link the Expo Application Services project.',
    provider: 'eas',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'user:provide-expo-token', required: true },
    ],
    produces: [
      { key: 'eas_project_id', label: 'EAS Project ID', description: 'Expo project identifier' },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'eas:configure-build-profiles',
    label: 'Configure Build Profiles',
    description: 'Set up EAS build profiles for each environment (development, preview, production).',
    provider: 'eas',
    environmentScope: 'per-environment',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'eas:create-project', required: true },
    ],
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
Google Play Steps
const GOOGLE_PLAY_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'google-play:create-app-listing',
    label: 'Create Play Console Listing',
    description: 'Create the app in Google Play Console.',
    provider: 'google-play',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'user:enroll-google-play', required: true },
    ],
    produces: [
      { key: 'play_app_id', label: 'Play App ID', description: 'Google Play application ID' },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'google-play:create-service-account',
    label: 'Create Play Service Account',
    description: 'Create a GCP service account with Play Console API access for automated uploads.',
    provider: 'google-play',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'google-play:create-app-listing', required: true },
      { nodeKey: 'firebase:create-gcp-project', required: true, description: 'SA created in the same GCP project' },
    ],
    produces: [
      { key: 'play_service_account_email', label: 'Play SA', description: 'Service account for Play Console API' },
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
    dependencies: [
      { nodeKey: 'google-play:configure-app-signing', required: true },
    ],
    produces: [
      { key: 'signing_sha1', label: 'SHA-1', description: 'Signing certificate SHA-1 fingerprint' },
      { key: 'signing_sha256', label: 'SHA-256', description: 'Signing certificate SHA-256 fingerprint' },
    ],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'google-play:add-fingerprints-to-firebase',
    label: 'Add Fingerprints to Firebase',
    description: 'Register signing fingerprints with the Firebase Android app for OAuth and deep links.',
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
OAuth Steps
const OAUTH_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'oauth:enable-auth-providers',
    label: 'Enable Firebase Auth Providers',
    description: 'Enable Google, Apple, and/or GitHub sign-in in Firebase Authentication.',
    provider: 'oauth',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [
      { nodeKey: 'firebase:enable-services', required: true, description: 'Firebase Auth must be enabled' },
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
      { key: 'oauth_client_id_ios', label: 'iOS Client ID', description: 'Google OAuth client for iOS' },
      { key: 'oauth_client_id_android', label: 'Android Client ID', description: 'Google OAuth client for Android' },
      { key: 'oauth_client_id_web', label: 'Web Client ID', description: 'Google OAuth client for Web' },
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
      { key: 'apple_sign_in_service_id', label: 'Apple Sign-In Service ID', description: 'Service ID for Apple OAuth' },
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
    dependencies: [
      { nodeKey: 'oauth:register-oauth-clients', required: true },
    ],
    produces: [],
    estimatedDurationMs: 3000,
  },
  {
    type: 'step',
    key: 'oauth:link-deep-link-domain',
    label: 'Link Auth Deep Link Domain',
    description: 'Configure Firebase Auth to use the Cloudflare domain for auth redirects.',
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
4. The Dependency Resolver Upgrade
Your current DependencyResolver operates at the provider level. It needs a second layer for step-level resolution. The key change in src/drift/resolver.ts:

export class StepResolver {
  static resolveExecutionPlan(
    nodes: ProvisioningNode[],
    environments: string[],
  ): ExecutionGroup[] {
    // 1. Fan out per-environment steps: firebase:enable-services becomes
    //    firebase:enable-services@dev, firebase:enable-services@preview, etc.
    // 2. Build adjacency list from all DependencyRef edges
    // 3. Topological sort with grouping: nodes at the same depth can run in parallel
    // 4. Return ExecutionGroup[] where each group is a parallelizable batch
  }
  static getReadyNodes(
    nodes: ProvisioningNode[],
    nodeStates: Map<string, NodeState>,
  ): ProvisioningNode[] {
    // Return all nodes whose dependencies are all 'completed'
    // and whose own status is 'not-started' or 'blocked'
  }
  static computeNodeStatus(
    node: ProvisioningNode,
    nodeStates: Map<string, NodeState>,
  ): NodeStatus {
    // If all deps completed → 'ready'
    // If any dep failed → 'blocked'
    // If any dep is user-action and not completed → 'blocked'
  }
}
The existing DependencyResolver can remain for backward compat and as a "quick check" for provider-level ordering. StepResolver is the new primary resolver.

5. The Orchestrator Upgrade
The main change to src/orchestration/orchestrator.ts — instead of iterating providers, it iterates steps:

async *provision(
  manifest: ProviderManifest,
  plan: ProvisioningPlan,
  options: OrchestrationOptions = {},
): AsyncGenerator<StepProgressEvent, StepResult[], void> {
  
  const executionGroups = StepResolver.resolveExecutionPlan(plan.nodes, plan.environments);
  
  for (const group of executionGroups) {
    // Execute all nodes in this group in parallel
    const promises = group.nodes.map(async ({ nodeKey, environment }) => {
      const node = plan.nodes.find(n => n.key === nodeKey)!;
      
      if (node.type === 'user-action') {
        yield { nodeKey, status: 'waiting-on-user', environment };
        // Pause — orchestrator cannot proceed past this until user completes
        return;
      }
      
      // Build StepContext from all upstream resources
      const context = this.buildStepContext(plan, nodeKey, environment);
      const adapter = this.registry.getAdapter(node.provider);
      const result = await adapter.executeStep(nodeKey, config, context);
      
      // Record result
      plan.nodeStates.set(
        environment ? `${nodeKey}@${environment}` : nodeKey,
        { nodeKey, status: result.status, environment, resourcesProduced: result.resourcesProduced },
      );
      
      yield { nodeKey, status: result.status, environment, result };
    });
  }
}
6. The Updated ProgressEvent
The ProgressEvent in src/orchestration/types.ts needs to carry step-level info:

interface StepProgressEvent {
  nodeKey: string;                    // 'firebase:create-gcp-project'
  nodeType: 'step' | 'user-action';
  provider?: ProviderType;
  environment?: string;               // null for global steps, 'dev'/'prod' for per-env
  status: StepProgressStatus;
  result?: StepResult;
  userPrompt?: string;                // for waiting-on-user status
  timestamp: Date;
  correlation_id: string;
}
type StepProgressStatus =
  | 'ready'
  | 'running'
  | 'success'
  | 'failure'
  | 'waiting-on-user'
  | 'skipped'
  | 'blocked';
7. On Deployment — My Judgment
Don't make deployment a ProviderType. Here's why:

Providers are infrastructure — they're provisioned once (or occasionally reconciled). Deployment is a recurring action on top of that infrastructure.
The setup-for-deployment (ASC API key, EAS Submit config, Play Console SA) is already covered by the Apple, EAS, and Google Play steps above.
Making deployment a provider would conflate "is my infrastructure ready?" with "has my app been shipped?" — two different questions with different lifecycles.
Instead, the infrastructure view should show a readiness indicator at the bottom: "All infrastructure provisioned. Ready for first deployment." This is a computed state — when all nodes are completed, the project is deployment-ready. The actual deployment (EAS Build → Submit → Review) belongs in a separate Releases view, which is an operational concern, not an infrastructure concern.

Summary of File Changes
File	Change
New: src/provisioning/graph.types.ts	All new types: ProvisioningNode, UserActionNode, ProvisioningStepNode, StepContext, StepResult, NodeState, ProvisioningPlan
New: src/provisioning/step-registry.ts	The complete step + user action catalog (all the constants above), plus a buildProvisioningPlan(project, selectedProviders, environments) function
New: src/provisioning/step-resolver.ts	StepResolver class — topological sort at the step level, resolveExecutionPlan(), getReadyNodes(), computeNodeStatus()
Modify: src/providers/types.ts	Add executeStep() to ProviderAdapter<T> interface
Modify: src/orchestration/types.ts	Add StepProgressEvent, StepProgressStatus alongside existing types
Modify: src/orchestration/orchestrator.ts	Add step-level provision() overload that uses StepResolver and calls adapter.executeStep()
Modify: src/providers/firebase.ts etc.	Refactor provision() into executeStep() dispatch with per-step methods
Modify: src/core/provider-schemas.ts	Replace PROVIDER_INTEGRATION_BLUEPRINTS with the new ProviderBlueprint format using the step catalog
Keep: src/drift/resolver.ts	Existing DependencyResolver stays for backward compat; StepResolver is the new primary
