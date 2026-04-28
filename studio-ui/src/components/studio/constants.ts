import {
  Activity,
  Cloud,
  Globe,
  Github,
  HardDrive,
  KeyRound,
  Package,
  ShieldCheck,
  Smartphone,
  TrendingUp,
  Wrench,
  Zap,
} from 'lucide-react';
import type {
  InfraPluginCategory,
  IntegrationConfig,
  LogEntry,
  ProjectSetupConfig,
  ProviderId,
  ServiceHealth,
} from './types';

/** @deprecated Import DEFAULT_ENVIRONMENTS from CreateProjectModal instead */
export const DEFAULT_ENVIRONMENTS = ['preview', 'production'];
export const SLUG_MAX = 25;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || response.statusText);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const body = await response.text();
  if (!body) {
    return undefined as T;
  }
  return JSON.parse(body) as T;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX);
}

function bundleFromSlug(slug: string): string {
  return slug ? `com.example.${slug}` : 'com.example';
}

function providerToBackendKey(providerId: ProviderId): string {
  if (providerId === 'expo') return 'eas';
  return providerId;
}

// --- Plugin Registry Static Data ---

export const INTEGRATION_CONFIGS: IntegrationConfig[] = [
  {
    id: 'firebase',
    scope: 'project',
    orgAvailability: 'automatic',
    name: 'Google Cloud Platform',
    logo: Cloud,
    logoColor: 'text-blue-500',
    description:
      'A dedicated service account is created per project to provision Firebase Auth, Firestore, FCM, Vertex AI, and App Check. GCP is available to all projects by default — configure each project to unlock its modules.',
    docsUrl: 'https://firebase.google.com/docs/projects/api/workflow_set-up-and-manage-project',
    supportsOAuth: true,
    fields: [
      {
        key: 'gcpServiceAccount',
        label: 'GCP Service Account JSON',
        placeholder: '{\n  "type": "service_account",\n  "project_id": "my-project",\n  ...\n}',
        hint: 'Paste the full JSON key file for a service account with Editor or Owner role.',
        type: 'textarea',
      },
    ],
  },
  {
    id: 'expo',
    scope: 'organization',
    name: 'Expo / EAS',
    logo: Zap,
    logoColor: 'text-indigo-500',
    description:
      'Connect your Expo Robot token to enable EAS Build and EAS Submit for automated iOS and Android binary delivery.',
    docsUrl: 'https://docs.expo.dev/accounts/programmatic-access/',
    fields: [
      {
        key: 'expoRobotToken',
        label: 'Expo Robot Token',
        placeholder: 'expo_robot_XXXXXXXXXXXXXXXXXXXXXXXX',
        hint: 'Generate a Robot token in Expo.dev → Account → Access Tokens.',
        type: 'password',
      },
      {
        key: 'expoAccountSlug',
        label: 'Expo Account / Org Slug',
        placeholder: 'my-org',
        hint: 'Your Expo username or organization slug as shown in expo.dev URLs.',
        type: 'text',
      },
    ],
  },
  {
    id: 'github',
    scope: 'organization',
    name: 'GitHub',
    logo: Github,
    logoColor: 'text-slate-800',
    description:
      'Connect a GitHub Personal Access Token to create repositories, configure branch protection, and trigger GitHub Actions workflows.',
    docsUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
    fields: [
      {
        key: 'githubPat',
        label: 'Personal Access Token (classic)',
        placeholder: 'ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        hint: 'Create a token at GitHub → Settings → Developer Settings → PATs. Required scopes: repo, workflow.',
        type: 'password',
      },
    ],
  },
  {
    id: 'apple',
    scope: 'organization',
    name: 'Apple Developer',
    logo: ShieldCheck,
    logoColor: 'text-zinc-700 dark:text-zinc-300',
    description:
      'Connect Apple Developer at the organization level. Studio walks you through capturing the Team ID and creating an App Store Connect Team API key (Issuer ID, Key ID, and .p8) so every project can run automated signing, provisioning, APNs, and TestFlight workflows.',
    docsUrl: 'https://developer.apple.com/account',
    customFlow: 'apple',
    fields: [],
  },
  {
    id: 'cloudflare',
    scope: 'organization',
    name: 'Cloudflare',
    logo: Globe,
    logoColor: 'text-orange-500',
    description:
      'Connect a Cloudflare API token at organization scope as the default. Projects can optionally provide their own stricter zone-scoped token overrides during setup.',
    docsUrl: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
    fields: [
      {
        key: 'cloudflareApiToken',
        label: 'Cloudflare API Token',
        placeholder: 'cf_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        hint:
          'Grant Zone:Read, Zone:Edit, and DNS:Edit for required apex zones. Project-level override tokens can be added later for tighter scope.',
        type: 'password',
      },
    ],
    customFlow: 'cloudflare',
  },
];

