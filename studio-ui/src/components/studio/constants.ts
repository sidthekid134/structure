import {
  Cloud,
  Globe,
  Github,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import type {
  IntegrationConfig,
  ProjectSetupConfig,
  ProviderId,
} from './types';

/** @deprecated Import DEFAULT_ENVIRONMENTS from CreateProjectModal instead */
export const DEFAULT_ENVIRONMENTS = ['preview', 'production'];
export const SLUG_MAX = 25;

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
