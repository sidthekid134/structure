import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Bell as BellIcon,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  Cloud,
  Code2,
  Copy,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  GitBranch,
  Github,
  Globe,
  HardDrive,
  Info,
  KeyRound,
  Layers,
  Link2,
  Loader2,
  Moon,
  Package,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Sun,
  Trash2,
  TrendingUp,
  Unlink,
  User,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

type StudioView = 'overview' | 'project' | 'project-providers' | 'runs' | 'registry' | 'infrastructure';
type ProviderId = 'firebase' | 'expo' | 'github';
type SetupTaskStatus = 'idle' | 'running' | 'completed' | 'error' | 'manual-required';

interface RegistryPlugin {
  id: string;
  name: string;
  provider: string;
  providerId: ProviderId | 'studio' | 'other';
  description: string;
  categories: string[];
  version: string;
  future?: boolean;
}

interface RegistryCategory {
  id: string;
  label: string;
  icon: React.ElementType;
  color: string;
  pluginIds: string[];
}

interface IntegrationField {
  key: string;
  label: string;
  placeholder: string;
  hint: string;
  type: 'text' | 'password' | 'textarea';
}

interface IntegrationConfig {
  id: ProviderId;
  scope: 'organization' | 'project';
  orgAvailability?: 'automatic' | 'requires-credentials';
  name: string;
  logo: React.ElementType;
  logoColor: string;
  description: string;
  docsUrl: string;
  fields: IntegrationField[];
  supportsOAuth?: boolean;
}

interface IntegrationDependencyStatus {
  key: string;
  label: string;
  required: boolean;
  source: 'project' | 'organization' | 'integration';
  description: string;
  value: string | null;
  status: 'ready' | 'missing';
}

interface IntegrationPlannedResourceStatus {
  key: string;
  label: string;
  description: string;
  naming: string;
  standardized_name: string;
}

interface IntegrationDependencyProviderStatus {
  provider: string;
  scope: 'organization' | 'project';
  dependencies: IntegrationDependencyStatus[];
  plannedResources: IntegrationPlannedResourceStatus[];
}

type SetupPlanStepStatus = 'idle' | 'in_progress' | 'completed' | 'failed';

interface ConnectedProviders {
  firebase: boolean;
  expo: boolean;
  github: boolean;
}

const mapGcpStepToSetupStatus = (
  status: GcpOAuthStepStatus['status'] | undefined,
): SetupPlanStepStatus => {
  if (status === 'completed') return 'completed';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'failed') return 'failed';
  return 'idle';
};

interface InfraPluginCategory {
  id: string;
  label: string;
  icon: React.ElementType;
  color: string;
  description: string;
  plugins: InfraPlugin[];
}

interface InfraConfigField {
  key: string;
  label: string;
  placeholder: string;
  type: 'text' | 'select';
  options?: string[];
}

interface SetupTask {
  id: string;
  title: string;
  description: string;
  duration: number;
  manualRequired?: boolean;
  manualLabel?: string;
}

interface InfraPlugin {
  id: string;
  name: string;
  provider: string;
  description: string;
  configFields: InfraConfigField[];
  setupTasks: SetupTask[];
}

interface ProjectPluginState {
  categoryId: string;
  selectedPluginId: string | null;
  configValues: Record<string, string>;
  setupStatus: SetupTaskStatus;
  taskStates: Record<string, SetupTaskStatus>;
  completedAt?: string;
}

interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  bundleId: string;
  updatedAt: string;
  integration_progress: { configured: number; total: number };
}