// NOTE: ALL_REGISTRY_PLUGINS / PROVIDER_PLUGIN_MAP / REGISTRY_CATEGORIES used to
// live here as a static design fixture. They have been removed in favor of
// usePluginCatalog(), which fetches the live `/api/plugin-catalog` so the UI
// always reflects the actual backend plugin registry (firebase, github, eas,
// apple, cloudflare, oauth, llm, …).

/**
 * Pill labels used by RegistryView when rendering the "Also: X" cross-category
 * tags. Backend function-group ids are mapped to short display labels.
 */
export const CATEGORY_LABEL_MAP: Record<string, string> = {
  firebase: 'Firebase',
  github: 'GitHub',
  mobile: 'Mobile',
  infrastructure: 'Infra',
  auth: 'Auth',
  ai: 'AI',
};

/**
 * Pill styling per backend function-group id. Groups not listed here fall
 * back to the neutral muted style at the call site.
 */
export const CATEGORY_PILL_STYLE: Record<string, string> = {
  firebase: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30',
  github: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/30',
  mobile: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/30',
  infrastructure: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  auth: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30',
  ai: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
};

export const INFRA_CATEGORIES: InfraPluginCategory[] = [
  {
    id: 'auth',
    label: 'Authentication',
    icon: KeyRound,
    color: 'text-violet-500',
    description: 'User identity and session management',
    plugins: [
      {
        id: 'firebase-auth',
        name: 'Firebase Auth',
        provider: 'Google Firebase',
        description: 'Apple, Google, and Email/Password auth with built-in session management and JWT tokens.',
        configFields: [
          { key: 'authProviders', label: 'Enabled Providers', placeholder: 'apple,google,email', type: 'text' },
          { key: 'sessionExpiry', label: 'Session Expiry', placeholder: '7d', type: 'select', options: ['1d', '7d', '30d', '90d'] },
        ],
        setupTasks: [
          { id: 'firebase-auth-1', title: 'Authenticate with GCP', description: 'Validate service account credentials and resolve project ID', duration: 1200 },
          { id: 'firebase-auth-2', title: 'Enable Firebase Auth API', description: 'Enable the Identity Toolkit API in the GCP project', duration: 1800 },
          { id: 'firebase-auth-3', title: 'Configure auth providers', description: 'Register Apple, Google, and Email sign-in methods', duration: 1400 },
          { id: 'firebase-auth-4', title: 'Deploy security rules', description: 'Write and publish Firebase Auth security policy', duration: 900 },
        ],
      },
      {
        id: 'mock-auth',
        name: 'Mock Auth',
        provider: 'Studio Core',
        description: 'Local development authentication mock with configurable user fixtures for offline-first development.',
        configFields: [{ key: 'mockUsers', label: 'Mock User Count', placeholder: '3', type: 'select', options: ['1', '3', '5', '10'] }],
        setupTasks: [
          { id: 'mock-auth-1', title: 'Generate user fixtures', description: 'Create mock user profiles with configurable roles', duration: 600 },
          { id: 'mock-auth-2', title: 'Initialize token service', description: 'Set up local JWT signing for development tokens', duration: 400 },
        ],
      },
    ],
  },
  {
    id: 'persistence',
    label: 'Persistence Store',
    icon: HardDrive,
    color: 'text-blue-500',
    description: 'Database and data storage layer',
    plugins: [
      {
        id: 'firestore',
        name: 'Cloud Firestore',
        provider: 'Google Firebase',
        description: 'Real-time NoSQL document database with offline sync, security rules, and automatic scaling.',
        configFields: [
          { key: 'region', label: 'Database Region', placeholder: 'us-central1', type: 'select', options: ['us-central1', 'us-east1', 'europe-west1', 'asia-east1'] },
          { key: 'mode', label: 'Database Mode', placeholder: 'native', type: 'select', options: ['native', 'datastore'] },
        ],
        setupTasks: [
          { id: 'firestore-1', title: 'Enable Firestore API', description: 'Activate Cloud Firestore in the GCP project', duration: 1600 },
          { id: 'firestore-2', title: 'Provision database instance', description: 'Create Firestore in native mode at selected region', duration: 3200 },
          { id: 'firestore-3', title: 'Deploy security rules', description: 'Publish default deny-all rules with auth-gated read/write', duration: 800 },
          { id: 'firestore-4', title: 'Create composite indexes', description: 'Set up required indexes for common query patterns', duration: 1100 },
        ],
      },
      {
        id: 'mock-db',
        name: 'Mock DB',
        provider: 'Studio Core',
        description: 'Local in-memory store for offline-first development and unit testing with seed data.',
        configFields: [{ key: 'seedData', label: 'Seed Data Preset', placeholder: 'minimal', type: 'select', options: ['minimal', 'standard', 'rich'] }],
        setupTasks: [
          { id: 'mock-db-1', title: 'Initialize in-memory store', description: 'Bootstrap SQLite-backed local store', duration: 500 },
          { id: 'mock-db-2', title: 'Load seed data', description: 'Populate with preset fixture data', duration: 700 },
        ],
      },
    ],
  },
  {
    id: 'build',
    label: 'Build Pipeline',
    icon: Wrench,
    color: 'text-orange-500',
    description: 'CI/CD and binary delivery',
    plugins: [
      {
        id: 'eas-build',
        name: 'EAS Build',
        provider: 'Expo',
        description: 'Managed cloud builds for iOS and Android with environment profiles and build caching.',
        configFields: [
          { key: 'defaultProfile', label: 'Default Build Profile', placeholder: 'development', type: 'select', options: ['development', 'preview', 'production'] },
          { key: 'node', label: 'Node Version', placeholder: '20', type: 'select', options: ['18', '20', '22'] },
        ],
        setupTasks: [
          { id: 'eas-1', title: 'Authenticate with Expo', description: 'Validate robot token and resolve account slug', duration: 1000 },
          { id: 'eas-2', title: 'Create EAS project', description: 'Initialize EAS project linked to bundle ID', duration: 1500 },
          { id: 'eas-3', title: 'Generate eas.json', description: 'Create build profiles: development, preview, production', duration: 700 },
          { id: 'eas-4', title: 'Configure environment secrets', description: 'Upload API keys and secrets to EAS secret store', duration: 900 },
        ],
      },
      {
        id: 'github-actions',
        name: 'GitHub Actions',
        provider: 'GitHub',
        description: 'CI/CD workflow automation with automated test runs, build triggers, and deployment gates.',
        configFields: [
          { key: 'defaultBranch', label: 'Default Branch', placeholder: 'main', type: 'text' },
          { key: 'triggerOn', label: 'Trigger On', placeholder: 'push', type: 'select', options: ['push', 'pull_request', 'both'] },
        ],
        setupTasks: [
          { id: 'gh-1', title: 'Validate GitHub token', description: 'Authenticate and verify required repo/workflow scopes', duration: 800 },
          { id: 'gh-2', title: 'Create repository', description: 'Initialize repo with README and .gitignore', duration: 1200 },
          { id: 'gh-3', title: 'Set branch protection', description: 'Enable required status checks on default branch', duration: 600 },
          { id: 'gh-4', title: 'Deploy workflow files', description: 'Commit CI/CD YAML workflows to .github/workflows/', duration: 1000 },
        ],
      },
    ],
  },
];

// --- Project Overview Mock Data ---


export const SERVICE_HEALTH_DATA: ServiceHealth[] = [
  { id: 'sh1', name: 'Firebase Auth', provider: 'Firebase', uptime: 99.97, latency: 42, status: 'operational', lastCheck: '12s ago' },
  { id: 'sh2', name: 'Cloud Firestore', provider: 'Firebase', uptime: 99.94, latency: 68, status: 'operational', lastCheck: '12s ago' },
  { id: 'sh3', name: 'GitHub Repository', provider: 'GitHub', uptime: 100, latency: 24, status: 'operational', lastCheck: '5s ago' },
  { id: 'sh4', name: 'EAS Build', provider: 'Expo', uptime: 98.2, latency: 310, status: 'degraded', lastCheck: '30s ago' },
  { id: 'sh5', name: 'Apple APNs', provider: 'Apple', uptime: 99.99, latency: 91, status: 'operational', lastCheck: '18s ago' },
  { id: 'sh6', name: 'Vertex AI', provider: 'GCP', uptime: 99.5, latency: 182, status: 'operational', lastCheck: '22s ago' },
];

export const MOCK_LOGS: LogEntry[] = [
  { id: 'l1', timestamp: '14:02:01', level: 'info', message: 'Initializing provisioning pipeline' },
  { id: 'l2', timestamp: '14:02:03', level: 'info', message: 'Authenticating with GCP service account...' },
  { id: 'l3', timestamp: '14:02:05', level: 'success', message: '✓ GCP authentication successful' },
  { id: 'l4', timestamp: '14:02:07', level: 'info', message: 'Creating Firebase project...' },
  { id: 'l5', timestamp: '14:02:12', level: 'success', message: '✓ Firebase project created. Region: us-central1' },
  { id: 'l6', timestamp: '14:02:13', level: 'info', message: 'Enabling Auth providers: apple, google, email' },
  { id: 'l7', timestamp: '14:02:15', level: 'success', message: '✓ Auth providers configured' },
  { id: 'l8', timestamp: '14:02:16', level: 'info', message: 'Provisioning Cloud Firestore in native mode...' },
  { id: 'l9', timestamp: '14:02:22', level: 'success', message: '✓ Firestore provisioned. Security rules deployed.' },
  { id: 'l10', timestamp: '14:02:23', level: 'info', message: 'Creating GitHub repository...' },
  { id: 'l11', timestamp: '14:02:27', level: 'success', message: '✓ Repository created. Branch protection enabled.' },
  { id: 'l12', timestamp: '14:02:28', level: 'info', message: 'Generating EAS project configuration...' },
  { id: 'l13', timestamp: '14:02:31', level: 'warn', message: '⚠ EAS build queue latency detected. Proceeding.' },
  { id: 'l14', timestamp: '14:02:35', level: 'success', message: '✓ EAS project linked. Build profiles configured' },
  { id: 'l15', timestamp: '14:02:36', level: 'info', message: 'Syncing Apple Developer Portal...' },
  { id: 'l16', timestamp: '14:02:40', level: 'warn', message: '⚠ Awaiting manual APNs key upload. Pausing Apple sync.' },
  { id: 'l17', timestamp: '14:02:41', level: 'info', message: 'Generating google-services.json and GoogleService-Info.plist...' },
  { id: 'l18', timestamp: '14:02:43', level: 'success', message: '✓ Config files generated and committed.' },
  { id: 'l19', timestamp: '14:02:44', level: 'debug', message: 'MCP server binding project context to workspace...' },
  { id: 'l20', timestamp: '14:02:46', level: 'success', message: '✓ Provisioning complete. 1 manual action required.' },
];