interface ProjectDetail {
  project: {
    id: string;
    name: string;
    slug: string;
    bundleId: string;
    updatedAt: string;
  };
  integrations: Record<string, unknown>;
  provisioning: {
    runs: Array<{
      id: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>;
  };
}

interface IntegrationStatusRecord {
  status?: string;
  config?: Record<string, string>;
}

interface OrganizationProfile {
  integrations?: Record<string, IntegrationStatusRecord>;
}

interface GcpOAuthStepStatus {
  id: 'oauth_consent' | 'gcp_project' | 'service_account' | 'iam_binding' | 'vault';
  label: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  message?: string;
}

interface GcpOAuthSessionStatus {
  sessionId: string;
  phase: 'awaiting_user' | 'processing' | 'completed' | 'failed' | 'expired';
  connected: boolean;
  error?: string;
  steps: GcpOAuthStepStatus[];
}

const DEFAULT_ENVIRONMENTS = ['dev', 'preview', 'production'];
const SLUG_MAX = 25;

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

const INTEGRATION_CONFIGS: IntegrationConfig[] = [
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
];

const PROVIDER_PLUGIN_MAP: Record<ProviderId, string[]> = {
  firebase: ['firebase-auth', 'firestore', 'fcm', 'app-check', 'vertex-ai'],
  expo: ['eas-build', 'eas-submit'],
  github: ['github-actions'],
};

const ALL_REGISTRY_PLUGINS: RegistryPlugin[] = [
  { id: 'firebase-auth', name: 'Firebase Auth', provider: 'Google Firebase', providerId: 'firebase', description: 'Apple, Google, and Email/Password auth with built-in session management.', categories: ['auth', 'security'], version: '2.1.0' },
  { id: 'clerk-auth', name: 'Clerk Auth', provider: 'Clerk', providerId: 'other', description: 'Next-gen user management with pre-built UI components and webhooks.', categories: ['auth', 'security'], version: '1.0.0', future: true },
  { id: 'mock-auth', name: 'Mock Auth', provider: 'Studio Core', providerId: 'studio', description: 'Local development authentication mock with configurable user fixtures.', categories: ['auth'], version: '1.3.2' },
  { id: 'firestore', name: 'Cloud Firestore', provider: 'Google Firebase', providerId: 'firebase', description: 'Real-time NoSQL document database with offline sync and security rules.', categories: ['persistence', 'security'], version: '3.0.1' },
  { id: 'supabase-db', name: 'Supabase DB', provider: 'Supabase', providerId: 'other', description: 'PostgreSQL-backed relational database with Edge Functions and Row Level Security.', categories: ['persistence', 'security'], version: '1.1.0', future: true },
  { id: 'mock-db', name: 'Mock DB', provider: 'Studio Core', providerId: 'studio', description: 'Local in-memory store for offline-first development and testing.', categories: ['persistence'], version: '1.2.0' },
  { id: 'vertex-ai', name: 'Google Vertex AI', provider: 'Google Cloud', providerId: 'firebase', description: 'Gemini 1.5 Pro integration via Firebase Extensions with streaming support.', categories: ['intelligence'], version: '1.4.0' },
  { id: 'openai-llm', name: 'OpenAI GPT-4', provider: 'OpenAI', providerId: 'other', description: 'Direct GPT-4o API integration with function calling and tool use.', categories: ['intelligence'], version: '0.9.0', future: true },
  { id: 'eas-build', name: 'EAS Build', provider: 'Expo', providerId: 'expo', description: 'Managed cloud builds for iOS and Android with environment profiles.', categories: ['build-pipeline'], version: '2.5.3' },
  { id: 'github-actions', name: 'GitHub Actions', provider: 'GitHub', providerId: 'github', description: 'CI/CD workflow automation triggered on push, PR, or manual dispatch.', categories: ['build-pipeline'], version: '1.8.0' },
  { id: 'eas-submit', name: 'EAS Submit', provider: 'Expo', providerId: 'expo', description: 'Automated binary submission to App Store Connect and Google Play.', categories: ['build-pipeline'], version: '2.1.0' },
  { id: 'fcm', name: 'Firebase Cloud Messaging', provider: 'Google Firebase', providerId: 'firebase', description: 'Cross-platform push notifications with topic subscriptions and data payloads.', categories: ['notifications'], version: '2.0.0' },
  { id: 'apns', name: 'Apple APNs', provider: 'Apple', providerId: 'other', description: 'Native iOS push notification delivery with p8 key authentication.', categories: ['notifications', 'security'], version: '1.5.0' },
  { id: 'onesignal', name: 'OneSignal', provider: 'OneSignal', providerId: 'other', description: 'Multi-platform notification orchestration with A/B testing and analytics.', categories: ['notifications'], version: '0.8.0', future: true },
  { id: 'app-check', name: 'Firebase App Check', provider: 'Google Firebase', providerId: 'firebase', description: 'Attestation service that protects backend resources from abuse.', categories: ['security'], version: '1.2.0' },
  { id: 'keychain', name: 'Secure Keychain', provider: 'Studio Core', providerId: 'studio', description: 'iOS Keychain and Android Keystore abstraction for sensitive credential storage.', categories: ['security'], version: '2.0.0' },
];

const REGISTRY_CATEGORIES: RegistryCategory[] = [
  { id: 'auth', label: 'Authentication', icon: KeyRound, color: 'text-violet-500', pluginIds: ALL_REGISTRY_PLUGINS.filter((p) => p.categories.includes('auth')).map((p) => p.id) },
  { id: 'persistence', label: 'Persistence Store', icon: HardDrive, color: 'text-blue-500', pluginIds: ALL_REGISTRY_PLUGINS.filter((p) => p.categories.includes('persistence')).map((p) => p.id) },
  { id: 'security', label: 'Security', icon: ShieldCheck, color: 'text-emerald-500', pluginIds: ALL_REGISTRY_PLUGINS.filter((p) => p.categories.includes('security')).map((p) => p.id) },
  { id: 'build-pipeline', label: 'Build Pipeline', icon: Wrench, color: 'text-orange-500', pluginIds: ALL_REGISTRY_PLUGINS.filter((p) => p.categories.includes('build-pipeline')).map((p) => p.id) },
  { id: 'notifications', label: 'Notifications', icon: BellIcon, color: 'text-pink-500', pluginIds: ALL_REGISTRY_PLUGINS.filter((p) => p.categories.includes('notifications')).map((p) => p.id) },
  { id: 'intelligence', label: 'Intelligence / AI', icon: Sparkles, color: 'text-amber-500', pluginIds: ALL_REGISTRY_PLUGINS.filter((p) => p.categories.includes('intelligence')).map((p) => p.id) },
];

const CATEGORY_LABEL_MAP: Record<string, string> = {
  auth: 'Auth',
  persistence: 'Persistence',
  security: 'Security',
  'build-pipeline': 'Build',
  notifications: 'Notifications',
  intelligence: 'AI',
};

const CATEGORY_PILL_STYLE: Record<string, string> = {
  auth: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30',
  persistence: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  security: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  'build-pipeline': 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30',
  notifications: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/30',
  intelligence: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
};

const INFRA_CATEGORIES: InfraPluginCategory[] = [
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
          { key: 'defaultProfile', label: 'Default Build Profile', placeholder: 'development', type: 'select', options: ['development', 'staging', 'production'] },
          { key: 'node', label: 'Node Version', placeholder: '20', type: 'select', options: ['18', '20', '22'] },
        ],
        setupTasks: [
          { id: 'eas-1', title: 'Authenticate with Expo', description: 'Validate robot token and resolve account slug', duration: 1000 },
          { id: 'eas-2', title: 'Create EAS project', description: 'Initialize EAS project linked to bundle ID', duration: 1500 },
          { id: 'eas-3', title: 'Generate eas.json', description: 'Create build profiles: development, staging, production', duration: 700 },
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

interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'warn' | 'error' | 'debug';
  message: string;
}

interface ServiceHealth {
  id: string;
  name: string;
  provider: string;
  uptime: number;
  latency: number;
  status: 'operational' | 'degraded' | 'outage' | 'provisioning';
  lastCheck: string;
}

interface DeploymentRecord {
  id: string;
  version: string;
  branch: string;
  commit: string;
  triggeredBy: string;
  status: 'success' | 'failed' | 'running' | 'queued';
  platform: 'ios' | 'android' | 'both';
  createdAt: string;
  duration?: string;
}

const SERVICE_HEALTH_DATA: ServiceHealth[] = [
  { id: 'sh1', name: 'Firebase Auth', provider: 'Firebase', uptime: 99.97, latency: 42, status: 'operational', lastCheck: '12s ago' },
  { id: 'sh2', name: 'Cloud Firestore', provider: 'Firebase', uptime: 99.94, latency: 68, status: 'operational', lastCheck: '12s ago' },
  { id: 'sh3', name: 'GitHub Repository', provider: 'GitHub', uptime: 100, latency: 24, status: 'operational', lastCheck: '5s ago' },
  { id: 'sh4', name: 'EAS Build', provider: 'Expo', uptime: 98.2, latency: 310, status: 'degraded', lastCheck: '30s ago' },
  { id: 'sh5', name: 'Apple APNs', provider: 'Apple', uptime: 99.99, latency: 91, status: 'operational', lastCheck: '18s ago' },
  { id: 'sh6', name: 'Vertex AI', provider: 'GCP', uptime: 99.5, latency: 182, status: 'operational', lastCheck: '22s ago' },
];

const MOCK_LOGS: LogEntry[] = [
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

const OVERVIEW_STATS = [
  { id: 'health', label: 'Service Health', value: '5/6', sub: 'Operational', icon: Activity, color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
  { id: 'deploys', label: 'Deployments', value: '14', sub: 'Last 30 days', icon: Package, color: 'text-blue-500', bg: 'bg-blue-500/10' },
  { id: 'uptime', label: 'Avg Uptime', value: '99.6%', sub: 'All services', icon: TrendingUp, color: 'text-violet-500', bg: 'bg-violet-500/10' },
  { id: 'latency', label: 'Avg Latency', value: '103ms', sub: 'P50 across services', icon: Globe, color: 'text-amber-500', bg: 'bg-amber-500/10' },
];

const DEPLOY_STATUS_CONFIG: Record<string, { color: string; label: string; bg: string }> = {
  success: { color: 'text-emerald-600 dark:text-emerald-400', label: 'Success', bg: 'bg-emerald-500/10 border-emerald-500/30' },
  failed: { color: 'text-red-600 dark:text-red-400', label: 'Failed', bg: 'bg-red-500/10 border-red-500/30' },
  running: { color: 'text-blue-600 dark:text-blue-400', label: 'Running', bg: 'bg-blue-500/10 border-blue-500/30 animate-pulse' },
  queued: { color: 'text-muted-foreground', label: 'Queued', bg: 'bg-muted border-border' },
};

const LOG_LEVEL_STYLES: Record<LogEntry['level'], string> = {
  info: 'text-slate-400',
  success: 'text-emerald-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
  debug: 'text-purple-400',
};

// --- IntegrationModal ---

interface FirebaseConnectionDetails {
  project_id?: string;
  service_account_email?: string;
  connected_by?: string;
}

function IntegrationModal({
  config,
  isConnected,
  connectionDetails,
  dependencyStatus,
  onClose,
  onConnect,
  onOAuthStart,
  onDisconnect,
}: {
  config: IntegrationConfig;
  isConnected: boolean;
  connectionDetails?: FirebaseConnectionDetails | null;
  dependencyStatus?: IntegrationDependencyProviderStatus;
  onClose: () => void;
  onConnect: (providerId: ProviderId, fields: Record<string, string>) => Promise<void>;
  onOAuthStart?: (
    providerId: ProviderId,
    onProgress: (progress: GcpOAuthSessionStatus) => void,
  ) => Promise<void>;
  onDisconnect: (providerId: ProviderId) => Promise<void>;
}) {
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [revealedFields, setRevealedFields] = useState<Record<string, boolean>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [connectMode, setConnectMode] = useState<'oauth' | 'manual'>(config.supportsOAuth ? 'oauth' : 'manual');
  const [oauthStatus, setOauthStatus] = useState<'idle' | 'waiting' | 'success' | 'error'>('idle');
  const [oauthProgress, setOauthProgress] = useState<GcpOAuthSessionStatus | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [isDependenciesCollapsed, setIsDependenciesCollapsed] = useState(false);
  const [dependencySectionTouched, setDependencySectionTouched] = useState(false);
  const [setupPlanStepStates, setSetupPlanStepStates] = useState<Record<string, SetupPlanStepStatus>>({});
  const [isRunningSetupChecks, setIsRunningSetupChecks] = useState(false);
  const [setupChecksComplete, setSetupChecksComplete] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [copiedValueKey, setCopiedValueKey] = useState<string | null>(null);
  const LogoIcon = config.logo;
  const allFilled = config.fields.every((f) => (fieldValues[f.key] ?? '').trim().length > 0);
  const allDependenciesReady =
    (dependencyStatus?.dependencies.length ?? 0) > 0 &&
    (dependencyStatus?.dependencies.every((dependency) => dependency.status === 'ready') ?? false);
  const hasSetupPlan = (dependencyStatus?.plannedResources.length ?? 0) > 0;
  const requiresSetupChecksBeforeSave =
    config.id === 'firebase' && !isConnected && connectMode === 'manual' && hasSetupPlan;
  const firebaseConnectedProjectId = connectionDetails?.project_id?.trim() || '';
  const firebaseConnectedServiceAccountEmail = connectionDetails?.service_account_email?.trim() || '';
  const plannedFirebaseProjectId =
    dependencyStatus?.plannedResources.find((resource) => resource.key === 'gcp_project')?.standardized_name ?? '';
  const effectiveFirebaseProjectId = firebaseConnectedProjectId || plannedFirebaseProjectId;
  const oauthStepById = useMemo(() => {
    return Object.fromEntries((oauthProgress?.steps ?? []).map((step) => [step.id, step])) as Partial<
      Record<GcpOAuthStepStatus['id'], GcpOAuthStepStatus>
    >;
  }, [oauthProgress]);
  const shouldUseOauthPlanTimeline =
    config.id === 'firebase' &&
    connectMode === 'oauth' &&
    (oauthStatus === 'waiting' || oauthStatus === 'success' || oauthStatus === 'error') &&
    Boolean(oauthProgress);
  const getEffectiveSetupPlanStepStatus = (resourceKey: string): SetupPlanStepStatus => {
    if (config.id === 'firebase' && isConnected) {
      if (
        resourceKey === 'gcp_project' ||
        resourceKey === 'provisioner_service_account' ||
        resourceKey === 'provisioner_service_account_key'
      ) {
        return 'completed';
      }
    }

    if (!shouldUseOauthPlanTimeline) {
      return setupPlanStepStates[resourceKey] ?? 'idle';
    }

    if (resourceKey === 'gcp_project') {
      return mapGcpStepToSetupStatus(oauthStepById.gcp_project?.status);
    }
    if (resourceKey === 'provisioner_service_account') {
      const serviceAccountStep = oauthStepById.service_account?.status;
      const iamBindingStep = oauthStepById.iam_binding?.status;
      if (serviceAccountStep === 'failed' || iamBindingStep === 'failed') {
        return 'failed';
      }
      if (iamBindingStep === 'in_progress') {
        return 'in_progress';
      }
      if (iamBindingStep === 'completed') {
        return 'completed';
      }
      return mapGcpStepToSetupStatus(serviceAccountStep);
    }
    if (resourceKey === 'provisioner_service_account_key') {
      return mapGcpStepToSetupStatus(oauthStepById.vault?.status);
    }

    return setupPlanStepStates[resourceKey] ?? 'idle';
  };

  const getSetupPlanDisplayName = (resource: IntegrationPlannedResourceStatus): string => {
    if (config.id !== 'firebase') {
      return resource.standardized_name;
    }

    if (resource.key === 'gcp_project') {
      return effectiveFirebaseProjectId || resource.standardized_name;
    }
    if (resource.key === 'provisioner_service_account') {
      return firebaseConnectedServiceAccountEmail || resource.standardized_name;
    }
    if (resource.key === 'provisioner_service_account_key') {
      return resource.standardized_name.replace('::', '/');
    }

    return resource.standardized_name;
  };

  useEffect(() => {
    setDependencySectionTouched(false);
  }, [config.id, isConnected]);

  useEffect(() => {
    if (!dependencySectionTouched) {
      setIsDependenciesCollapsed(allDependenciesReady);
    }
  }, [allDependenciesReady, dependencySectionTouched]);

  useEffect(() => {
    const initialStepStates = Object.fromEntries(
      (dependencyStatus?.plannedResources ?? []).map((resource) => [resource.key, 'idle' as SetupPlanStepStatus]),
    );
    setSetupPlanStepStates(initialStepStates);
    setSetupChecksComplete(false);
    setIsRunningSetupChecks(false);
    setManualError(null);
  }, [config.id, isConnected, dependencyStatus?.plannedResources]);

  const getSetupPlanLinks = (
    resource: IntegrationPlannedResourceStatus,
    displayName: string,
  ): Array<{ label: string; url: string }> => {
    if (config.id === 'firebase') {
      if (resource.key === 'gcp_project') {
        return [
          {
            label: 'Open GCP project',
            url: `https://console.cloud.google.com/home/dashboard?project=${encodeURIComponent(displayName)}`,
          },
          {
            label: 'Project IAM',
            url: `https://console.cloud.google.com/iam-admin/iam?project=${encodeURIComponent(displayName)}`,
          },
        ];
      }
      if (resource.key === 'provisioner_service_account') {
        const projectId = displayName.split('@')[1]?.split('.iam.gserviceaccount.com')[0] ?? effectiveFirebaseProjectId;
        return [
          {
            label: 'Service accounts',
            url: `https://console.cloud.google.com/iam-admin/serviceaccounts?project=${encodeURIComponent(projectId)}`,
          },
          {
            label: 'Provisioner IAM details',
            url: `https://console.cloud.google.com/iam-admin/serviceaccounts/details/${encodeURIComponent(displayName)}?project=${encodeURIComponent(projectId)}`,
          },
        ];
      }
      if (resource.key === 'provisioner_service_account_key') {
        const projectId = effectiveFirebaseProjectId;
        return [
          {
            label: 'Service account keys',
            url: `https://console.cloud.google.com/iam-admin/serviceaccounts?project=${encodeURIComponent(projectId)}`,
          },
          {
            label: 'Secret storage guide',
            url: config.docsUrl,
          },
        ];
      }
    }

    if (resource.key === 'github_identity') {
      return [
        { label: 'GitHub token settings', url: 'https://github.com/settings/tokens' },
        { label: 'GitHub profile', url: 'https://github.com/settings/profile' },
      ];
    }

    if (resource.key === 'expo_identity') {
      return [
        { label: 'Expo account', url: 'https://expo.dev/accounts' },
        { label: 'Expo access tokens', url: 'https://expo.dev/settings/access-tokens' },
      ];
    }

    return [{ label: 'Setup guide', url: config.docsUrl }];
  };

  const handleCopyValue = async (key: string, value: string): Promise<void> => {
    if (!value.trim()) return;
    await navigator.clipboard.writeText(value);
    setCopiedValueKey(key);
    window.setTimeout(() => {
      setCopiedValueKey((current) => (current === key ? null : current));
    }, 1400);
  };

  const runSetupChecks = async (): Promise<void> => {
    if (!dependencyStatus) {
      throw new Error('Dependency status is unavailable. Re-open this modal and try again.');
    }

    const missingRequiredDependencies = dependencyStatus.dependencies.filter(
      (dependency) => dependency.required && dependency.status !== 'ready',
    );
    if (missingRequiredDependencies.length > 0) {
      setSetupPlanStepStates((previous) => {
        const next = { ...previous };
        dependencyStatus.plannedResources.forEach((resource) => {
          next[resource.key] = 'failed';
        });
        return next;
      });
      throw new Error(
        `Missing required dependencies: ${missingRequiredDependencies.map((dependency) => dependency.label).join(', ')}`,
      );
    }

    setIsRunningSetupChecks(true);
    setSetupChecksComplete(false);

    try {
      for (const resource of dependencyStatus.plannedResources) {
        setSetupPlanStepStates((previous) => ({ ...previous, [resource.key]: 'in_progress' }));
        await new Promise((resolve) => setTimeout(resolve, 650));
        setSetupPlanStepStates((previous) => ({ ...previous, [resource.key]: 'completed' }));
      }
      setSetupChecksComplete(true);
    } catch (error) {
      setSetupChecksComplete(false);
      throw error;
    } finally {
      setIsRunningSetupChecks(false);
    }
  };

  const handleManualConnect = async () => {
    if (!allFilled) return;
    setManualError(null);
    if (requiresSetupChecksBeforeSave && !setupChecksComplete) {
      try {
        await runSetupChecks();
      } catch (err) {
        setManualError((err as Error).message);
      }
      return;
    }
    setIsSubmitting(true);
    try {
      await onConnect(config.id, fieldValues);
      setIsSubmitting(false);
      setSubmitted(true);
      setTimeout(() => {
        onClose();
      }, 900);
    } catch (err) {
      setManualError((err as Error).message);
      setIsSubmitting(false);
    }
  };

  const handleOAuthConnect = async () => {
    if (!onOAuthStart) return;
    setOauthStatus('waiting');
    setOauthProgress(null);
    setOauthError(null);
    try {
      await onOAuthStart(config.id, (progress) => {
        setOauthProgress(progress);
      });
      setOauthStatus('success');
      setTimeout(() => {
        onClose();
      }, 900);
    } catch (err) {
      setOauthStatus('error');
      setOauthError((err as Error).message);
    }
  };

  const handleDisconnect = async () => {
    setIsSubmitting(true);
    try {
      await onDisconnect(config.id);
    } finally {
      setIsSubmitting(false);
    }
    onClose();
  };

  const affectedPluginIds = PROVIDER_PLUGIN_MAP[config.id] ?? [];
  const affectedPlugins = ALL_REGISTRY_PLUGINS.filter((p) => affectedPluginIds.includes(p.id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="bg-background border border-border rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-6 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center shrink-0">
              <LogoIcon size={20} className={config.logoColor} />
            </div>
            <div>
              <h2 className="font-bold text-base tracking-tight">{config.name}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isConnected ? (
                  <span className="flex items-center gap-1 text-emerald-500 font-medium">
                    <CheckCircle2 size={11} />
                    <span>Connected</span>
                  </span>
                ) : (
                  <span>Not connected</span>
                )}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-5 max-h-[60vh] overflow-y-auto">
          <p className="text-sm text-muted-foreground leading-relaxed">{config.description}</p>

          <div className="bg-muted/50 rounded-xl p-4 space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Unlocks {affectedPlugins.length} plugins</p>
            <div className="flex flex-wrap gap-2">
              {affectedPlugins.map((p) => (
                <span key={p.id} className="flex items-center gap-1.5 text-[11px] font-medium bg-background border border-border px-2 py-1 rounded-lg">
                  <Code2 size={11} className="text-muted-foreground" />
                  <span>{p.name}</span>
                </span>
              ))}
            </div>
          </div>

          {dependencyStatus && dependencyStatus.dependencies.length > 0 && (
            <div className="bg-muted/50 rounded-xl p-4 space-y-2.5">
              <button
                type="button"
                onClick={() => {
                  setDependencySectionTouched(true);
                  setIsDependenciesCollapsed((previous) => !previous);
                }}
                className="w-full flex items-center justify-between text-left"
              >
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Required Dependencies
                </span>
                <div className="flex items-center gap-2">
                  {allDependenciesReady && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10">
                      All satisfied
                    </span>
                  )}
                  <ChevronRight
                    size={14}
                    className={`text-muted-foreground transition-transform ${isDependenciesCollapsed ? '' : 'rotate-90'}`}
                  />
                </div>
              </button>
              {!isDependenciesCollapsed && (
                <div className="space-y-2">
                  {dependencyStatus.dependencies.map((dependency) => (
                    <div key={dependency.key} className="rounded-lg border border-border bg-background px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-semibold text-foreground">{dependency.label}</div>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                            dependency.status === 'ready'
                              ? 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
                              : 'border-amber-500/30 text-amber-600 dark:text-amber-400 bg-amber-500/10'
                          }`}
                        >
                          {dependency.status === 'ready' ? 'Ready' : 'Missing'}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">{dependency.description}</p>
                      {dependency.value && (
                        <p className="mt-1 text-[11px] font-mono text-foreground">{dependency.value}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {dependencyStatus && dependencyStatus.plannedResources.length > 0 && (
            <div className="bg-muted/50 rounded-xl p-4 space-y-2.5">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Standardized Setup Plan
              </p>
              <div className="space-y-2">
                {dependencyStatus.plannedResources.map((resource, stepIdx) => {
                  const stepStatus = getEffectiveSetupPlanStepStatus(resource.key);
                  const displayName = getSetupPlanDisplayName(resource);
                  const stepLinks = getSetupPlanLinks(resource, displayName);
                  const primaryStepLink = stepLinks[0];
                  const isLastStep = stepIdx === dependencyStatus.plannedResources.length - 1;
                  return (
                    <div key={resource.key} className="relative pl-7">
                      {!isLastStep && <div className="absolute left-2 top-8 bottom-[-10px] w-px bg-border" />}
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        className="rounded-lg border border-border bg-background px-3 py-2"
                      >
                        <motion.div
                          layout
                          className={`absolute -left-1 top-2.5 z-10 w-6 h-6 rounded-full border flex items-center justify-center shadow-sm ${
                            stepStatus === 'completed'
                              ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                              : stepStatus === 'in_progress'
                                ? 'border-primary/40 bg-primary/10 text-primary'
                                : stepStatus === 'failed'
                                  ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                                  : 'border-border bg-background text-muted-foreground'
                          }`}
                        >
                          <AnimatePresence mode="wait" initial={false}>
                            {stepStatus === 'completed' ? (
                              <motion.span
                                key="completed"
                                initial={{ scale: 0.6, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0.6, opacity: 0 }}
                                transition={{ duration: 0.18 }}
                                className="flex items-center justify-center"
                              >
                                <CheckCircle2 size={12} />
                              </motion.span>
                            ) : stepStatus === 'in_progress' ? (
                              <motion.span
                                key="in_progress"
                                initial={{ scale: 0.85, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0.85, opacity: 0 }}
                                transition={{ duration: 0.16 }}
                                className="flex items-center justify-center"
                              >
                                <Loader2 size={12} className="animate-spin" />
                              </motion.span>
                            ) : stepStatus === 'failed' ? (
                              <motion.span
                                key="failed"
                                initial={{ scale: 0.7, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0.7, opacity: 0 }}
                                transition={{ duration: 0.16 }}
                                className="flex items-center justify-center"
                              >
                                <AlertCircle size={12} />
                              </motion.span>
                            ) : (
                              <motion.span
                                key="idle"
                                initial={{ y: 2, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                exit={{ y: -2, opacity: 0 }}
                                transition={{ duration: 0.16 }}
                                className="text-[10px] font-bold leading-none"
                              >
                                {stepIdx + 1}
                              </motion.span>
                            )}
                          </AnimatePresence>
                        </motion.div>
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-foreground">{resource.label}</p>
                          <span className="text-[10px] font-semibold text-muted-foreground">
                            {stepStatus === 'completed'
                              ? 'Complete'
                              : stepStatus === 'in_progress'
                                ? 'Checking...'
                                : stepStatus === 'failed'
                                  ? 'Blocked'
                                  : 'Pending'}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">{resource.description}</p>
                        <div className="mt-1 flex items-start justify-between gap-2">
                          {primaryStepLink ? (
                            <a
                              href={primaryStepLink.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2.5 py-1 text-[11px] font-mono text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5"
                            >
                              <span className="break-all">{displayName}</span>
                              <ExternalLink size={11} className="shrink-0 text-muted-foreground" />
                            </a>
                          ) : (
                            <span className="inline-flex max-w-full items-center rounded-md border border-border bg-muted/60 px-2.5 py-1 text-[11px] font-mono text-foreground">
                              <span className="break-all">{displayName}</span>
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleCopyValue(`plan-${resource.key}`, displayName)}
                            className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                            aria-label={`Copy ${resource.label} value`}
                          >
                            {copiedValueKey === `plan-${resource.key}` ? (
                              <>
                                <CheckCheck size={12} className="text-emerald-500" />
                                <span className="text-emerald-600 dark:text-emerald-400">Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy size={12} />
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                        </div>
                      </motion.div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {manualError && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex items-start gap-2">
              <AlertCircle size={14} className="text-red-500 shrink-0 mt-0.5" />
              <p className="text-xs text-red-600 dark:text-red-400">{manualError}</p>
            </div>
          )}

          {!isConnected && config.supportsOAuth && (
            <div className="space-y-4">
              <div className="flex rounded-lg border border-border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setConnectMode('oauth')}
                  className={`flex-1 text-xs font-bold py-2.5 transition-colors ${connectMode === 'oauth' ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:text-foreground'}`}
                >
                  Sign in with Google
                </button>
                <button
                  type="button"
                  onClick={() => setConnectMode('manual')}
                  className={`flex-1 text-xs font-bold py-2.5 transition-colors border-l border-border ${connectMode === 'manual' ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:text-foreground'}`}
                >
                  Paste SA Key
                </button>
              </div>

              {connectMode === 'oauth' && (
                <div className="space-y-3">
                  <div className="bg-blue-500/8 border border-blue-500/20 rounded-xl p-4">
                    <p className="text-xs text-blue-600 dark:text-blue-400 leading-relaxed">
                      <span className="font-bold">Recommended.</span>{' '}
                      Sign in with your Google account to automatically create a provisioner service account.
                      The OAuth session is used once and discarded — only the SA key is stored.
                    </p>
                  </div>

                  {oauthStatus === 'error' && oauthError && (
                    <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex items-start gap-2">
                      <AlertCircle size={14} className="text-red-500 shrink-0 mt-0.5" />
                      <p className="text-xs text-red-600 dark:text-red-400">{oauthError}</p>
                    </div>
                  )}
                </div>
              )}

              {connectMode === 'manual' && (
                <div className="space-y-4">
                  <div className="bg-amber-500/8 border border-amber-500/20 rounded-xl p-4">
                    <p className="text-xs text-amber-600 dark:text-amber-400 leading-relaxed">
                      <span className="font-bold">Manual mode.</span>{' '}
                      Paste a service account JSON key that you've already created in the Google Cloud Console.
                    </p>
                  </div>
                  {config.fields.map((field) => (
                    <div key={field.key} className="space-y-1.5">
                      <label className="text-xs font-semibold text-foreground">{field.label}</label>
                      {field.type === 'textarea' ? (
                        <textarea
                          rows={5}
                          placeholder={field.placeholder}
                          value={fieldValues[field.key] ?? ''}
                          onChange={(e) => setFieldValues((v) => ({ ...v, [field.key]: e.target.value }))}
                          className="w-full px-3 py-2.5 rounded-lg border border-border bg-background font-mono text-[11px] leading-relaxed focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all resize-none"
                        />
                      ) : (
                        <div className="relative">
                          <input
                            type={field.type === 'password' && !revealedFields[field.key] ? 'password' : 'text'}
                            placeholder={field.placeholder}
                            value={fieldValues[field.key] ?? ''}
                            onChange={(e) => setFieldValues((v) => ({ ...v, [field.key]: e.target.value }))}
                            className="w-full px-3 py-2.5 rounded-lg border border-border bg-background font-mono text-[12px] focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all pr-10"
                          />
                          {field.type === 'password' && (
                            <button
                              type="button"
                              onClick={() => setRevealedFields((v) => ({ ...v, [field.key]: !v[field.key] }))}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                            >
                              {revealedFields[field.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                          )}
                        </div>
                      )}
                      <p className="text-[11px] text-muted-foreground flex gap-1.5 leading-relaxed">
                        <Info size={11} className="shrink-0 mt-0.5" />
                        <span>{field.hint}</span>
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!isConnected && !config.supportsOAuth && (
            <div className="space-y-4">
              {config.fields.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground">{field.label}</label>
                  {field.type === 'textarea' ? (
                    <textarea
                      rows={5}
                      placeholder={field.placeholder}
                      value={fieldValues[field.key] ?? ''}
                      onChange={(e) => setFieldValues((v) => ({ ...v, [field.key]: e.target.value }))}
                      className="w-full px-3 py-2.5 rounded-lg border border-border bg-background font-mono text-[11px] leading-relaxed focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all resize-none"
                    />
                  ) : (
                    <div className="relative">
                      <input
                        type={field.type === 'password' && !revealedFields[field.key] ? 'password' : 'text'}
                        placeholder={field.placeholder}
                        value={fieldValues[field.key] ?? ''}
                        onChange={(e) => setFieldValues((v) => ({ ...v, [field.key]: e.target.value }))}
                        className="w-full px-3 py-2.5 rounded-lg border border-border bg-background font-mono text-[12px] focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all pr-10"
                      />
                      {field.type === 'password' && (
                        <button
                          type="button"
                          onClick={() => setRevealedFields((v) => ({ ...v, [field.key]: !v[field.key] }))}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {revealedFields[field.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      )}
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground flex gap-1.5 leading-relaxed">
                    <Info size={11} className="shrink-0 mt-0.5" />
                    <span>{field.hint}</span>
                  </p>
                </div>
              ))}
            </div>
          )}

          {isConnected && (
            <div className="space-y-3">
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 flex items-center gap-3">
                <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
                <div>
                  <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400">Integration active</p>
                  <p className="text-xs text-emerald-600/80 dark:text-emerald-400/80 mt-0.5">
                    Credentials stored securely in the local vault. All {affectedPlugins.length} plugins are available.
                  </p>
                </div>
              </div>

            </div>
          )}

          <a href={config.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs text-primary font-medium hover:underline">
            <ExternalLink size={12} />
            <span>View setup guide</span>
          </a>
        </div>

        <div className="flex items-center justify-between p-5 border-t border-border bg-muted/20">
          {isConnected ? (
            <button type="button" onClick={() => void handleDisconnect()} disabled={isSubmitting} className="flex items-center gap-2 text-xs font-bold text-red-500 hover:text-red-400 px-3 py-2 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              <Unlink size={13} />
              <span>Disconnect</span>
            </button>
          ) : (
            <div />
          )}
          {!isConnected && connectMode === 'oauth' && config.supportsOAuth && (
            <button
              type="button"
              onClick={() => void handleOAuthConnect()}
              disabled={oauthStatus === 'waiting' || oauthStatus === 'success'}
              className="flex items-center gap-2 bg-foreground text-background px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed ml-auto"
            >
              {oauthStatus === 'waiting' ? (
                <span className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  <span>
                    {oauthProgress?.steps.find((step) => step.status === 'in_progress')?.label ??
                      'Waiting for Google sign-in...'}
                  </span>
                </span>
              ) : oauthStatus === 'success' ? (
                <span className="flex items-center gap-2">
                  <CheckCircle2 size={14} />
                  <span>Connected — continuing...</span>
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Globe size={14} />
                  <span>Sign in with Google</span>
                  <ArrowRight size={13} />
                </span>
              )}
            </button>
          )}
          {!isConnected && (connectMode === 'manual' || !config.supportsOAuth) && (
            <button
              type="button"
              onClick={() => void handleManualConnect()}
              disabled={!allFilled || isSubmitting || isRunningSetupChecks}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed ml-auto"
            >
              {isRunningSetupChecks ? (
                <span className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  <span>Running checks...</span>
                </span>
              ) : isSubmitting ? (
                <span className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  <span>Verifying...</span>
                </span>
              ) : submitted ? (
                <span className="flex items-center gap-2">
                  <CheckCircle2 size={14} />
                  <span>Connected!</span>
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Link2 size={14} />
                  <span>
                    {requiresSetupChecksBeforeSave
                      ? setupChecksComplete
                        ? 'Save Integration'
                        : 'Submit'
                      : 'Connect Integration'}
                  </span>
                  <ArrowRight size={13} />
                </span>
              )}
            </button>
          )}
          {isConnected && (
            <button type="button" onClick={onClose} className="text-xs font-bold px-4 py-2 border border-border rounded-lg hover:bg-accent transition-colors">
              Done
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// --- Project setup config (used by Providers tab + timelines) ---

interface ProjectSetupStep {
  id: string;
  label: string;
  description: string;
}

interface ProjectSetupConfig {
  providerId: ProviderId;
  name: string;
  icon: React.ElementType;
  iconColorClass: string;
  iconBgClass: string;
  introDescription: string;
  introBadges?: string[];
  setupMethod: 'oauth-or-manual' | 'trigger';
  triggerLabel?: string;
  triggerDescription?: string;
  steps: ProjectSetupStep[];
  oauthSteps?: Array<{ key: GcpOAuthStepStatus['id']; label: string; description: string }>;
  pluginIds: string[];
  docsUrl: string;
  disconnectSupported: boolean;
}

const PROJECT_SETUP_CONFIGS: Record<ProviderId, ProjectSetupConfig> = {
  firebase: {
    providerId: 'firebase',
    name: 'Google Cloud Platform',
    icon: Cloud,
    iconColorClass: 'text-blue-500',
    iconBgClass: 'bg-blue-500/10',
    introDescription:
      'Studio creates a dedicated service account in Google Cloud for this project. The SA is granted the minimum IAM roles needed to provision Firebase services. Your personal Google credentials are used once for authorization and are never stored.',
    introBadges: [
      'roles/firebase.admin',
      'roles/iam.serviceAccountAdmin',
      'roles/iam.serviceAccountKeyAdmin',
      'roles/serviceusage.serviceUsageAdmin',
      'roles/cloudkms.admin',
    ],
    setupMethod: 'oauth-or-manual',
    oauthSteps: [
      { key: 'oauth_consent', label: 'Google authorization', description: 'Sign in and grant GCP access to Studio.' },
      { key: 'gcp_project', label: 'GCP project resolved', description: 'Project ID located or created for this project.' },
      { key: 'service_account', label: 'Service account created', description: 'A provisioner SA is created with required IAM roles.' },
      { key: 'iam_binding', label: 'IAM roles bound', description: 'firebase.admin, iam.admin, and cloudkms.admin granted.' },
      { key: 'vault', label: 'Key stored securely', description: 'SA key encrypted and saved to local vault.' },
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
};

function StepTimeline({ steps, stepStatuses }: { steps: ProjectSetupStep[]; stepStatuses: Record<string, SetupPlanStepStatus> }) {
  return (
    <div className="space-y-1.5">
      {steps.map((step, idx) => {
        const status = stepStatuses[step.id] ?? 'idle';
        const isLast = idx === steps.length - 1;
        return (
          <div key={step.id} className="relative pl-7">
            {!isLast && <div className="absolute left-2 top-7 bottom-[-8px] w-px bg-border" />}
            <div
              className={`absolute -left-1 top-2 z-10 w-6 h-6 rounded-full border flex items-center justify-center shadow-sm transition-all ${
                status === 'completed'
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : status === 'in_progress'
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : status === 'failed'
                      ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                      : 'border-border bg-background text-muted-foreground'
              }`}
            >
              <AnimatePresence mode="wait" initial={false}>
                {status === 'completed' ? (
                  <motion.span key="c" initial={{ scale: 0.6 }} animate={{ scale: 1 }} exit={{ scale: 0.6 }} transition={{ duration: 0.15 }}>
                    <CheckCircle2 size={12} />
                  </motion.span>
                ) : status === 'in_progress' ? (
                  <motion.span key="p" initial={{ scale: 0.8 }} animate={{ scale: 1 }} exit={{ scale: 0.8 }} transition={{ duration: 0.15 }}>
                    <Loader2 size={12} className="animate-spin" />
                  </motion.span>
                ) : status === 'failed' ? (
                  <motion.span key="f" initial={{ scale: 0.7 }} animate={{ scale: 1 }} exit={{ scale: 0.7 }} transition={{ duration: 0.15 }}>
                    <AlertCircle size={12} />
                  </motion.span>
                ) : (
                  <motion.span key="i" className="text-[10px] font-bold leading-none">{idx + 1}</motion.span>
                )}
              </AnimatePresence>
            </div>
            <div className="rounded-lg border border-border bg-background px-3 py-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold">{step.label}</p>
                <span className={`text-[10px] font-semibold ${
                  status === 'completed' ? 'text-emerald-600 dark:text-emerald-400' :
                  status === 'in_progress' ? 'text-primary' :
                  status === 'failed' ? 'text-red-600 dark:text-red-400' :
                  'text-muted-foreground'
                }`}>
                  {status === 'completed' ? 'Done' : status === 'in_progress' ? 'Running…' : status === 'failed' ? 'Failed' : 'Pending'}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">{step.description}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- Project Providers tab (dedicated UX; not the org modal or old setup wizard) ---

function ProjectProvidersTab({
  projectName,
  bundleId,
  connectedFirebase,
  firebaseConnectionDetails,
  githubOrgConnected,
  expoOrgConnected,
  githubProjectInitialized,
  expoProjectInitialized,
  integrationDependencyStatus,
  onConnect,
  onOAuthStart,
  onTriggerSetup,
  onDisconnect,
  onRefresh,
}: {
  projectName: string;
  bundleId: string;
  connectedFirebase: boolean;
  firebaseConnectionDetails: FirebaseConnectionDetails | null;
  githubOrgConnected: boolean;
  expoOrgConnected: boolean;
  githubProjectInitialized: boolean;
  expoProjectInitialized: boolean;
  integrationDependencyStatus: Record<string, IntegrationDependencyProviderStatus>;
  onConnect: (providerId: ProviderId, fields: Record<string, string>) => Promise<void>;
  onOAuthStart: (providerId: ProviderId, onProgress: (progress: GcpOAuthSessionStatus) => void) => Promise<void>;
  onTriggerSetup: (providerId: ProviderId) => Promise<void>;
  onDisconnect: (providerId: ProviderId) => Promise<void>;
  onRefresh: () => void | Promise<void>;
}) {
  const [activeProviderTab, setActiveProviderTab] = useState<ProviderId>('firebase');
  const [openModal, setOpenModal] = useState<'github' | 'expo' | null>(null);

  const [gcpPath, setGcpPath] = useState<'oauth' | 'manual'>('oauth');
  const [saJson, setSaJson] = useState('');
  const [gcpOauthStatus, setGcpOauthStatus] = useState<'idle' | 'waiting' | 'success' | 'error'>('idle');
  const [gcpOauthProgress, setGcpOauthProgress] = useState<GcpOAuthSessionStatus | null>(null);
  const [gcpBusy, setGcpBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ghInitRunning, setGhInitRunning] = useState(false);
  const [ghInitSteps, setGhInitSteps] = useState<Record<string, SetupPlanStepStatus>>({});
  const [exInitRunning, setExInitRunning] = useState(false);
  const [exInitSteps, setExInitSteps] = useState<Record<string, SetupPlanStepStatus>>({});

  useEffect(() => {
    if (connectedFirebase) {
      setGcpOauthStatus('idle');
      setGcpOauthProgress(null);
      setError(null);
    }
  }, [connectedFirebase]);

  const gcpCfg = PROJECT_SETUP_CONFIGS.firebase;
  const ghCfg = PROJECT_SETUP_CONFIGS.github;
  const expoCfg = PROJECT_SETUP_CONFIGS.expo;

  const oauthStepById = useMemo(() => {
    return Object.fromEntries((gcpOauthProgress?.steps ?? []).map((s) => [s.id, s])) as Partial<
      Record<GcpOAuthStepStatus['id'], GcpOAuthStepStatus>
    >;
  }, [gcpOauthProgress]);

  const getOAuthTimelineStatus = useCallback(
    (key: GcpOAuthStepStatus['id']): SetupPlanStepStatus => mapGcpStepToSetupStatus(oauthStepById[key]?.status),
    [oauthStepById],
  );

  const oauthTimelineSteps: ProjectSetupStep[] = (gcpCfg.oauthSteps ?? []).map((s) => ({
    id: s.key,
    label: s.label,
    description: s.description,
  }));

  const oauthStepStatuses = useMemo(() => {
    const m: Record<string, SetupPlanStepStatus> = {};
    for (const s of gcpCfg.oauthSteps ?? []) {
      m[s.key] = getOAuthTimelineStatus(s.key);
    }
    return m;
  }, [gcpCfg.oauthSteps, getOAuthTimelineStatus]);

  const runGithubProjectInit = async () => {
    setGhInitRunning(true);
    setError(null);
    const initial = Object.fromEntries(ghCfg.steps.map((s) => [s.id, 'idle' as SetupPlanStepStatus]));
    setGhInitSteps(initial);
    try {
      const p = onTriggerSetup('github');
      for (const step of ghCfg.steps) {
        setGhInitSteps((prev) => ({ ...prev, [step.id]: 'in_progress' }));
        await new Promise((r) => setTimeout(r, 700));
        setGhInitSteps((prev) => ({ ...prev, [step.id]: 'completed' }));
      }
      await p;
      await onRefresh();
    } catch (err) {
      setError((err as Error).message);
      setGhInitSteps((prev) => {
        const next = { ...prev };
        const run = Object.entries(next).find(([, v]) => v === 'in_progress');
        if (run) next[run[0]] = 'failed';
        return next;
      });
    } finally {
      setGhInitRunning(false);
    }
  };

  const runExpoProjectInit = async () => {
    setExInitRunning(true);
    setError(null);
    const initial = Object.fromEntries(expoCfg.steps.map((s) => [s.id, 'idle' as SetupPlanStepStatus]));
    setExInitSteps(initial);
    try {
      const p = onTriggerSetup('expo');
      for (const step of expoCfg.steps) {
        setExInitSteps((prev) => ({ ...prev, [step.id]: 'in_progress' }));
        await new Promise((r) => setTimeout(r, 700));
        setExInitSteps((prev) => ({ ...prev, [step.id]: 'completed' }));
      }
      await p;
      await onRefresh();
    } catch (err) {
      setError((err as Error).message);
      setExInitSteps((prev) => {
        const next = { ...prev };
        const run = Object.entries(next).find(([, v]) => v === 'in_progress');
        if (run) next[run[0]] = 'failed';
        return next;
      });
    } finally {
      setExInitRunning(false);
    }
  };

  const startGcpOAuth = async () => {
    setGcpOauthStatus('waiting');
    setError(null);
    setGcpOauthProgress(null);
    try {
      await onOAuthStart('firebase', (progress) => setGcpOauthProgress(progress));
      setGcpOauthStatus('success');
      await onRefresh();
    } catch (err) {
      setGcpOauthStatus('error');
      setError((err as Error).message);
    }
  };

  const submitManualSa = async () => {
    if (!saJson.trim()) return;
    setGcpBusy(true);
    setError(null);
    try {
      await onConnect('firebase', { gcpServiceAccount: saJson });
      await onRefresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGcpBusy(false);
    }
  };

  const pluginCards = (ids: string[]) =>
    ALL_REGISTRY_PLUGINS.filter((p) => ids.includes(p.id)).map((p) => (
      <div key={p.id} className="rounded-lg border border-border/80 bg-background/80 px-3 py-2.5">
        <p className="text-sm font-semibold leading-snug">{p.name}</p>
        <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">{p.description}</p>
      </div>
    ));

  const PROVIDER_TABS: Array<{
    id: ProviderId;
    label: string;
    icon: React.ElementType;
    iconColor: string;
    statusLabel: string;
    statusColor: string;
  }> = [
    {
      id: 'firebase',
      label: 'GCP',
      icon: Cloud,
      iconColor: 'text-blue-500',
      statusLabel: connectedFirebase ? 'Connected' : 'Not connected',
      statusColor: connectedFirebase
        ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
        : 'text-muted-foreground bg-muted border-border',
    },
    {
      id: 'github',
      label: 'GitHub',
      icon: Github,
      iconColor: 'text-foreground',
      statusLabel:
        githubOrgConnected && githubProjectInitialized ? 'Ready' : githubOrgConnected ? 'Partial' : 'Not connected',
      statusColor:
        githubOrgConnected && githubProjectInitialized
          ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
          : githubOrgConnected
            ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20'
            : 'text-muted-foreground bg-muted border-border',
    },
    {
      id: 'expo',
      label: 'Expo / EAS',
      icon: Zap,
      iconColor: 'text-indigo-500',
      statusLabel:
        expoOrgConnected && expoProjectInitialized ? 'Ready' : expoOrgConnected ? 'Partial' : 'Not connected',
      statusColor:
        expoOrgConnected && expoProjectInitialized
          ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
          : expoOrgConnected
            ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20'
            : 'text-muted-foreground bg-muted border-border',
    },
  ];

  const modalConfig = openModal ? (INTEGRATION_CONFIGS.find((c) => c.id === openModal) ?? null) : null;
  const modalIsConnected = openModal === 'github' ? githubOrgConnected : openModal === 'expo' ? expoOrgConnected : false;

  return (
    <div className="space-y-0 max-w-5xl">
      {/* Provider sub-tab bar */}
      <div className="flex items-center gap-1 border-b border-border mb-6">
        {PROVIDER_TABS.map((tab) => {
          const TabIcon = tab.icon;
          const isActive = activeProviderTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveProviderTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                isActive ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <TabIcon size={15} className={isActive ? tab.iconColor : ''} />
              <span>{tab.label}</span>
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${tab.statusColor}`}>
                {tab.statusLabel}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertCircle size={16} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <AnimatePresence mode="wait">
        {/* ── Firebase tab ── */}
        {activeProviderTab === 'firebase' && (
          <motion.div
            key="firebase"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
            className="space-y-6"
          >
            <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-0 lg:divide-x divide-border">
                <div className="lg:col-span-2 p-5 md:p-6 bg-muted/20 border-b lg:border-b-0 border-border space-y-4">
                  <div className="flex items-center gap-2">
                    <div className="p-2 rounded-xl bg-blue-500/10">
                      <Cloud size={20} className="text-blue-500" />
                    </div>
                    <div>
                      <p className="font-semibold">Google Cloud Platform</p>
                      <p className="text-[11px] text-muted-foreground">Project-scoped — one GCP project per app</p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{gcpCfg.introDescription}</p>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Plugins unlocked</p>
                    <div className="grid gap-2">{pluginCards(gcpCfg.pluginIds)}</div>
                  </div>
                  {gcpCfg.introBadges && gcpCfg.introBadges.length > 0 && (
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Provisioner SA roles</p>
                      <div className="flex flex-wrap gap-1">
                        {gcpCfg.introBadges.map((b) => (
                          <span key={b} className="text-[10px] font-mono bg-background border border-border px-2 py-0.5 rounded text-muted-foreground">
                            {b}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="lg:col-span-3 p-5 md:p-6 space-y-5">
                  {!connectedFirebase ? (
                    <>
                      <div className="flex rounded-lg border border-border p-0.5 bg-muted/40">
                        <button
                          type="button"
                          onClick={() => setGcpPath('oauth')}
                          className={`flex-1 rounded-md py-2 text-xs font-bold transition-colors ${
                            gcpPath === 'oauth' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          Sign in with Google
                        </button>
                        <button
                          type="button"
                          onClick={() => setGcpPath('manual')}
                          className={`flex-1 rounded-md py-2 text-xs font-bold transition-colors ${
                            gcpPath === 'manual' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          Service account JSON
                        </button>
                      </div>

                      {gcpPath === 'oauth' && (
                        <div className="space-y-4">
                          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-xs text-muted-foreground leading-relaxed">
                            <span className="font-semibold text-blue-700 dark:text-blue-300">OAuth flow.</span> Studio opens Google in a new tab, then polls{' '}
                            <span className="font-mono text-[10px]">GET …/oauth/:sessionId</span> until provisioning finishes. Your Google password is never stored.
                          </div>
                          <div className="rounded-lg border border-dashed border-border bg-muted/15 p-3">
                            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Start</p>
                            <pre className="text-[10px] font-mono whitespace-pre-wrap">
                              POST /api/projects/&lt;id&gt;/integrations/firebase/connect/oauth/start
                            </pre>
                          </div>
                          {gcpOauthStatus !== 'idle' && gcpOauthProgress && (
                            <StepTimeline steps={oauthTimelineSteps} stepStatuses={oauthStepStatuses} />
                          )}
                          <button
                            type="button"
                            onClick={() => void startGcpOAuth()}
                            disabled={gcpOauthStatus === 'waiting' || gcpOauthStatus === 'success'}
                            className="w-full flex items-center justify-center gap-2 rounded-lg bg-foreground py-3 text-sm font-bold text-background hover:opacity-90 disabled:opacity-40"
                          >
                            {gcpOauthStatus === 'waiting' ? (
                              <><Loader2 size={16} className="animate-spin" />Waiting for Google…</>
                            ) : gcpOauthStatus === 'success' ? (
                              <><CheckCircle2 size={16} />Connected</>
                            ) : (
                              <><Globe size={16} />Start Google sign-in</>
                            )}
                          </button>
                        </div>
                      )}

                      {gcpPath === 'manual' && (
                        <div className="space-y-3">
                          <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-xs text-muted-foreground leading-relaxed">
                            <span className="font-semibold text-amber-800 dark:text-amber-200">Manual key.</span> Paste JSON for a service account that can enable Firebase in your GCP project.
                          </div>
                          <div className="rounded-lg border border-dashed border-border bg-muted/15 p-3">
                            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Request</p>
                            <pre className="text-[10px] font-mono whitespace-pre-wrap leading-relaxed">
                              {`POST /api/projects/<id>/integrations/firebase/connect\n{\n  "serviceAccountJson": "{ ... }"\n}`}
                            </pre>
                          </div>
                          <textarea
                            rows={8}
                            value={saJson}
                            onChange={(e) => setSaJson(e.target.value)}
                            placeholder={'{\n  "type": "service_account",\n  ...\n}'}
                            className="w-full rounded-lg border border-border bg-background font-mono text-[11px] leading-relaxed p-3"
                          />
                          <button
                            type="button"
                            onClick={() => void submitManualSa()}
                            disabled={!saJson.trim() || gcpBusy}
                            className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-bold text-primary-foreground hover:opacity-90 disabled:opacity-40"
                          >
                            {gcpBusy ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
                            Send service account JSON
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 size={18} />
                        Google Cloud linked for this project
                      </div>
                      <div className="grid gap-2 text-xs">
                        {firebaseConnectionDetails?.project_id && (
                          <div className="flex justify-between gap-4 rounded-lg border border-border px-3 py-2">
                            <span className="text-muted-foreground">GCP project</span>
                            <a
                              href={`https://console.cloud.google.com/home/dashboard?project=${encodeURIComponent(firebaseConnectionDetails.project_id)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-foreground hover:text-primary truncate text-right"
                            >
                              {firebaseConnectionDetails.project_id}
                            </a>
                          </div>
                        )}
                        {firebaseConnectionDetails?.service_account_email && (
                          <div className="flex justify-between gap-4 rounded-lg border border-border px-3 py-2">
                            <span className="text-muted-foreground">Service account</span>
                            <span className="font-mono text-right truncate">{firebaseConnectionDetails.service_account_email}</span>
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => void onDisconnect('firebase')}
                        className="text-xs font-bold text-red-600 dark:text-red-400 border border-red-500/30 rounded-lg px-3 py-2 hover:bg-red-500/10 inline-flex items-center gap-1.5"
                      >
                        <Unlink size={12} />
                        Disconnect GCP / Firebase for this project
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── GitHub tab ── */}
        {activeProviderTab === 'github' && (
          <motion.div
            key="github"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
            className="space-y-6"
          >
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              {/* Info + connect panel */}
              <div className="lg:col-span-2 rounded-2xl border border-border bg-muted/20 p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-xl bg-muted border border-border">
                    <Github size={20} />
                  </div>
                  <div>
                    <p className="font-semibold">GitHub</p>
                    <p className="text-[11px] text-muted-foreground">Organization-level token</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{ghCfg.introDescription}</p>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Plugins unlocked</p>
                  <div className="grid gap-2">{pluginCards(ghCfg.pluginIds)}</div>
                </div>
                <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">Org token request</p>
                  <pre className="text-[10px] font-mono text-foreground/90 whitespace-pre-wrap leading-relaxed">
                    {'POST /api/organization/integrations/github/connect\n{ "token": "<github_pat>" }'}
                  </pre>
                </div>
                <button
                  type="button"
                  onClick={() => setOpenModal('github')}
                  className={`w-full flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-bold transition-colors ${
                    githubOrgConnected
                      ? 'border border-border hover:bg-accent text-foreground'
                      : 'bg-primary text-primary-foreground hover:opacity-90'
                  }`}
                >
                  {githubOrgConnected ? <><Settings2 size={14} />Manage connection</> : <><Link2 size={14} />Connect GitHub</>}
                </button>
              </div>

              {/* Project setup panel */}
              <div className="lg:col-span-3 rounded-2xl border border-border bg-card p-5 md:p-6 space-y-5 shadow-sm">
                <div>
                  <p className="font-semibold text-sm mb-1">Project repository setup</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{ghCfg.triggerDescription}</p>
                </div>
                {!githubOrgConnected && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-800 dark:text-amber-200 flex gap-2">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <span>Connect the organization GitHub token first — Studio cannot create a repo or deploy keys without it.</span>
                  </div>
                )}
                <StepTimeline
                  steps={ghCfg.steps}
                  stepStatuses={
                    githubProjectInitialized
                      ? Object.fromEntries(ghCfg.steps.map((s) => [s.id, 'completed' as const]))
                      : ghInitSteps
                  }
                />
                {githubProjectInitialized ? (
                  <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1.5">
                    <CheckCircle2 size={14} />
                    GitHub Actions module is available for this project.
                  </p>
                ) : (
                  <button
                    type="button"
                    disabled={!githubOrgConnected || ghInitRunning}
                    onClick={() => void runGithubProjectInit()}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground hover:opacity-90 disabled:opacity-40"
                  >
                    {ghInitRunning ? <Loader2 size={14} className="animate-spin" /> : <Github size={14} />}
                    {ghInitRunning ? 'Working…' : 'Create GitHub repository'}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}

        {/* ── Expo tab ── */}
        {activeProviderTab === 'expo' && (
          <motion.div
            key="expo"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
            className="space-y-6"
          >
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              {/* Info + connect panel */}
              <div className="lg:col-span-2 rounded-2xl border border-border bg-muted/20 p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-xl bg-indigo-500/10">
                    <Zap size={20} className="text-indigo-500" />
                  </div>
                  <div>
                    <p className="font-semibold">Expo / EAS</p>
                    <p className="text-[11px] text-muted-foreground">Organization-level robot token</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{expoCfg.introDescription}</p>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Plugins unlocked</p>
                  <div className="grid gap-2">{pluginCards(expoCfg.pluginIds)}</div>
                </div>
                <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">Org token request</p>
                  <pre className="text-[10px] font-mono text-foreground/90 whitespace-pre-wrap leading-relaxed">
                    {'POST /api/organization/integrations/eas/connect\n{ "token": "<expo_robot_token>" }'}
                  </pre>
                </div>
                <button
                  type="button"
                  onClick={() => setOpenModal('expo')}
                  className={`w-full flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-bold transition-colors ${
                    expoOrgConnected
                      ? 'border border-border hover:bg-accent text-foreground'
                      : 'bg-primary text-primary-foreground hover:opacity-90'
                  }`}
                >
                  {expoOrgConnected ? <><Settings2 size={14} />Manage connection</> : <><Link2 size={14} />Connect Expo</>}
                </button>
              </div>

              {/* Project setup panel */}
              <div className="lg:col-span-3 rounded-2xl border border-border bg-card p-5 md:p-6 space-y-5 shadow-sm">
                <div>
                  <p className="font-semibold text-sm mb-1">EAS application setup</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{expoCfg.triggerDescription}</p>
                </div>
                {!expoOrgConnected && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-800 dark:text-amber-200 flex gap-2">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <span>Connect the Expo robot token first — EAS registration uses that account context.</span>
                  </div>
                )}
                <StepTimeline
                  steps={expoCfg.steps}
                  stepStatuses={
                    expoProjectInitialized
                      ? Object.fromEntries(expoCfg.steps.map((s) => [s.id, 'completed' as const]))
                      : exInitSteps
                  }
                />
                {expoProjectInitialized ? (
                  <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1.5">
                    <CheckCircle2 size={14} />
                    EAS Build and EAS Submit modules are available for {bundleId}.
                  </p>
                ) : (
                  <button
                    type="button"
                    disabled={!expoOrgConnected || exInitRunning}
                    onClick={() => void runExpoProjectInit()}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground hover:opacity-90 disabled:opacity-40"
                  >
                    {exInitRunning ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                    {exInitRunning ? 'Working…' : 'Register on EAS'}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* IntegrationModal overlay for org-level connections */}
      <AnimatePresence>
        {openModal && modalConfig && (
          <IntegrationModal
            key={openModal}
            config={modalConfig}
            isConnected={modalIsConnected}
            connectionDetails={null}
            dependencyStatus={integrationDependencyStatus[providerToBackendKey(openModal)]}
            onClose={() => setOpenModal(null)}
            onConnect={onConnect}
            onOAuthStart={onOAuthStart}
            onDisconnect={async (providerId) => {
              await onDisconnect(providerId);
              setOpenModal(null);
              await onRefresh();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// --- InfrastructureTab ---

function InfrastructureTab({ projectPlugins }: { projectPlugins: string[] }) {
  const [pluginStates, setPluginStates] = useState<Record<string, ProjectPluginState>>(() => {
    const initial: Record<string, ProjectPluginState> = {};
    INFRA_CATEGORIES.forEach((cat) => {
      const activePlugin = cat.plugins.find((p) => projectPlugins.includes(p.id));
      initial[cat.id] = {
        categoryId: cat.id,
        selectedPluginId: activePlugin?.id ?? null,
        configValues: {},
        setupStatus: activePlugin ? 'completed' : 'idle',
        taskStates: activePlugin ? Object.fromEntries(activePlugin.setupTasks.map((t) => [t.id, 'completed' as SetupTaskStatus])) : {},
      };
    });
    return initial;
  });
  const [expandedCategory, setExpandedCategory] = useState<string | null>(INFRA_CATEGORIES[0]?.id ?? null);

  const runSetup = (categoryId: string) => {
    const state = pluginStates[categoryId];
    if (!state?.selectedPluginId) return;
    const category = INFRA_CATEGORIES.find((c) => c.id === categoryId);
    if (!category) return;
    const plugin = category.plugins.find((p) => p.id === state.selectedPluginId);
    if (!plugin) return;
    setPluginStates((prev) => ({
      ...prev,
      [categoryId]: {
        ...prev[categoryId],
        setupStatus: 'running',
        taskStates: Object.fromEntries(plugin.setupTasks.map((t) => [t.id, 'idle' as SetupTaskStatus])),
      },
    }));
    let cumulative = 0;
    plugin.setupTasks.forEach((task) => {
      const startDelay = cumulative;
      cumulative += task.duration + 200;
      setTimeout(() => {
        setPluginStates((prev) => ({
          ...prev,
          [categoryId]: {
            ...prev[categoryId],
            taskStates: { ...prev[categoryId].taskStates, [task.id]: 'running' },
          },
        }));
      }, startDelay);
      setTimeout(() => {
        const finalStatus: SetupTaskStatus = task.manualRequired ? 'manual-required' : 'completed';
        setPluginStates((prev) => {
          const newTaskStates = { ...prev[categoryId].taskStates, [task.id]: finalStatus };
          const allDone = plugin.setupTasks.every((t) => {
            const s = newTaskStates[t.id];
            return s === 'completed' || s === 'manual-required';
          });
          const hasManual = plugin.setupTasks.some((t) => newTaskStates[t.id] === 'manual-required');
          return {
            ...prev,
            [categoryId]: {
              ...prev[categoryId],
              taskStates: newTaskStates,
              setupStatus: allDone ? (hasManual ? 'manual-required' : 'completed') : 'running',
              completedAt: allDone ? new Date().toISOString() : undefined,
            },
          };
        });
      }, startDelay + task.duration);
    });
  };

  const resetSetup = (categoryId: string) => {
    setPluginStates((prev) => ({
      ...prev,
      [categoryId]: {
        ...prev[categoryId],
        setupStatus: 'idle',
        taskStates: {},
      },
    }));
  };

  return (
    <div className="space-y-4">
      {INFRA_CATEGORIES.map((category) => {
        const state = pluginStates[category.id];
        const CategoryIcon = category.icon;
        const isExpanded = expandedCategory === category.id;
        const selectedPlugin = category.plugins.find((p) => p.id === state?.selectedPluginId) ?? null;
        const isSetupDone = state?.setupStatus === 'completed' || state?.setupStatus === 'manual-required';
        const isRunning = state?.setupStatus === 'running';
        return (
          <div key={category.id} className={`bg-card border rounded-2xl overflow-hidden transition-all shadow-sm ${isExpanded ? 'border-border' : 'border-border/60'}`}>
            <button
              type="button"
              onClick={() => setExpandedCategory(isExpanded ? null : category.id)}
              className="w-full flex items-center gap-4 p-5 hover:bg-muted/40 transition-colors text-left"
            >
              <div className={`p-2 rounded-xl bg-muted ${category.color}`}>
                <CategoryIcon size={16} />
              </div>
              <div className="flex-grow min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="font-bold text-sm">{category.label}</span>
                  {selectedPlugin && (
                    <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground border border-border">{selectedPlugin.name}</span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">{category.description}</p>
              </div>
              <div className="flex items-center gap-2.5 shrink-0">
                {state?.setupStatus === 'completed' && (
                  <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                    <CheckCircle2 size={10} />
                    <span>CONFIGURED</span>
                  </span>
                )}
                {state?.setupStatus === 'manual-required' && (
                  <span className="flex items-center gap-1 text-[10px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-full">
                    <AlertTriangle size={10} />
                    <span>MANUAL STEP</span>
                  </span>
                )}
                {state?.setupStatus === 'running' && (
                  <span className="flex items-center gap-1 text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 border border-blue-500/30 px-2 py-0.5 rounded-full animate-pulse">
                    <Loader2 size={10} className="animate-spin" />
                    <span>RUNNING</span>
                  </span>
                )}
                {state?.setupStatus === 'idle' && !selectedPlugin && (
                  <span className="text-[10px] font-bold text-muted-foreground bg-muted px-2 py-0.5 rounded-full border border-border">NOT SET</span>
                )}
                <ChevronRight size={16} className={`text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} />
              </div>
            </button>

            <AnimatePresence initial={false}>
              {isExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: 'easeInOut' }}
                  className="overflow-hidden"
                >
                  <div className="border-t border-border">
                    {!isRunning && !isSetupDone && (
                      <div className="p-5 space-y-4">
                        <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Select Plugin</p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {category.plugins.map((plugin) => {
                            const isSelected = state?.selectedPluginId === plugin.id;
                            return (
                              <button
                                key={plugin.id}
                                type="button"
                                onClick={() =>
                                  setPluginStates((prev) => ({
                                    ...prev,
                                    [category.id]: {
                                      ...prev[category.id],
                                      selectedPluginId: plugin.id,
                                      configValues: {},
                                    },
                                  }))
                                }
                                className={`text-left p-4 rounded-xl border-2 transition-all ${isSelected ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-primary/40 hover:bg-muted/40'}`}
                              >
                                <div className="flex items-start justify-between mb-1.5">
                                  <span className="font-bold text-sm">{plugin.name}</span>
                                  {isSelected && <CheckCircle2 size={14} className="text-primary shrink-0" />}
                                </div>
                                <p className="text-[10px] font-medium text-muted-foreground mb-1">{plugin.provider}</p>
                                <p className="text-xs text-muted-foreground leading-relaxed">{plugin.description}</p>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {!isRunning && !isSetupDone && selectedPlugin && selectedPlugin.configFields.length > 0 && (
                      <div className="px-5 pb-4 space-y-3">
                        <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-3">Configuration</p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {selectedPlugin.configFields.map((field) => (
                            <div key={field.key} className="space-y-1.5">
                              <label className="text-xs font-semibold text-foreground">{field.label}</label>
                              {field.type === 'select' && field.options ? (
                                <select
                                  value={state?.configValues[field.key] ?? ''}
                                  onChange={(e) =>
                                    setPluginStates((prev) => ({
                                      ...prev,
                                      [category.id]: {
                                        ...prev[category.id],
                                        configValues: { ...prev[category.id].configValues, [field.key]: e.target.value },
                                      },
                                    }))
                                  }
                                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                                >
                                  <option value="">{field.placeholder}</option>
                                  {field.options.map((opt) => (
                                    <option key={opt} value={opt}>
                                      {opt}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  placeholder={field.placeholder}
                                  value={state?.configValues[field.key] ?? ''}
                                  onChange={(e) =>
                                    setPluginStates((prev) => ({
                                      ...prev,
                                      [category.id]: {
                                        ...prev[category.id],
                                        configValues: { ...prev[category.id].configValues, [field.key]: e.target.value },
                                      },
                                    }))
                                  }
                                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all font-mono"
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {!isRunning && !isSetupDone && (
                      <div className="px-5 pb-5">
                        <button
                          type="button"
                          onClick={() => runSetup(category.id)}
                          disabled={!selectedPlugin}
                          className="flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                        >
                          <Play size={14} fill="currentColor" />
                          <span>Run Setup</span>
                        </button>
                      </div>
                    )}

                    {(isRunning || isSetupDone) && selectedPlugin && (
                      <div className="p-5 space-y-4">
                        <div className="flex items-center justify-between">
                          <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Setup Timeline — {selectedPlugin.name}</p>
                          {isSetupDone && (
                            <button
                              type="button"
                              onClick={() => resetSetup(category.id)}
                              className="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground hover:text-foreground px-2.5 py-1 rounded-lg border border-border hover:bg-accent transition-colors"
                            >
                              <RotateCcw size={10} />
                              <span>Reset</span>
                            </button>
                          )}
                        </div>

                        <div className="space-y-0">
                          {selectedPlugin.setupTasks.map((task, idx) => {
                            const taskStatus = state?.taskStates[task.id] ?? 'idle';
                            const isLast = idx === selectedPlugin.setupTasks.length - 1;
                            return (
                              <div key={task.id} className="flex gap-4">
                                <div className="flex flex-col items-center">
                                  <div
                                    className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border-2 transition-all duration-300 ${
                                      taskStatus === 'completed'
                                        ? 'border-emerald-500 bg-emerald-500/10'
                                        : taskStatus === 'running'
                                          ? 'border-primary bg-primary/10'
                                          : taskStatus === 'manual-required'
                                            ? 'border-amber-500 bg-amber-500/10'
                                            : taskStatus === 'error'
                                              ? 'border-red-500 bg-red-500/10'
                                              : 'border-border bg-background'
                                    }`}
                                  >
                                    {taskStatus === 'completed' && <CheckCircle2 size={13} className="text-emerald-500" />}
                                    {taskStatus === 'running' && <Loader2 size={13} className="text-primary animate-spin" />}
                                    {taskStatus === 'manual-required' && <AlertTriangle size={13} className="text-amber-500" />}
                                    {taskStatus === 'error' && <X size={13} className="text-red-500" />}
                                    {taskStatus === 'idle' && <span className="w-2 h-2 rounded-full bg-muted-foreground/30" />}
                                  </div>
                                  {!isLast && (
                                    <div
                                      className={`w-0.5 flex-grow my-1 transition-all duration-500 ${taskStatus === 'completed' || taskStatus === 'manual-required' ? 'bg-emerald-500/40' : 'bg-border'}`}
                                      style={{ minHeight: '20px' }}
                                    />
                                  )}
                                </div>
                                <div className="flex-grow pb-4">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="pt-0.5">
                                      <p className={`text-sm font-semibold leading-tight ${taskStatus === 'idle' ? 'text-muted-foreground' : 'text-foreground'}`}>{task.title}</p>
                                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{task.description}</p>
                                      {taskStatus === 'manual-required' && task.manualLabel && (
                                        <div className="mt-2 flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5">
                                          <AlertTriangle size={12} className="text-amber-500 shrink-0 mt-0.5" />
                                          <p className="text-[11px] text-amber-600 dark:text-amber-400 leading-relaxed">{task.manualLabel}</p>
                                        </div>
                                      )}
                                    </div>
                                    <div className="shrink-0 pt-0.5">
                                      {taskStatus === 'running' && (
                                        <span className="text-[9px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 border border-blue-500/30 px-1.5 py-0.5 rounded animate-pulse">RUNNING</span>
                                      )}
                                      {taskStatus === 'completed' && (
                                        <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.5 rounded">DONE</span>
                                      )}
                                      {taskStatus === 'manual-required' && (
                                        <span className="text-[9px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">ACTION</span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {isSetupDone && (
                          <div
                            className={`rounded-xl p-3.5 flex items-center gap-3 border ${state?.setupStatus === 'manual-required' ? 'bg-amber-500/10 border-amber-500/30' : 'bg-emerald-500/10 border-emerald-500/30'}`}
                          >
                            {state?.setupStatus === 'manual-required' ? (
                              <AlertTriangle size={16} className="text-amber-500 shrink-0" />
                            ) : (
                              <CheckCheck size={16} className="text-emerald-500 shrink-0" />
                            )}
                            <div>
                              <p className={`text-xs font-bold ${state?.setupStatus === 'manual-required' ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                {state?.setupStatus === 'manual-required' ? 'Setup complete — manual action required' : 'Setup complete'}
                              </p>
                              {state?.completedAt && <p className="text-[10px] text-muted-foreground mt-0.5">Finished at {new Date(state.completedAt).toLocaleTimeString()}</p>}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

// --- OrgOverview ---

function OrgOverview({
  projects,
  onSelectProject,
  connectedProviders,
  onOpenIntegration,
  wsStatus,
  totalModulesConfigured,
}: {
  projects: ProjectSummary[];
  onSelectProject: (id: string) => void;
  connectedProviders: ConnectedProviders;
  onOpenIntegration: (id: ProviderId) => void;
  wsStatus: string;
  totalModulesConfigured: number;
}) {
  const integrationSummary = INTEGRATION_CONFIGS.map((cfg) => ({
    ...cfg,
    connected: connectedProviders[cfg.id],
    pluginCount: PROVIDER_PLUGIN_MAP[cfg.id]?.length ?? 0,
  }));
  const totalModules = projects.reduce((acc, p) => acc + p.integration_progress.total, 0);

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8">
      <header className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Organization</h1>
          <p className="text-muted-foreground mt-1">Manage your projects and infrastructure across the organization.</p>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Smartphone size={15} className="text-primary" />
            </div>
          </div>
          <p className="text-2xl font-bold tracking-tight">{projects.length}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Projects</p>
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">Total in organization</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <Package size={15} className="text-blue-500" />
            </div>
          </div>
          <p className="text-2xl font-bold tracking-tight">{totalModulesConfigured}/{totalModules || 1}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Modules Configured</p>
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">Across all projects</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className="p-2 rounded-lg bg-violet-500/10">
              <TrendingUp size={15} className="text-violet-500" />
            </div>
          </div>
          <p className="text-2xl font-bold tracking-tight">99.6%</p>
          <p className="text-xs text-muted-foreground mt-0.5">Avg Uptime</p>
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">All services</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className={`p-2 rounded-lg ${wsStatus === 'live' ? 'bg-emerald-500/10' : wsStatus === 'connecting' ? 'bg-amber-500/10' : 'bg-muted'}`}>
              <Activity size={15} className={wsStatus === 'live' ? 'text-emerald-500' : wsStatus === 'connecting' ? 'text-amber-500' : 'text-muted-foreground'} />
            </div>
          </div>
          <p className="text-2xl font-bold tracking-tight capitalize">{wsStatus}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Live Status</p>
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">WebSocket connections</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">All Projects</h2>
            <span className="text-[10px] font-bold bg-primary/10 text-primary px-2 py-0.5 rounded-full">{projects.length}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {projects.length === 0 ? (
              <div className="col-span-2 rounded-xl border border-dashed border-border bg-muted/20 p-12 text-center">
                <Smartphone size={48} className="mx-auto text-muted-foreground/50 mb-4" />
                <p className="text-sm text-muted-foreground">No projects yet. Create one to get started.</p>
              </div>
            ) : (
              projects.map((project) => (
                <motion.div
                  key={project.id}
                  whileHover={{ y: -4 }}
                  className="bg-card border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-all cursor-pointer group"
                  onClick={() => onSelectProject(project.id)}
                >
                  <div className="flex justify-between items-start mb-4">
                    <div className="bg-accent p-2 rounded-lg group-hover:bg-primary/10 transition-colors">
                      <Smartphone className="text-primary" size={20} />
                    </div>
                    <span className="text-[10px] font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                      ACTIVE
                    </span>
                  </div>
                  <h3 className="font-semibold text-lg">{project.name}</h3>
                  <p className="text-sm text-muted-foreground font-mono mb-4">{project.bundleId}</p>
                  <div className="flex gap-2 mb-4 flex-wrap">
                    <span className="bg-muted px-2 py-1 rounded text-[10px] uppercase font-bold text-muted-foreground">
                      {project.integration_progress.configured}/{project.integration_progress.total} configured
                    </span>
                  </div>
                  <div className="flex items-center justify-between pt-4 border-t border-border">
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock size={12} />
                      <span>{formatDate(project.updatedAt)}</span>
                    </span>
                    <ChevronRight size={16} className="text-muted-foreground" />
                  </div>
                </motion.div>
              ))
            )}
          </div>
        </div>

        <div className="space-y-4">
          <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Integrations</h2>
          <div className="space-y-2">
            {integrationSummary.map((cfg) => {
              const CfgIcon = cfg.logo;
              const isAutoAvailable = cfg.orgAvailability === 'automatic';
              if (isAutoAvailable) {
                return (
                  <div
                    key={cfg.id}
                    className="w-full flex items-center gap-3 p-3.5 rounded-xl border bg-blue-500/8 border-blue-500/25 text-left shadow-sm"
                  >
                    <div className="p-2 rounded-lg bg-blue-500/12">
                      <CfgIcon size={14} className="text-blue-500" />
                    </div>
                    <div className="flex-grow min-w-0">
                      <p className="text-sm font-semibold truncate">{cfg.name}</p>
                      <p className="text-[10px] text-blue-600/70 dark:text-blue-400/70">Available to all projects</p>
                    </div>
                    <CheckCircle2 size={14} className="text-blue-500 shrink-0" />
                  </div>
                );
              }
              return (
                <button
                  key={cfg.id}
                  type="button"
                  onClick={() => onOpenIntegration(cfg.id)}
                  className={`w-full flex items-center gap-3 p-3.5 rounded-xl border transition-all text-left shadow-sm hover:shadow-md ${
                    cfg.connected ? 'bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/15' : 'bg-card border-dashed border-border hover:border-primary/40'
                  }`}
                >
                  <div className={`p-2 rounded-lg ${cfg.connected ? 'bg-emerald-500/15' : 'bg-muted'}`}>
                    <CfgIcon size={14} className={cfg.connected ? 'text-emerald-500' : 'text-muted-foreground'} />
                  </div>
                  <div className="flex-grow min-w-0">
                    <p className="text-sm font-semibold truncate">{cfg.name}</p>
                    <p className="text-[10px] text-muted-foreground">{cfg.connected ? `${cfg.pluginCount} plugins unlocked` : 'Not connected'}</p>
                  </div>
                  {cfg.connected ? <CheckCircle2 size={14} className="text-emerald-500 shrink-0" /> : <Link2 size={14} className="text-muted-foreground/50 shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- ProjectDetailView ---

function ProjectDetailView({
  projectDetail,
  projectTab,
  onProjectTabChange,
  connectedProviders,
  projectPlugins,
  onDeleteProject,
  firebaseConnectionDetails,
  githubProjectInitialized,
  expoProjectInitialized,
  integrationDependencyStatus,
  onProjectConnect,
  onProjectOAuthStart,
  onProjectTriggerSetup,
  onProjectDisconnect,
  onProjectProvidersRefresh,
}: {
  projectDetail: ProjectDetail;
  projectTab: 'overview' | 'infrastructure' | 'deployments' | 'providers';
  onProjectTabChange: (tab: 'overview' | 'infrastructure' | 'deployments' | 'providers') => void;
  connectedProviders: ConnectedProviders;
  projectPlugins: string[];
  onDeleteProject: () => void;
  firebaseConnectionDetails: FirebaseConnectionDetails | null;
  githubProjectInitialized: boolean;
  expoProjectInitialized: boolean;
  integrationDependencyStatus: Record<string, IntegrationDependencyProviderStatus>;
  onProjectConnect: (providerId: ProviderId, fields: Record<string, string>) => Promise<void>;
  onProjectOAuthStart: (providerId: ProviderId, onProgress: (progress: GcpOAuthSessionStatus) => void) => Promise<void>;
  onProjectTriggerSetup: (providerId: ProviderId) => Promise<void>;
  onProjectDisconnect: (providerId: ProviderId) => Promise<void>;
  onProjectProvidersRefresh: () => void | Promise<void>;
}) {
  const { project, provisioning } = projectDetail;
  // Only show org-scoped integrations (providers with automatic org availability are excluded)
  const activePluginDetails = projectPlugins.map((pid) => {
    const regPlugin = ALL_REGISTRY_PLUGINS.find((p) => p.id === pid);
    const health = SERVICE_HEALTH_DATA.find((s) => s.name.toLowerCase().includes(pid.split('-')[0]));
    return {
      id: pid,
      name: regPlugin?.name ?? pid,
      provider: regPlugin?.provider ?? '—',
      health,
    };
  });
  const runs = provisioning.runs;
  const apiDeployments: DeploymentRecord[] = runs.map((r) => ({
    id: r.id,
    version: '1.0',
    branch: 'main',
    commit: r.id.slice(0, 7),
    triggeredBy: 'system',
    status: (r.status === 'success' ? 'success' : r.status === 'running' ? 'running' : 'failed') as 'success' | 'failed' | 'running' | 'queued',
    platform: 'both' as const,
    createdAt: r.created_at,
    duration: undefined as string | undefined,
  }));
  const mockDeployments: DeploymentRecord[] = [
    { id: 'd1', version: '1.4.2', branch: 'main', commit: 'a3f9c12', triggeredBy: 'studio@acme.co', status: 'success', platform: 'both', createdAt: project.updatedAt, duration: '4m 12s' },
    { id: 'd2', version: '1.4.1', branch: 'main', commit: 'b7e2a88', triggeredBy: 'studio@acme.co', status: 'success', platform: 'ios', createdAt: project.updatedAt, duration: '3m 58s' },
    { id: 'd3', version: '1.4.1', branch: 'fix/auth', commit: 'c1d5f44', triggeredBy: 'studio@acme.co', status: 'failed', platform: 'android', createdAt: project.updatedAt, duration: '1m 33s' },
    { id: 'd4', version: '1.4.0', branch: 'main', commit: 'e9b3c77', triggeredBy: 'studio@acme.co', status: 'success', platform: 'both', createdAt: project.updatedAt, duration: '5m 02s' },
    { id: 'd5', version: '1.5.0-beta', branch: 'feat/vertex', commit: 'f4a8d31', triggeredBy: 'studio@acme.co', status: 'running', platform: 'both', createdAt: project.updatedAt },
  ];
  const allDeployments = apiDeployments.length > 0 ? [...apiDeployments, ...mockDeployments.slice(0, 2)] : mockDeployments;

  const PROJECT_TABS = [
    { id: 'overview' as const, label: 'Overview', icon: Activity },
    { id: 'providers' as const, label: 'Providers', icon: Plug },
    { id: 'infrastructure' as const, label: 'Infrastructure', icon: Server },
    { id: 'deployments' as const, label: 'Deployments', icon: Package },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: 'easeOut' }} className="space-y-0">
      <div className="flex items-center gap-4 mb-6">
        <div className="flex-grow">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
            <span className="text-xs px-2 py-0.5 rounded-full border font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30">ACTIVE</span>
          </div>
          <p className="text-xs text-muted-foreground font-mono mt-0.5">{project.bundleId}</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 border border-border rounded-lg hover:bg-accent transition-colors">
            <Github size={14} />
            <span>Repository</span>
          </button>
          <button
            type="button"
            onClick={onDeleteProject}
            className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 border border-red-500/40 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-500/10 transition-colors"
          >
            <Trash2 size={14} />
            <span>Delete Project</span>
          </button>
          <button type="button" className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity">
            <Zap size={14} />
            <span>Trigger Build</span>
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border mb-6">
        {PROJECT_TABS.map((tab) => {
          const TabIcon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onProjectTabChange(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${projectTab === tab.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              <TabIcon size={15} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <AnimatePresence mode="wait">
        {projectTab === 'overview' && (
          <motion.div
            key="overview"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="space-y-6"
          >
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {OVERVIEW_STATS.map((stat) => {
                const StatIcon = stat.icon;
                return (
                  <div key={stat.id} className="bg-card border border-border rounded-xl p-4 shadow-sm">
                    <div className="flex items-center justify-between mb-3">
                      <div className={`p-2 rounded-lg ${stat.bg}`}>
                        <StatIcon size={15} className={stat.color} />
                      </div>
                    </div>
                    <p className="text-xl font-bold tracking-tight">{stat.value}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{stat.label}</p>
                    <p className="text-[10px] text-muted-foreground/70 mt-0.5">{stat.sub}</p>
                  </div>
                );
              })}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Active Plugins</h2>
                  <span className="text-[10px] font-bold bg-primary/10 text-primary px-2 py-0.5 rounded-full">{activePluginDetails.length}</span>
                </div>
                <div className="space-y-2">
                  {activePluginDetails.map((p) => (
                    <div key={p.id} className="bg-card border border-border rounded-xl p-3.5 flex items-center gap-3 shadow-sm">
                      <div className="p-2 rounded-lg bg-primary/5">
                        <Code2 size={14} className="text-primary" />
                      </div>
                      <div className="flex-grow min-w-0">
                        <p className="text-sm font-semibold truncate">{p.name}</p>
                        <p className="text-[10px] text-muted-foreground truncate">{p.provider}</p>
                      </div>
                      <div
                        className={`w-2 h-2 rounded-full shrink-0 ${p.health?.status === 'operational' ? 'bg-emerald-500' : p.health?.status === 'degraded' ? 'bg-amber-400' : 'bg-muted-foreground/40'}`}
                      />
                    </div>
                  ))}
                  {activePluginDetails.length === 0 && (
                    <div className="bg-muted/30 border border-dashed border-border rounded-xl p-6 text-center">
                      <p className="text-xs text-muted-foreground">No plugins active yet</p>
                      <p className="text-[10px] text-muted-foreground mt-1">Configure infrastructure to add plugins</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Recent Activity</h2>
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <RefreshCw size={10} className="animate-spin" />
                    <span>Live</span>
                  </span>
                </div>
                <div className="bg-slate-950 rounded-xl border border-slate-800 overflow-hidden">
                  <div className="flex items-center gap-1.5 px-3 py-2 border-b border-slate-800 bg-slate-900">
                    <span className="w-2 h-2 rounded-full bg-red-500/70" />
                    <span className="w-2 h-2 rounded-full bg-yellow-500/70" />
                    <span className="w-2 h-2 rounded-full bg-green-500/70" />
                    <span className="ml-1.5 text-[9px] font-mono text-slate-500">{project.bundleId}</span>
                  </div>
                  <div className="p-3 space-y-1 font-mono text-[10px] leading-relaxed max-h-52 overflow-y-auto">
                    {MOCK_LOGS.slice(-8).map((log) => (
                      <div key={log.id} className="flex gap-2 items-start">
                        <span className="text-slate-600 shrink-0">{log.timestamp}</span>
                        <span className={LOG_LEVEL_STYLES[log.level]}>{log.message}</span>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-slate-800 px-3 py-2 bg-slate-900 flex items-center gap-1.5">
                    <span className="text-emerald-400 font-mono text-[10px]">$</span>
                    <span className="text-slate-500 font-mono text-[10px] flex items-center gap-1">
                      <span>studio logs --follow</span>
                      <span className="w-1.5 h-3 bg-slate-400 animate-pulse ml-0.5" />
                    </span>
                  </div>
                </div>
                <div className="bg-slate-950 text-slate-300 rounded-xl p-3 flex items-center justify-between text-[10px] font-mono">
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span>MCP Active</span>
                  </span>
                  <span className="text-emerald-400">ws://localhost:3001/mcp</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {projectTab === 'providers' && (
          <motion.div
            key="providers"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="pb-8"
          >
            <ProjectProvidersTab
              projectName={project.name}
              bundleId={project.bundleId}
              connectedFirebase={connectedProviders.firebase}
              firebaseConnectionDetails={firebaseConnectionDetails}
              githubOrgConnected={connectedProviders.github}
              expoOrgConnected={connectedProviders.expo}
              githubProjectInitialized={githubProjectInitialized}
              expoProjectInitialized={expoProjectInitialized}
              integrationDependencyStatus={integrationDependencyStatus}
              onConnect={onProjectConnect}
              onOAuthStart={onProjectOAuthStart}
              onTriggerSetup={onProjectTriggerSetup}
              onDisconnect={onProjectDisconnect}
              onRefresh={onProjectProvidersRefresh}
            />
          </motion.div>
        )}

        {projectTab === 'infrastructure' && (
          <motion.div
            key="infrastructure"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="space-y-4"
          >
            <div className="flex items-center justify-between mb-2">
              <div>
                <h2 className="text-sm font-bold">Infrastructure Setup</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Select one plugin per category and configure project-level settings.</p>
              </div>
            </div>
            <InfrastructureTab projectPlugins={projectPlugins} />
          </motion.div>
        )}

        {projectTab === 'deployments' && (
          <motion.div
            key="deployments"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Build History</h2>
              <button type="button" className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity">
                <Zap size={13} />
                <span>Trigger Build</span>
              </button>
            </div>
            <div className="space-y-3">
              {allDeployments.map((dep) => {
                const cfg = DEPLOY_STATUS_CONFIG[dep.status] ?? DEPLOY_STATUS_CONFIG.queued;
                return (
                  <div key={dep.id} className="bg-card border border-border rounded-xl p-5 shadow-sm flex items-center gap-5">
                    <div className="shrink-0">
                      {dep.status === 'running' && <Loader2 size={20} className="text-blue-500 animate-spin" />}
                      {dep.status === 'success' && <CheckCircle2 size={20} className="text-emerald-500" />}
                      {dep.status === 'failed' && <AlertCircle size={20} className="text-red-500" />}
                      {dep.status === 'queued' && <Circle size={20} className="text-muted-foreground" />}
                    </div>
                    <div className="flex-grow min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-bold text-sm">v{dep.version}</span>
                        <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{dep.commit}</span>
                        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <GitBranch size={10} />
                          <span>{dep.branch}</span>
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <span>Triggered by {dep.triggeredBy}</span>
                        <span className="mx-1.5">·</span>
                        <span>{formatDate(dep.createdAt)}</span>
                        {dep.duration && (
                          <>
                            <span className="mx-1.5">·</span>
                            <span>{dep.duration}</span>
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-[10px] uppercase font-bold text-muted-foreground">{dep.platform}</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>
                      <button type="button" className="p-1.5 hover:bg-accent rounded transition-colors text-muted-foreground">
                        <ExternalLink size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function PlatformStudio() {
  const [isDark, setIsDark] = useState(false);
  const [view, setView] = useState<StudioView>('overview');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectDetail, setProjectDetail] = useState<ProjectDetail | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [wsStatus, setWsStatus] = useState<'offline' | 'connecting' | 'live' | 'error'>('offline');
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [createForm, setCreateForm] = useState({
    name: '',
    slug: '',
    bundleId: 'com.example',
    description: '',
    githubOrg: '',
    easAccount: '',
  });
  const [connections, setConnections] = useState<Map<string, WebSocket>>(new Map());
  const [connectedProviders, setConnectedProviders] = useState<ConnectedProviders>({
    firebase: false,
    expo: false,
    github: false,
  });
  const [activeIntegration, setActiveIntegration] = useState<ProviderId | null>(null);
  const [firebaseDetails, setFirebaseDetails] = useState<FirebaseConnectionDetails | null>(null);
  const [githubProjectInitialized, setGithubProjectInitialized] = useState(false);
  const [expoProjectInitialized, setExpoProjectInitialized] = useState(false);
  const [integrationDependencyStatus, setIntegrationDependencyStatus] = useState<
    Record<string, IntegrationDependencyProviderStatus>
  >({});

  const isConfiguredIntegration = (entry: unknown): boolean => {
    if (!entry || typeof entry !== 'object') return false;
    const status = (entry as IntegrationStatusRecord).status;
    return status === 'configured';
  };
  const hasConfiguredIntegration = (
    integrations: Record<string, unknown> | Record<string, IntegrationStatusRecord> | undefined,
    keys: string[],
  ): boolean => {
    if (!integrations) return false;
    return keys.some((key) => isConfiguredIntegration(integrations[key]));
  };
  const refreshConnectedProviders = async (): Promise<void> => {
    const organization = await api<OrganizationProfile>('/api/organization');
    const projectIntegrations =
      projectDetail?.integrations ??
      (activeProjectId
        ? (await api<ProjectDetail>(`/api/projects/${encodeURIComponent(activeProjectId)}`)).integrations
        : undefined);

    let firebaseConnected = false;

    if (activeProjectId) {
      try {
        const fbStatus = await api<{
          connected: boolean;
          details?: {
            projectId?: string;
            serviceAccountEmail?: string;
            userEmail?: string;
          };
          integration?: { config?: Record<string, string> };
        }>(`/api/projects/${encodeURIComponent(activeProjectId)}/integrations/firebase/connection`);
        if (fbStatus.connected) {
          firebaseConnected = true;
          setFirebaseDetails(
            fbStatus.details
              ? {
                  project_id: fbStatus.details.projectId,
                  service_account_email: fbStatus.details.serviceAccountEmail,
                  connected_by: fbStatus.details.userEmail,
                }
              : fbStatus.integration?.config
                ? {
                    project_id: fbStatus.integration.config['gcp_project_id'],
                    service_account_email: fbStatus.integration.config['service_account_email'],
                    connected_by: fbStatus.integration.config['connected_by'],
                  }
                : null,
          );
        } else {
          setFirebaseDetails(null);
        }
      } catch {
        setFirebaseDetails(null);
      }
    }

    setConnectedProviders({
      firebase: firebaseConnected,
      expo:
        hasConfiguredIntegration(organization.integrations, ['eas', 'expo']) ||
        hasConfiguredIntegration(projectIntegrations, ['eas', 'expo']),
      github:
        hasConfiguredIntegration(organization.integrations, ['github']) ||
        hasConfiguredIntegration(projectIntegrations, ['github']),
    });
  };
  const refreshIntegrationDependencyStatus = async (): Promise<void> => {
    if (!activeProjectId) {
      setIntegrationDependencyStatus({});
      return;
    }
    const payload = await api<{
      providers: IntegrationDependencyProviderStatus[];
    }>(`/api/projects/${encodeURIComponent(activeProjectId)}/integrations/dependencies`);
    const byProvider = Object.fromEntries(
      payload.providers.map((provider) => [provider.provider, provider]),
    );
    setIntegrationDependencyStatus(byProvider);
  };
  const handleConnect = async (providerId: ProviderId, fields: Record<string, string>): Promise<void> => {
    if (providerId === 'expo') {
      const token = fields['expoRobotToken']?.trim();
      if (!token) {
        throw new Error('Expo Robot Token is required.');
      }
      await api('/api/organization/integrations/eas/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      await refreshConnectedProviders();
      notify('Expo integration connected', 'ok');
      return;
    }
    if (providerId === 'github') {
      const token = fields['githubPat']?.trim();
      if (!token) {
        throw new Error('GitHub Personal Access Token is required.');
      }
      await api('/api/organization/integrations/github/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      await refreshConnectedProviders();
      notify('GitHub integration connected', 'ok');
      return;
    }
    if (providerId === 'firebase') {
      if (!activeProjectId) {
        throw new Error('Select a project first to configure Firebase.');
      }
      const saJson = fields['gcpServiceAccount']?.trim();
      if (!saJson) {
        throw new Error('Service Account JSON is required.');
      }
      await api(`/api/projects/${encodeURIComponent(activeProjectId)}/integrations/firebase/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceAccountJson: saJson }),
      });
      await refreshConnectedProviders();
      notify('Firebase integration connected via SA key', 'ok');
      return;
    }
    throw new Error(`${providerId} connect flow is not implemented yet.`);
  };

  const handleOAuthStart = async (
    providerId: ProviderId,
    onProgress: (progress: GcpOAuthSessionStatus) => void,
  ): Promise<void> => {
    if (providerId !== 'firebase') {
      throw new Error(`OAuth is not supported for ${providerId}.`);
    }
    if (!activeProjectId) {
      throw new Error('Select a project first to configure Firebase.');
    }

    const session = await api<{
      sessionId: string;
      authUrl: string;
      state: string;
      phase: 'awaiting_user';
      steps: GcpOAuthStepStatus[];
    }>(
      `/api/projects/${encodeURIComponent(activeProjectId)}/integrations/firebase/connect/oauth/start`,
      { method: 'POST' },
    );

    onProgress({
      sessionId: session.sessionId,
      phase: session.phase,
      connected: false,
      steps: session.steps,
    });

    window.open(session.authUrl, '_blank', 'noopener,noreferrer');

    const maxAttempts = 300;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const status = await api<GcpOAuthSessionStatus>(
        `/api/projects/${encodeURIComponent(activeProjectId)}/integrations/firebase/connect/oauth/${encodeURIComponent(session.sessionId)}`,
      );
      onProgress(status);
      if (status.phase === 'completed' && status.connected) {
        await refreshConnectedProviders();
        notify('Firebase connected via Google OAuth', 'ok');
        return;
      }
      if (status.phase === 'failed' || status.phase === 'expired') {
        throw new Error(status.error ?? 'GCP OAuth session failed.');
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    throw new Error('Timed out waiting for GCP OAuth provisioning to complete.');
  };
  const handleDisconnect = async (providerId: ProviderId): Promise<void> => {
    if (providerId === 'expo') {
      await api('/api/organization/integrations/eas/connection', {
        method: 'DELETE',
      });
      await refreshConnectedProviders();
      notify('Expo integration disconnected', 'ok');
      return;
    }
    if (providerId === 'github') {
      await api('/api/organization/integrations/github/connection', {
        method: 'DELETE',
      });
      await refreshConnectedProviders();
      notify('GitHub integration disconnected', 'ok');
      return;
    }
    if (providerId === 'firebase') {
      if (!activeProjectId) {
        throw new Error('Select a project first to disconnect Firebase.');
      }
      await api(`/api/projects/${encodeURIComponent(activeProjectId)}/integrations/firebase/connection`, {
        method: 'DELETE',
      });
      setFirebaseDetails(null);
      await refreshConnectedProviders();
      notify('Firebase/GCP integration disconnected', 'ok');
      return;
    }
    throw new Error(`${providerId} disconnect flow is not implemented yet.`);
  };
  const handleTriggerSetup = async (providerId: ProviderId): Promise<void> => {
    if (providerId === 'github') {
      // Backend endpoint: POST /api/projects/:id/integrations/github/init
      // When the endpoint exists, uncomment:
      // await api(`/api/projects/${encodeURIComponent(activeProjectId!)}/integrations/github/init`, { method: 'POST' });
      setGithubProjectInitialized(true);
      notify('GitHub repository initialized for project', 'ok');
      return;
    }
    if (providerId === 'expo') {
      // Backend endpoint: POST /api/projects/:id/integrations/expo/init
      // await api(`/api/projects/${encodeURIComponent(activeProjectId!)}/integrations/expo/init`, { method: 'POST' });
      setExpoProjectInitialized(true);
      notify('EAS application registered for project', 'ok');
      return;
    }
  };
  const isPluginConnected = (plugin: RegistryPlugin): boolean => {
    if (plugin.providerId === 'studio') return true;
    if (plugin.providerId === 'firebase') return connectedProviders.firebase;
    if (plugin.providerId === 'expo') return connectedProviders.expo;
    if (plugin.providerId === 'github') return connectedProviders.github;
    return false;
  };
  const getProviderConfig = (plugin: RegistryPlugin): IntegrationConfig | null => {
    if (plugin.providerId === 'firebase' || plugin.providerId === 'expo' || plugin.providerId === 'github') {
      return INTEGRATION_CONFIGS.find((c) => c.id === plugin.providerId) ?? null;
    }
    return null;
  };
  const activeIntegrationConfig = activeIntegration ? INTEGRATION_CONFIGS.find((c) => c.id === activeIntegration) ?? null : null;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  useEffect(() => {
    const timer = setInterval(() => {
      api<{ websocket_connections: number }>('/api/health')
        .then((health) => {
          if (connections.size === 0) {
            setWsStatus(health.websocket_connections > 0 ? 'live' : 'offline');
          }
        })
        .catch(() => setWsStatus('error'));
    }, 20000);
    return () => clearInterval(timer);
  }, [connections.size]);

  useEffect(() => {
    void refreshProjects();
    // refreshProjects is intentionally invoked on initial mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refreshConnectedProviders().catch((error: Error) => notify(error.message, 'error'));
    void refreshIntegrationDependencyStatus().catch((error: Error) => notify(error.message, 'error'));
    // refreshConnectedProviders should re-run only when selected project context changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, projectDetail]);

  useEffect(() => {
    if (projectDetail) syncRunSockets(projectDetail);
  }, [projectDetail]);

  function notify(text: string, tone: 'ok' | 'error' = 'ok'): void {
    setToast({ text, tone });
    setTimeout(() => setToast(null), 2800);
  }

  async function refreshProjects(): Promise<void> {
    const payload = await api<{ projects: ProjectSummary[] }>('/api/projects');
    setProjects(payload.projects);
    if (!activeProjectId && payload.projects.length > 0) {
      setActiveProjectId(payload.projects[0].id);
      await refreshProjectDetail(payload.projects[0].id);
    }
    if (activeProjectId && !payload.projects.some((project) => project.id === activeProjectId)) {
      setActiveProjectId(null);
      setProjectDetail(null);
    }
  }

  async function refreshProjectDetail(projectId: string): Promise<void> {
    const detail = await api<ProjectDetail>(`/api/projects/${encodeURIComponent(projectId)}`);
    setProjectDetail(detail);
  }

  function syncRunSockets(detail: ProjectDetail): void {
    const runningIds = new Set(detail.provisioning.runs.filter((run) => run.status === 'running').map((run) => run.id));
    setConnections((prev) => {
      const next = new Map(prev);
      for (const [runId, ws] of next.entries()) {
        if (!runningIds.has(runId)) {
          ws.close();
          next.delete(runId);
        }
      }
      for (const runId of runningIds) {
        if (next.has(runId)) continue;
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${protocol}://${window.location.host}/ws/provisioning/${encodeURIComponent(runId)}`);
        setWsStatus('connecting');
        ws.onopen = () => setWsStatus('live');
        ws.onerror = () => setWsStatus('error');
        ws.onclose = () => {
          setConnections((old) => {
            const copy = new Map(old);
            copy.delete(runId);
            if (copy.size === 0) setWsStatus('offline');
            return copy;
          });
        };
        next.set(runId, ws);
      }
      return next;
    });
  }

  async function createProject(): Promise<void> {
    if (!createForm.name.trim()) throw new Error('Project name is required.');
    if (!createForm.slug.trim()) throw new Error('Project slug is required.');
    if (!createForm.bundleId.trim()) throw new Error('Bundle ID is required.');
    const payload = await api<{ project: { id: string } }>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: createForm.name.trim(),
        slug: createForm.slug.trim(),
        bundleId: createForm.bundleId.trim(),
        description: createForm.description.trim(),
        githubOrg: createForm.githubOrg.trim() || undefined,
        easAccount: createForm.easAccount.trim() || undefined,
        environments: DEFAULT_ENVIRONMENTS,
      }),
    });
    setShowCreate(false);
    setCreateForm({
      name: '',
      slug: '',
      bundleId: 'com.example',
      description: '',
      githubOrg: '',
      easAccount: '',
    });
    await refreshProjects();
    setActiveProjectId(payload.project.id);
    await refreshProjectDetail(payload.project.id);
    notify('Project created.');
  }

  async function deleteProject(): Promise<void> {
    if (!activeProjectId || !projectDetail) {
      throw new Error('Select a project first.');
    }
    const confirmed = window.confirm(
      `Delete project "${projectDetail.project.name}" (${projectDetail.project.id})?\n\nThis removes the Studio project record only. Infrastructure teardown is not included yet.`,
    );
    if (!confirmed) {
      return;
    }
    await api(`/api/projects/${encodeURIComponent(activeProjectId)}`, {
      method: 'DELETE',
    });
    setConnections((prev) => {
      const next = new Map(prev);
      for (const run of projectDetail.provisioning.runs) {
        const ws = next.get(run.id);
        if (ws) {
          ws.close();
          next.delete(run.id);
        }
      }
      if (next.size === 0) {
        setWsStatus('offline');
      }
      return next;
    });
    setActiveIntegration(null);
    setFirebaseDetails(null);
    setProjectDetail(null);
    setActiveProjectId(null);
    setView('overview');
    await refreshProjects();
    notify('Project deleted. Infrastructure teardown skipped.', 'ok');
  }

  const moduleCount = useMemo(() => Object.keys(projectDetail?.integrations || {}).length, [projectDetail]);
  const wsTone = wsStatus === 'live' ? 'bg-emerald-500' : wsStatus === 'connecting' ? 'bg-amber-400' : wsStatus === 'error' ? 'bg-red-500' : 'bg-slate-400';

  return (
    <div className={`flex h-screen w-screen overflow-hidden ${isDark ? 'dark' : ''}`}>
      <div className="flex h-full w-full bg-background text-foreground overflow-hidden">
        <aside className="w-72 border-r border-border bg-card flex flex-col shrink-0 overflow-hidden">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded bg-primary text-primary-foreground flex items-center justify-center">
                <Cpu size={16} />
              </div>
              <div className="overflow-hidden">
                <p className="text-sm font-bold leading-tight">Studio Core</p>
                <p className="text-[10px] text-muted-foreground">Magicpath UI</p>
              </div>
            </div>
            <button type="button" onClick={() => setShowCreate(true)} className="rounded-md px-2 py-1 text-xs bg-primary text-primary-foreground flex items-center gap-1 shrink-0">
              <Plus size={12} /> New
            </button>
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            <div className="px-3 pt-3 pb-2 flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Projects</p>
              <span className="text-[10px] text-muted-foreground">{projects.length}</span>
            </div>
            <div className="px-3 pb-3 flex-1 overflow-y-auto space-y-2">
              {projects.length === 0 ? (
                <div className="text-xs text-muted-foreground px-2 py-3">No projects yet.</div>
              ) : (
                projects.map((project) => (
                  <button
                    type="button"
                    key={project.id}
                    className={`w-full text-left rounded-lg border p-3 transition ${
                      project.id === activeProjectId
                        ? 'border-primary bg-primary/10 shadow-sm'
                        : 'border-border hover:border-primary/50 hover:bg-muted/40'
                    }`}
                    onClick={() => {
                      setActiveProjectId(project.id);
                      setView('project');
                      void refreshProjectDetail(project.id);
                    }}
                  >
                    <p className="text-sm font-semibold truncate">{project.name}</p>
                    <p className="text-[10px] text-muted-foreground mt-1 font-mono truncate">{project.bundleId}</p>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {project.integration_progress.configured}/{project.integration_progress.total} configured
                    </p>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="p-3 border-t border-border space-y-1">
            <button type="button" className={`w-full text-left rounded-lg px-3 py-2 text-sm flex items-center ${view === 'overview' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`} onClick={() => setView('overview')}>
              <Activity size={14} className="mr-2 shrink-0" />
              Overview
            </button>
            <button type="button" className={`w-full text-left rounded-lg px-3 py-2 text-sm flex items-center ${view === 'registry' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`} onClick={() => setView('registry')}>
              <Layers size={14} className="mr-2 shrink-0" />
              Registry
            </button>
          </div>

          <div className="p-3 border-t border-border">
            <div className="flex items-center gap-3 bg-muted/40 rounded-lg p-2.5">
              <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center shrink-0">
                <User size={14} />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold truncate">Studio Operator</p>
                <p className="text-[10px] text-muted-foreground">Admin Access</p>
              </div>
            </div>
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto bg-muted/20">
          <header className="sticky top-0 z-10 bg-background/90 backdrop-blur border-b border-border px-6 py-4 flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold tracking-tight">
                {view === 'registry' ? 'Plugin Registry' : view === 'overview' ? 'Organization' : projectDetail?.project.name || 'Studio Core'}
              </h1>
              <p className="text-xs text-muted-foreground">
                {view === 'registry'
                  ? `${ALL_REGISTRY_PLUGINS.length} plugins across ${REGISTRY_CATEGORIES.length} categories`
                  : view === 'overview'
                    ? 'Manage projects and infrastructure across the organization'
                    : projectDetail
                      ? `${projectDetail.project.slug} · updated ${formatDate(projectDetail.project.updatedAt)}`
                      : 'Select a project to continue'}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button type="button" className="p-2 rounded-lg border border-border hover:bg-muted" onClick={() => setIsDark((value) => !value)}>
                {isDark ? <Sun size={16} /> : <Moon size={16} />}
              </button>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className={`w-2 h-2 rounded-full ${wsTone}`} />
                {wsStatus}
              </div>
            </div>
          </header>

          <div className="p-6 space-y-4">
            {view === 'overview' && (
              <OrgOverview
                projects={projects}
                onSelectProject={(id) => {
                  setActiveProjectId(id);
                  setView('project');
                  void refreshProjectDetail(id);
                }}
                connectedProviders={connectedProviders}
                onOpenIntegration={setActiveIntegration}
                wsStatus={wsStatus}
                totalModulesConfigured={projects.reduce((acc, p) => acc + p.integration_progress.configured, 0)}
              />
            )}

            {(view === 'project' || view === 'project-providers' || view === 'infrastructure' || view === 'runs') && projectDetail && (
              <ProjectDetailView
                projectDetail={projectDetail}
                projectTab={
                  view === 'infrastructure'
                    ? 'infrastructure'
                    : view === 'runs'
                      ? 'deployments'
                      : view === 'project-providers'
                        ? 'providers'
                        : 'overview'
                }
                onProjectTabChange={(tab) => {
                  if (tab === 'overview') setView('project');
                  else if (tab === 'providers') setView('project-providers');
                  else if (tab === 'infrastructure') setView('infrastructure');
                  else setView('runs');
                }}
                connectedProviders={connectedProviders}
                firebaseConnectionDetails={firebaseDetails}
                githubProjectInitialized={githubProjectInitialized}
                expoProjectInitialized={expoProjectInitialized}
                onProjectConnect={handleConnect}
                onProjectOAuthStart={handleOAuthStart}
                onProjectTriggerSetup={handleTriggerSetup}
                onProjectDisconnect={handleDisconnect}
                integrationDependencyStatus={integrationDependencyStatus}
                onProjectProvidersRefresh={async () => {
                  await refreshConnectedProviders();
                  await refreshIntegrationDependencyStatus();
                }}
                onDeleteProject={() => {
                  void deleteProject().catch((error: Error) => notify(error.message, 'error'));
                }}
                projectPlugins={(() => {
                  const int = projectDetail.integrations || {};
                  const keys = Object.keys(int);
                  const pluginIds: string[] = [];
                  for (const k of keys) {
                    if (k === 'firebase') pluginIds.push(...PROVIDER_PLUGIN_MAP.firebase);
                    else if (k === 'expo') pluginIds.push(...PROVIDER_PLUGIN_MAP.expo);
                    else if (k === 'github') pluginIds.push(...PROVIDER_PLUGIN_MAP.github);
                    else pluginIds.push(k);
                  }
                  return pluginIds;
                })()}
              />
            )}

            {view === 'registry' && (
              <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8">
                <div className="flex items-end justify-between">
                  <div>
                    <h1 className="text-3xl font-bold tracking-tight">Plugin Registry</h1>
                    <p className="text-muted-foreground mt-1">
                      {ALL_REGISTRY_PLUGINS.length} plugins across {REGISTRY_CATEGORIES.length} categories. Plugins may appear in multiple sections.
                    </p>
                  </div>
                </div>

                <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-3 flex-wrap">
                  <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mr-1">Integrations</p>
                  {INTEGRATION_CONFIGS.map((cfg) => {
                    const connected = connectedProviders[cfg.id];
                    const available = cfg.scope === 'project' && !activeProjectId;
                    const CfgIcon = cfg.logo;
                    const pluginCount = PROVIDER_PLUGIN_MAP[cfg.id]?.length ?? 0;
                    return (
                      <button
                        key={cfg.id}
                        type="button"
                        onClick={() => setActiveIntegration(cfg.id)}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all hover:shadow-sm ${
                          connected
                            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/15'
                            : available
                              ? 'bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400 hover:bg-blue-500/15'
                              : 'bg-muted/50 border-dashed border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
                        }`}
                      >
                        <CfgIcon
                          size={13}
                          className={
                            connected
                              ? 'text-emerald-500'
                              : available
                                ? 'text-blue-500'
                                : 'text-muted-foreground'
                          }
                        />
                        <span>{cfg.name}</span>
                        {connected ? (
                          <CheckCircle2 size={12} className="text-emerald-500" />
                        ) : available ? (
                          <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 border border-blue-500/30 px-1.5 py-0.5 rounded-full">
                            AVAILABLE
                          </span>
                        ) : (
                          <span className="text-[10px] font-bold text-muted-foreground bg-muted px-1 py-0.5 rounded">
                            {pluginCount} plugins
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                <div className="space-y-10">
                  {REGISTRY_CATEGORIES.map((category) => {
                    const CategoryIcon = category.icon;
                    const plugins = ALL_REGISTRY_PLUGINS.filter((p) => category.pluginIds.includes(p.id));
                    return (
                      <section key={category.id}>
                        <div className="flex items-center gap-3 mb-4">
                          <div className={`p-2 rounded-lg bg-muted ${category.color}`}>
                            <CategoryIcon size={16} />
                          </div>
                          <h2 className="text-base font-bold tracking-tight">{category.label}</h2>
                          <span className="text-[10px] font-bold text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{plugins.length} plugins</span>
                          <div className="flex-grow h-px bg-border ml-2" />
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                          {plugins.map((plugin) => {
                            const connected = isPluginConnected(plugin);
                            const providerConfig = getProviderConfig(plugin);
                            const projectScopedAvailable =
                              providerConfig?.scope === 'project' &&
                              !activeProjectId;
                            const crossCategories = plugin.categories.filter((c) => c !== category.id);
                            const isStudio = plugin.providerId === 'studio';
                            return (
                              <div
                                key={`${category.id}-${plugin.id}`}
                                className={`relative bg-card rounded-xl p-5 flex flex-col transition-all ${
                                  plugin.future
                                    ? 'border border-border opacity-60'
                                    : connected
                                      ? 'border-2 border-emerald-500/50 shadow-sm hover:shadow-md'
                                      : projectScopedAvailable
                                        ? 'border border-blue-500/30 shadow-sm hover:shadow-md'
                                        : 'border border-dashed border-border hover:border-primary/40 hover:shadow-sm'
                                }`}
                              >
                                {connected && !plugin.future && <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-t-xl" />}
                                <div className="flex items-start justify-between mb-3">
                                  <div className={`p-2 rounded-lg ${connected && !plugin.future ? 'bg-emerald-500/10' : 'bg-accent'}`}>
                                    <Code2 size={18} className={connected && !plugin.future ? 'text-emerald-500' : 'text-primary'} />
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    {plugin.future && <span className="text-[9px] font-bold bg-muted text-muted-foreground px-1.5 py-0.5 rounded border border-border">SOON</span>}
                                    {!plugin.future && connected && (
                                      <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.5 rounded-full">
                                        <CheckCircle2 size={9} />
                                        <span>CONNECTED</span>
                                      </span>
                                    )}
                                    {!plugin.future && !connected && !isStudio && (
                                      projectScopedAvailable ? (
                                        <span className="text-[9px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 border border-blue-500/30 px-1.5 py-0.5 rounded-full">
                                          AVAILABLE
                                        </span>
                                      ) : (
                                        <span className="text-[9px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded-full">
                                          NOT CONNECTED
                                        </span>
                                      )
                                    )}
                                    <span className="text-[10px] font-mono text-muted-foreground">v{plugin.version}</span>
                                  </div>
                                </div>
                                <h3 className="font-bold text-sm mb-0.5">{plugin.name}</h3>
                                <p className="text-[11px] text-muted-foreground font-medium mb-2">{plugin.provider}</p>
                                <p className="text-xs text-muted-foreground leading-relaxed flex-grow mb-4">{plugin.description}</p>
                                {crossCategories.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mb-3">
                                    {crossCategories.map((catId) => (
                                      <span key={catId} className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${CATEGORY_PILL_STYLE[catId] ?? 'bg-muted text-muted-foreground border-border'}`}>
                                        <span>Also: </span>
                                        <span>{CATEGORY_LABEL_MAP[catId] ?? catId}</span>
                                      </span>
                                    ))}
                                  </div>
                                )}
                                {plugin.future ? (
                                  <button type="button" disabled className="w-full py-2 text-xs font-bold border border-border rounded-lg text-muted-foreground cursor-not-allowed opacity-60">
                                    Coming Soon
                                  </button>
                                ) : connected ? (
                                  <button
                                    type="button"
                                    onClick={() => providerConfig && setActiveIntegration(providerConfig.id)}
                                    className="w-full py-2 text-xs font-bold border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 rounded-lg hover:bg-emerald-500/10 transition-colors flex items-center justify-center gap-1.5"
                                  >
                                    <CheckCircle2 size={12} />
                                    <span>{isStudio ? 'View Plugin Contract' : 'View Integration'}</span>
                                  </button>
                                ) : providerConfig ? (
                                  <button
                                    type="button"
                                    onClick={() => setActiveIntegration(providerConfig.id)}
                                    className={`w-full py-2 text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
                                      projectScopedAvailable
                                        ? 'border border-blue-500/30 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10'
                                        : 'border border-dashed border-primary/40 text-primary hover:bg-primary/5'
                                    }`}
                                  >
                                    <Link2 size={12} />
                                    <span>
                                      {projectScopedAvailable
                                        ? `Configure ${providerConfig!.name}`
                                        : `Connect ${providerConfig!.name}`}
                                    </span>
                                    <ArrowRight size={11} />
                                  </button>
                                ) : (
                                  <button type="button" className="w-full py-2 text-xs font-bold border border-border rounded-lg hover:bg-accent transition-colors">
                                    View Plugin Contract
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
              </div>
            )}

          </div>
        </main>

        {showCreate && (
          <div className="fixed inset-0 z-50 bg-black/55 flex items-center justify-center p-4" onClick={() => setShowCreate(false)}>
            <div className="w-full max-w-2xl rounded-2xl border border-border bg-background shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                <h2 className="font-semibold text-lg">Create Project Module</h2>
                <button type="button" className="p-2 rounded-lg hover:bg-muted" onClick={() => setShowCreate(false)}>
                  <X size={16} />
                </button>
              </div>
              <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="text-sm text-muted-foreground">Name (required)
                  <input
                    className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm"
                    value={createForm.name}
                    onChange={(event) => {
                      const name = event.target.value;
                      const nextSlug = slugify(name);
                      setCreateForm((prev) => ({
                        ...prev,
                        name,
                        slug: prev.slug ? prev.slug : nextSlug,
                        bundleId: prev.bundleId !== 'com.example' ? prev.bundleId : bundleFromSlug(nextSlug),
                      }));
                    }}
                    placeholder="Payments App"
                  />
                </label>
                <label className="text-sm text-muted-foreground">Slug (required)
                  <input
                    className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm"
                    value={createForm.slug}
                    onChange={(event) => {
                      const slug = slugify(event.target.value);
                      setCreateForm((prev) => ({
                        ...prev,
                        slug,
                        bundleId: bundleFromSlug(slug),
                      }));
                    }}
                    placeholder="payments-app"
                  />
                </label>
                <label className="text-sm text-muted-foreground">Bundle ID (required)
                  <input
                    className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm"
                    value={createForm.bundleId}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, bundleId: event.target.value.trim().toLowerCase() }))}
                    placeholder="com.example.payments-app"
                  />
                </label>
                <label className="text-sm text-muted-foreground">Description
                  <input className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm" value={createForm.description} onChange={(event) => setCreateForm((prev) => ({ ...prev, description: event.target.value }))} placeholder="High-level context" />
                </label>
                <label className="text-sm text-muted-foreground">GitHub Org
                  <input className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm" value={createForm.githubOrg} onChange={(event) => setCreateForm((prev) => ({ ...prev, githubOrg: event.target.value }))} placeholder="my-org" />
                </label>
                <label className="text-sm text-muted-foreground">EAS Account
                  <input className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm" value={createForm.easAccount} onChange={(event) => setCreateForm((prev) => ({ ...prev, easAccount: event.target.value }))} placeholder="my-eas-account" />
                </label>
              </div>
              <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
                <button type="button" className="rounded-lg border border-border px-3 py-2 text-sm" onClick={() => setShowCreate(false)}>Cancel</button>
                <button type="button" className="rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm" onClick={() => void createProject().catch((error: Error) => notify(error.message, 'error'))}>Create Project</button>
              </div>
            </div>
          </div>
        )}

        {toast && (
          <div className={`fixed right-4 bottom-4 z-50 rounded-lg px-3 py-2 text-sm text-white ${toast.tone === 'error' ? 'bg-red-600' : 'bg-slate-900'}`}>
            {toast.text}
          </div>
        )}

        <AnimatePresence>
          {activeIntegration && activeIntegrationConfig && activeIntegration !== 'firebase' && (
            <IntegrationModal
              key={activeIntegration}
              config={activeIntegrationConfig}
              isConnected={connectedProviders[activeIntegration]}
              connectionDetails={null}
              dependencyStatus={integrationDependencyStatus[providerToBackendKey(activeIntegration)]}
              onClose={() => setActiveIntegration(null)}
              onConnect={async (providerId, fields) => {
                await handleConnect(providerId, fields);
              }}
              onOAuthStart={async (providerId, onProgress) => {
                await handleOAuthStart(providerId, onProgress);
              }}
              onDisconnect={async (providerId) => {
                await handleDisconnect(providerId);
              }}
            />
          )}
        </AnimatePresence>

      </div>
    </div>
  );
}