export const OVERVIEW_STATS = [
  { id: 'health', label: 'Service Health', value: '5/6', sub: 'Operational', icon: Activity, color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
  { id: 'deploys', label: 'Deployments', value: '14', sub: 'Last 30 days', icon: Package, color: 'text-blue-500', bg: 'bg-blue-500/10' },
  { id: 'uptime', label: 'Avg Uptime', value: '99.6%', sub: 'All services', icon: TrendingUp, color: 'text-violet-500', bg: 'bg-violet-500/10' },
  { id: 'latency', label: 'Avg Latency', value: '103ms', sub: 'P50 across services', icon: Globe, color: 'text-amber-500', bg: 'bg-amber-500/10' },
];

export const DEPLOY_STATUS_CONFIG: Record<string, { color: string; label: string; bg: string }> = {
  success: { color: 'text-emerald-600 dark:text-emerald-400', label: 'Success', bg: 'bg-emerald-500/10 border-emerald-500/30' },
  failed: { color: 'text-red-600 dark:text-red-400', label: 'Failed', bg: 'bg-red-500/10 border-red-500/30' },
  running: { color: 'text-blue-600 dark:text-blue-400', label: 'Running', bg: 'bg-blue-500/10 border-blue-500/30 animate-pulse' },
  queued: { color: 'text-muted-foreground', label: 'Queued', bg: 'bg-muted border-border' },
};

export const LOG_LEVEL_STYLES: Record<LogEntry['level'], string> = {
  info: 'text-slate-400',
  success: 'text-emerald-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
  debug: 'text-purple-400',
};

export const PROJECT_SETUP_CONFIGS: Record<ProviderId, ProjectSetupConfig> = {
  firebase: {
    providerId: 'firebase',
    name: 'Google Cloud Platform',
    icon: Cloud,
    iconColorClass: 'text-blue-500',
    iconBgClass: 'bg-blue-500/10',
    introDescription:
      'Studio creates a dedicated service account in Google Cloud for this project. The SA is granted the minimum IAM roles needed to provision Firebase services. Sign in with Google once so Studio can store a refresh token; project creation, IAM, and SA keys are separate provisioning steps.',
    introBadges: [
      'roles/firebase.admin',
      'roles/iam.serviceAccountAdmin',
      'roles/iam.serviceAccountKeyAdmin',
      'roles/serviceusage.serviceUsageAdmin',
      'roles/cloudkms.admin',
    ],
    setupMethod: 'oauth-or-manual',
    oauthSteps: [
      {
        key: 'oauth_consent',
        label: 'Google authorization',
        description: 'Sign in and grant GCP access; refresh token stored for automated provisioning steps.',
      },
    ],
    steps: [],
    pluginIds: ['firebase-auth', 'firestore', 'fcm', 'app-check', 'vertex-ai'],
    docsUrl: 'https://firebase.google.com/docs/projects/api/workflow_set-up-and-manage-project',
    disconnectSupported: true,
  },
  github: {
    providerId: 'github',
    name: 'GitHub',
    icon: Github,
    iconColorClass: 'text-foreground',
    iconBgClass: 'bg-muted',
    introDescription:
      'Studio creates a dedicated repository for this project with branch protection rules, a deploy key for CI access, and GitHub Actions secrets pre-configured for your build and deploy workflows.',
    setupMethod: 'trigger',
    triggerLabel: 'Create GitHub Repository',
    triggerDescription:
      'Studio will create the repository in your GitHub org, configure branch protection on main, generate a deploy key, and add Actions secrets for the project environment.',
    steps: [
      { id: 'repo_create', label: 'Repository created', description: 'A new GitHub repo is created under your organization.' },
      { id: 'branch_protection', label: 'Branch protection enabled', description: 'Main branch requires PR review and passing status checks.' },
      { id: 'deploy_key', label: 'Deploy key generated', description: 'An SSH deploy key is added for secure CI/CD access.' },
      { id: 'actions_secrets', label: 'Actions secrets configured', description: 'Environment secrets added for build and release workflows.' },
    ],
    pluginIds: ['github-actions'],
    docsUrl: 'https://docs.github.com/en/repositories/creating-and-managing-repositories',
    disconnectSupported: false,
  },
  expo: {
    providerId: 'expo',
    name: 'Expo / EAS',
    icon: Zap,
    iconColorClass: 'text-indigo-500',
    iconBgClass: 'bg-indigo-500/10',
    introDescription:
      'Studio registers this project on Expo Application Services, links the bundle ID, and configures build profiles for iOS and Android. Once initialized, EAS Build and EAS Submit are ready to use.',
    setupMethod: 'trigger',
    triggerLabel: 'Register EAS Application',
    triggerDescription:
      'Studio will create the EAS project on expo.dev, link your bundle ID, and configure development, preview, and production build profiles.',
    steps: [
      { id: 'eas_project', label: 'EAS project created', description: 'Project registered on expo.dev with bundle ID linked.' },
      { id: 'build_profiles', label: 'Build profiles configured', description: 'Development, preview, and production profiles set up.' },
      { id: 'submit_config', label: 'Submit config ready', description: 'Store credentials linked for App Store and Google Play submission.' },
    ],
    pluginIds: ['eas-build', 'eas-submit'],
    docsUrl: 'https://docs.expo.dev/eas/',
    disconnectSupported: false,
  },
  apple: {
    providerId: 'apple',
    name: 'Apple Developer',
    icon: ShieldCheck,
    iconColorClass: 'text-zinc-700 dark:text-zinc-300',
    iconBgClass: 'bg-zinc-500/10',
    introDescription:
      'Apple integration captures the Team ID and an App Store Connect Team API key (Issuer ID + Key ID + .p8) at the organization scope. Studio only supports the fully-automated flow, so all four credentials are required up front; once stored every project can run signing, provisioning, APNs, and TestFlight steps without further prompts.',
    setupMethod: 'trigger',
    triggerLabel: 'Open Apple setup steps',
    triggerDescription:
      'Run the Apple setup steps in the project Setup graph, starting with Register App ID.',
    steps: [
      { id: 'register_app_id', label: 'Register App ID', description: 'Create or verify the bundle identifier in Apple Developer/App Store Connect using org-scoped ASC credentials.' },
      { id: 'create_listing', label: 'Create ASC app listing', description: 'Create or verify the App Store Connect app record for this bundle.' },
    ],
    pluginIds: ['apns'],
    docsUrl: 'https://developer.apple.com/account',
    disconnectSupported: false,
  },
};
