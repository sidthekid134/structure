import React, { useState, useEffect, useRef } from 'react';
import { LayoutDashboard, Plus, Settings, Cpu, Zap, Github, Layers, Terminal, ChevronRight, Search, Bell, User, CheckCircle2, Clock, AlertCircle, ExternalLink, Loader2, Database, ShieldCheck, Smartphone, Sparkles, Code2, Lock, Activity, Package, GitBranch, RefreshCw, Circle, Server, Bell as BellIcon, KeyRound, HardDrive, Wrench, X, Eye, EyeOff, Link2, Unlink, ArrowRight, Info, PanelLeftClose, PanelLeftOpen, Play, RotateCcw, CheckCheck, AlertTriangle, TrendingUp, Globe, Sun, Moon, MonitorSmartphone } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// --- Types ---

type ProjectStatus = 'provisioning' | 'active' | 'error' | 'pending-manual';
type ProjectTab = 'overview' | 'infrastructure' | 'deployments';
type ProviderId = 'firebase' | 'expo' | 'github';
type SetupTaskStatus = 'idle' | 'running' | 'completed' | 'error' | 'manual-required';
type AppType = 'mobile' | 'web' | 'backend';
interface Project {
  id: string;
  name: string;
  bundleId: string;
  status: ProjectStatus;
  updatedAt: string;
  plugins: string[];
}
interface Step {
  id: string;
  title: string;
  status: 'pending' | 'loading' | 'completed' | 'error';
  description?: string;
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
interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'warn' | 'error' | 'debug';
  message: string;
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
  name: string;
  logo: React.ElementType;
  logoColor: string;
  description: string;
  docsUrl: string;
  fields: IntegrationField[];
}
interface ConnectedProviders {
  firebase: boolean;
  expo: boolean;
  github: boolean;
}
interface InfraPluginCategory {
  id: string;
  label: string;
  icon: React.ElementType;
  color: string;
  description: string;
  plugins: InfraPlugin[];
}
interface InfraPlugin {
  id: string;
  name: string;
  provider: string;
  description: string;
  configFields: InfraConfigField[];
  setupTasks: SetupTask[];
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
interface ProjectPluginState {
  categoryId: string;
  selectedPluginId: string | null;
  configValues: Record<string, string>;
  setupStatus: SetupTaskStatus;
  taskStates: Record<string, SetupTaskStatus>;
  completedAt?: string;
}
interface AppTypeOption {
  id: AppType;
  label: string;
  description: string;
  icon: React.ElementType;
  available: boolean;
}

// --- Static Data ---

const INTEGRATION_CONFIGS: IntegrationConfig[] = [{
  id: 'firebase',
  name: 'Google Firebase',
  logo: Cpu,
  logoColor: 'text-orange-500',
  description: 'Connect your GCP service account to provision Firebase Auth, Firestore, FCM, Vertex AI, and App Check automatically.',
  docsUrl: 'https://firebase.google.com/docs/projects/api/workflow_set-up-and-manage-project',
  fields: [{
    key: 'gcpServiceAccount',
    label: 'GCP Service Account JSON',
    placeholder: '{\n  "type": "service_account",\n  "project_id": "my-project",\n  "private_key_id": "...",\n  ...\n}',
    hint: 'Create a service account with Editor or Owner role in Google Cloud Console → IAM & Admin → Service Accounts.',
    type: 'textarea'
  }, {
    key: 'gcpProjectId',
    label: 'GCP Project ID',
    placeholder: 'my-gcp-project-id',
    hint: 'Found in Google Cloud Console → Project Dashboard.',
    type: 'text'
  }]
}, {
  id: 'expo',
  name: 'Expo / EAS',
  logo: Zap,
  logoColor: 'text-indigo-500',
  description: 'Connect your Expo Robot token to enable EAS Build and EAS Submit for automated iOS and Android binary delivery.',
  docsUrl: 'https://docs.expo.dev/accounts/programmatic-access/',
  fields: [{
    key: 'expoRobotToken',
    label: 'Expo Robot Token',
    placeholder: 'expo_robot_XXXXXXXXXXXXXXXXXXXXXXXX',
    hint: 'Generate a Robot token in Expo.dev → Account → Access Tokens. Use a Robot account for CI/CD, not your personal token.',
    type: 'password'
  }, {
    key: 'expoAccountSlug',
    label: 'Expo Account / Org Slug',
    placeholder: 'my-org',
    hint: 'Your Expo username or organization slug as shown in expo.dev URLs.',
    type: 'text'
  }]
}, {
  id: 'github',
  name: 'GitHub',
  logo: Github,
  logoColor: 'text-slate-800',
  description: 'Connect a GitHub Personal Access Token to create repositories, configure branch protection, and trigger GitHub Actions workflows.',
  docsUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
  fields: [{
    key: 'githubPat',
    label: 'Personal Access Token (classic)',
    placeholder: 'ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    hint: 'Create a token at GitHub → Settings → Developer Settings → PATs. Required scopes: repo, workflow, admin:org.',
    type: 'password'
  }, {
    key: 'githubOrg',
    label: 'GitHub Organization or Username',
    placeholder: 'acme-corp',
    hint: 'The GitHub org or personal username where repositories will be created.',
    type: 'text'
  }]
}];
const PROVIDER_PLUGIN_MAP: Record<ProviderId, string[]> = {
  firebase: ['firebase-auth', 'firestore', 'fcm', 'app-check', 'vertex-ai'],
  expo: ['eas-build', 'eas-submit'],
  github: ['github-actions']
};
const INFRA_CATEGORIES: InfraPluginCategory[] = [{
  id: 'auth',
  label: 'Authentication',
  icon: KeyRound,
  color: 'text-violet-500',
  description: 'User identity and session management',
  plugins: [{
    id: 'firebase-auth',
    name: 'Firebase Auth',
    provider: 'Google Firebase',
    description: 'Apple, Google, and Email/Password auth with built-in session management and JWT tokens.',
    configFields: [{
      key: 'authProviders',
      label: 'Enabled Providers',
      placeholder: 'apple,google,email',
      type: 'text'
    }, {
      key: 'sessionExpiry',
      label: 'Session Expiry',
      placeholder: '7d',
      type: 'select',
      options: ['1d', '7d', '30d', '90d']
    }],
    setupTasks: [{
      id: 'firebase-auth-1',
      title: 'Authenticate with GCP',
      description: 'Validate service account credentials and resolve project ID',
      duration: 1200
    }, {
      id: 'firebase-auth-2',
      title: 'Enable Firebase Auth API',
      description: 'Enable the Identity Toolkit API in the GCP project',
      duration: 1800
    }, {
      id: 'firebase-auth-3',
      title: 'Configure auth providers',
      description: 'Register Apple, Google, and Email sign-in methods',
      duration: 1400
    }, {
      id: 'firebase-auth-4',
      title: 'Deploy security rules',
      description: 'Write and publish Firebase Auth security policy',
      duration: 900
    }]
  }, {
    id: 'mock-auth',
    name: 'Mock Auth',
    provider: 'Studio Core',
    description: 'Local development authentication mock with configurable user fixtures for offline-first development.',
    configFields: [{
      key: 'mockUsers',
      label: 'Mock User Count',
      placeholder: '3',
      type: 'select',
      options: ['1', '3', '5', '10']
    }],
    setupTasks: [{
      id: 'mock-auth-1',
      title: 'Generate user fixtures',
      description: 'Create mock user profiles with configurable roles',
      duration: 600
    }, {
      id: 'mock-auth-2',
      title: 'Initialize token service',
      description: 'Set up local JWT signing for development tokens',
      duration: 400
    }]
  }]
}, {
  id: 'persistence',
  label: 'Persistence Store',
  icon: HardDrive,
  color: 'text-blue-500',
  description: 'Database and data storage layer',
  plugins: [{
    id: 'firestore',
    name: 'Cloud Firestore',
    provider: 'Google Firebase',
    description: 'Real-time NoSQL document database with offline sync, security rules, and automatic scaling.',
    configFields: [{
      key: 'region',
      label: 'Database Region',
      placeholder: 'us-central1',
      type: 'select',
      options: ['us-central1', 'us-east1', 'europe-west1', 'asia-east1']
    }, {
      key: 'mode',
      label: 'Database Mode',
      placeholder: 'native',
      type: 'select',
      options: ['native', 'datastore']
    }],
    setupTasks: [{
      id: 'firestore-1',
      title: 'Enable Firestore API',
      description: 'Activate Cloud Firestore in the GCP project',
      duration: 1600
    }, {
      id: 'firestore-2',
      title: 'Provision database instance',
      description: 'Create Firestore in native mode at selected region',
      duration: 3200
    }, {
      id: 'firestore-3',
      title: 'Deploy security rules',
      description: 'Publish default deny-all rules with auth-gated read/write',
      duration: 800
    }, {
      id: 'firestore-4',
      title: 'Create composite indexes',
      description: 'Set up required indexes for common query patterns',
      duration: 1100
    }]
  }, {
    id: 'mock-db',
    name: 'Mock DB',
    provider: 'Studio Core',
    description: 'Local in-memory store for offline-first development and unit testing with seed data.',
    configFields: [{
      key: 'seedData',
      label: 'Seed Data Preset',
      placeholder: 'minimal',
      type: 'select',
      options: ['minimal', 'standard', 'rich']
    }],
    setupTasks: [{
      id: 'mock-db-1',
      title: 'Initialize in-memory store',
      description: 'Bootstrap SQLite-backed local store',
      duration: 500
    }, {
      id: 'mock-db-2',
      title: 'Load seed data',
      description: 'Populate with preset fixture data',
      duration: 700
    }]
  }]
}, {
  id: 'notifications',
  label: 'Notifications',
  icon: BellIcon,
  color: 'text-pink-500',
  description: 'Push notification delivery',
  plugins: [{
    id: 'fcm',
    name: 'Firebase Cloud Messaging',
    provider: 'Google Firebase',
    description: 'Cross-platform push notifications with topic subscriptions, data payloads, and delivery analytics.',
    configFields: [{
      key: 'defaultTtl',
      label: 'Default Message TTL',
      placeholder: '86400',
      type: 'select',
      options: ['3600', '86400', '604800']
    }],
    setupTasks: [{
      id: 'fcm-1',
      title: 'Enable FCM API',
      description: 'Activate Firebase Cloud Messaging in project',
      duration: 900
    }, {
      id: 'fcm-2',
      title: 'Generate server key',
      description: 'Create FCM server credentials for backend use',
      duration: 700
    }, {
      id: 'fcm-3',
      title: 'Upload APNs key',
      description: 'Upload .p8 Apple Push Notification key for iOS delivery',
      duration: 500,
      manualRequired: true,
      manualLabel: 'Upload .p8 key from Apple Developer Portal → Certificates → Keys'
    }]
  }, {
    id: 'apns',
    name: 'Apple APNs (Direct)',
    provider: 'Apple',
    description: 'Native iOS push notification delivery with p8 key authentication, bypassing FCM layer.',
    configFields: [{
      key: 'teamId',
      label: 'Apple Team ID',
      placeholder: 'ABC123DEF',
      type: 'text'
    }, {
      key: 'bundleId',
      label: 'App Bundle ID',
      placeholder: 'com.org.app',
      type: 'text'
    }],
    setupTasks: [{
      id: 'apns-1',
      title: 'Validate Team ID',
      description: 'Verify Apple Developer team credentials',
      duration: 800,
      manualRequired: true,
      manualLabel: 'Generate .p8 key at developer.apple.com → Certificates, IDs & Profiles → Keys'
    }, {
      id: 'apns-2',
      title: 'Register bundle ID',
      description: 'Ensure app bundle ID is registered in Apple Developer Portal',
      duration: 600
    }]
  }]
}, {
  id: 'build',
  label: 'Build Pipeline',
  icon: Wrench,
  color: 'text-orange-500',
  description: 'CI/CD and binary delivery',
  plugins: [{
    id: 'eas-build',
    name: 'EAS Build',
    provider: 'Expo',
    description: 'Managed cloud builds for iOS and Android with environment profiles and build caching.',
    configFields: [{
      key: 'defaultProfile',
      label: 'Default Build Profile',
      placeholder: 'development',
      type: 'select',
      options: ['development', 'staging', 'production']
    }, {
      key: 'node',
      label: 'Node Version',
      placeholder: '20',
      type: 'select',
      options: ['18', '20', '22']
    }],
    setupTasks: [{
      id: 'eas-1',
      title: 'Authenticate with Expo',
      description: 'Validate robot token and resolve account slug',
      duration: 1000
    }, {
      id: 'eas-2',
      title: 'Create EAS project',
      description: 'Initialize EAS project linked to bundle ID',
      duration: 1500
    }, {
      id: 'eas-3',
      title: 'Generate eas.json',
      description: 'Create build profiles: development, staging, production',
      duration: 700
    }, {
      id: 'eas-4',
      title: 'Configure environment secrets',
      description: 'Upload API keys and secrets to EAS secret store',
      duration: 900
    }]
  }, {
    id: 'github-actions',
    name: 'GitHub Actions',
    provider: 'GitHub',
    description: 'CI/CD workflow automation with automated test runs, build triggers, and deployment gates.',
    configFields: [{
      key: 'defaultBranch',
      label: 'Default Branch',
      placeholder: 'main',
      type: 'text'
    }, {
      key: 'triggerOn',
      label: 'Trigger On',
      placeholder: 'push',
      type: 'select',
      options: ['push', 'pull_request', 'both']
    }],
    setupTasks: [{
      id: 'gh-1',
      title: 'Validate GitHub token',
      description: 'Authenticate and verify required repo/workflow scopes',
      duration: 800
    }, {
      id: 'gh-2',
      title: 'Create repository',
      description: 'Initialize repo with README and .gitignore',
      duration: 1200
    }, {
      id: 'gh-3',
      title: 'Set branch protection',
      description: 'Enable required status checks on default branch',
      duration: 600
    }, {
      id: 'gh-4',
      title: 'Deploy workflow files',
      description: 'Commit CI/CD YAML workflows to .github/workflows/',
      duration: 1000
    }]
  }]
}, {
  id: 'intelligence',
  label: 'Intelligence / AI',
  icon: Sparkles,
  color: 'text-amber-500',
  description: 'LLM and AI capabilities',
  plugins: [{
    id: 'vertex-ai',
    name: 'Google Vertex AI',
    provider: 'Google Cloud',
    description: 'Gemini 1.5 Pro integration via Firebase Extensions with streaming support and function calling.',
    configFields: [{
      key: 'model',
      label: 'Default Model',
      placeholder: 'gemini-1.5-pro',
      type: 'select',
      options: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-1.0-pro']
    }, {
      key: 'region',
      label: 'AI Region',
      placeholder: 'us-central1',
      type: 'select',
      options: ['us-central1', 'europe-west1', 'asia-east1']
    }],
    setupTasks: [{
      id: 'vertex-1',
      title: 'Enable Vertex AI API',
      description: 'Activate Vertex AI and Generative Language APIs in GCP',
      duration: 1400
    }, {
      id: 'vertex-2',
      title: 'Install Firebase Extension',
      description: 'Deploy Gemini chatbot Firebase Extension to project',
      duration: 2200
    }, {
      id: 'vertex-3',
      title: 'Configure rate limits',
      description: 'Set per-user and global API quota limits',
      duration: 600
    }]
  }]
}];
const MOCK_PROJECTS: Project[] = [{
  id: 'p1',
  name: 'Velocity Runner',
  bundleId: 'com.acme.velocity',
  status: 'active',
  updatedAt: '2026-03-15T10:00:00Z',
  plugins: ['firebase-auth', 'firestore', 'vertex-ai']
}, {
  id: 'p2',
  name: 'Zen Garden',
  bundleId: 'com.acme.zen',
  status: 'provisioning',
  updatedAt: '2026-03-15T14:20:00Z',
  plugins: ['firebase-auth', 'mock-db']
}, {
  id: 'p3',
  name: 'Pulse Health',
  bundleId: 'com.acme.pulse',
  status: 'pending-manual',
  updatedAt: '2026-03-14T09:15:00Z',
  plugins: ['firebase-auth', 'firestore', 'fcm', 'vertex-ai']
}];
const ALL_REGISTRY_PLUGINS: RegistryPlugin[] = [{
  id: 'firebase-auth',
  name: 'Firebase Auth',
  provider: 'Google Firebase',
  providerId: 'firebase',
  description: 'Apple, Google, and Email/Password auth with built-in session management.',
  categories: ['auth', 'security'],
  version: '2.1.0'
}, {
  id: 'clerk-auth',
  name: 'Clerk Auth',
  provider: 'Clerk',
  providerId: 'other',
  description: 'Next-gen user management with pre-built UI components and webhooks.',
  categories: ['auth', 'security'],
  version: '1.0.0',
  future: true
}, {
  id: 'mock-auth',
  name: 'Mock Auth',
  provider: 'Studio Core',
  providerId: 'studio',
  description: 'Local development authentication mock with configurable user fixtures.',
  categories: ['auth'],
  version: '1.3.2'
}, {
  id: 'firestore',
  name: 'Cloud Firestore',
  provider: 'Google Firebase',
  providerId: 'firebase',
  description: 'Real-time NoSQL document database with offline sync and security rules.',
  categories: ['persistence', 'security'],
  version: '3.0.1'
}, {
  id: 'supabase-db',
  name: 'Supabase DB',
  provider: 'Supabase',
  providerId: 'other',
  description: 'PostgreSQL-backed relational database with Edge Functions and Row Level Security.',
  categories: ['persistence', 'security'],
  version: '1.1.0',
  future: true
}, {
  id: 'mock-db',
  name: 'Mock DB',
  provider: 'Studio Core',
  providerId: 'studio',
  description: 'Local in-memory store for offline-first development and testing.',
  categories: ['persistence'],
  version: '1.2.0'
}, {
  id: 'vertex-ai',
  name: 'Google Vertex AI',
  provider: 'Google Cloud',
  providerId: 'firebase',
  description: 'Gemini 1.5 Pro integration via Firebase Extensions with streaming support.',
  categories: ['intelligence'],
  version: '1.4.0'
}, {
  id: 'openai-llm',
  name: 'OpenAI GPT-4',
  provider: 'OpenAI',
  providerId: 'other',
  description: 'Direct GPT-4o API integration with function calling and tool use.',
  categories: ['intelligence'],
  version: '0.9.0',
  future: true
}, {
  id: 'eas-build',
  name: 'EAS Build',
  provider: 'Expo',
  providerId: 'expo',
  description: 'Managed cloud builds for iOS and Android with environment profiles.',
  categories: ['build-pipeline'],
  version: '2.5.3'
}, {
  id: 'github-actions',
  name: 'GitHub Actions',
  provider: 'GitHub',
  providerId: 'github',
  description: 'CI/CD workflow automation triggered on push, PR, or manual dispatch.',
  categories: ['build-pipeline'],
  version: '1.8.0'
}, {
  id: 'eas-submit',
  name: 'EAS Submit',
  provider: 'Expo',
  providerId: 'expo',
  description: 'Automated binary submission to App Store Connect and Google Play.',
  categories: ['build-pipeline'],
  version: '2.1.0'
}, {
  id: 'fcm',
  name: 'Firebase Cloud Messaging',
  provider: 'Google Firebase',
  providerId: 'firebase',
  description: 'Cross-platform push notifications with topic subscriptions and data payloads.',
  categories: ['notifications'],
  version: '2.0.0'
}, {
  id: 'apns',
  name: 'Apple APNs',
  provider: 'Apple',
  providerId: 'other',
  description: 'Native iOS push notification delivery with p8 key authentication.',
  categories: ['notifications', 'security'],
  version: '1.5.0'
}, {
  id: 'onesignal',
  name: 'OneSignal',
  provider: 'OneSignal',
  providerId: 'other',
  description: 'Multi-platform notification orchestration with A/B testing and analytics.',
  categories: ['notifications'],
  version: '0.8.0',
  future: true
}, {
  id: 'app-check',
  name: 'Firebase App Check',
  provider: 'Google Firebase',
  providerId: 'firebase',
  description: 'Attestation service that protects backend resources from abuse.',
  categories: ['security'],
  version: '1.2.0'
}, {
  id: 'keychain',
  name: 'Secure Keychain',
  provider: 'Studio Core',
  providerId: 'studio',
  description: 'iOS Keychain and Android Keystore abstraction for sensitive credential storage.',
  categories: ['security'],
  version: '2.0.0'
}];
const REGISTRY_CATEGORIES: RegistryCategory[] = [{
  id: 'auth',
  label: 'Authentication',
  icon: KeyRound,
  color: 'text-violet-500',
  pluginIds: ALL_REGISTRY_PLUGINS.filter(p => p.categories.includes('auth')).map(p => p.id)
}, {
  id: 'persistence',
  label: 'Persistence Store',
  icon: HardDrive,
  color: 'text-blue-500',
  pluginIds: ALL_REGISTRY_PLUGINS.filter(p => p.categories.includes('persistence')).map(p => p.id)
}, {
  id: 'security',
  label: 'Security',
  icon: ShieldCheck,
  color: 'text-emerald-500',
  pluginIds: ALL_REGISTRY_PLUGINS.filter(p => p.categories.includes('security')).map(p => p.id)
}, {
  id: 'build-pipeline',
  label: 'Build Pipeline',
  icon: Wrench,
  color: 'text-orange-500',
  pluginIds: ALL_REGISTRY_PLUGINS.filter(p => p.categories.includes('build-pipeline')).map(p => p.id)
}, {
  id: 'notifications',
  label: 'Notifications',
  icon: BellIcon,
  color: 'text-pink-500',
  pluginIds: ALL_REGISTRY_PLUGINS.filter(p => p.categories.includes('notifications')).map(p => p.id)
}, {
  id: 'intelligence',
  label: 'Intelligence / AI',
  icon: Sparkles,
  color: 'text-amber-500',
  pluginIds: ALL_REGISTRY_PLUGINS.filter(p => p.categories.includes('intelligence')).map(p => p.id)
}];
const CATEGORY_LABEL_MAP: Record<string, string> = {
  auth: 'Auth',
  persistence: 'Persistence',
  security: 'Security',
  'build-pipeline': 'Build',
  notifications: 'Notifications',
  intelligence: 'AI'
};
const CATEGORY_PILL_STYLE: Record<string, string> = {
  auth: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30',
  persistence: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  security: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  'build-pipeline': 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30',
  notifications: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/30',
  intelligence: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'
};
const SERVICE_HEALTH_DATA: ServiceHealth[] = [{
  id: 'sh1',
  name: 'Firebase Auth',
  provider: 'Firebase',
  uptime: 99.97,
  latency: 42,
  status: 'operational',
  lastCheck: '12s ago'
}, {
  id: 'sh2',
  name: 'Cloud Firestore',
  provider: 'Firebase',
  uptime: 99.94,
  latency: 68,
  status: 'operational',
  lastCheck: '12s ago'
}, {
  id: 'sh3',
  name: 'GitHub Repository',
  provider: 'GitHub',
  uptime: 100,
  latency: 24,
  status: 'operational',
  lastCheck: '5s ago'
}, {
  id: 'sh4',
  name: 'EAS Build',
  provider: 'Expo',
  uptime: 98.2,
  latency: 310,
  status: 'degraded',
  lastCheck: '30s ago'
}, {
  id: 'sh5',
  name: 'Apple APNs',
  provider: 'Apple',
  uptime: 99.99,
  latency: 91,
  status: 'operational',
  lastCheck: '18s ago'
}, {
  id: 'sh6',
  name: 'Vertex AI',
  provider: 'GCP',
  uptime: 99.5,
  latency: 182,
  status: 'operational',
  lastCheck: '22s ago'
}];
const MOCK_LOGS: LogEntry[] = [{
  id: 'l1',
  timestamp: '14:02:01',
  level: 'info',
  message: 'Initializing provisioning pipeline for com.acme.velocity'
}, {
  id: 'l2',
  timestamp: '14:02:03',
  level: 'info',
  message: 'Authenticating with GCP service account...'
}, {
  id: 'l3',
  timestamp: '14:02:05',
  level: 'success',
  message: '✓ GCP authentication successful. Project ID: acme-mobile-prod'
}, {
  id: 'l4',
  timestamp: '14:02:07',
  level: 'info',
  message: 'Creating Firebase project: velocity-runner-prod'
}, {
  id: 'l5',
  timestamp: '14:02:12',
  level: 'success',
  message: '✓ Firebase project created. Region: us-central1'
}, {
  id: 'l6',
  timestamp: '14:02:13',
  level: 'info',
  message: 'Enabling Auth providers: apple, google, email'
}, {
  id: 'l7',
  timestamp: '14:02:15',
  level: 'success',
  message: '✓ Auth providers configured'
}, {
  id: 'l8',
  timestamp: '14:02:16',
  level: 'info',
  message: 'Provisioning Cloud Firestore in native mode...'
}, {
  id: 'l9',
  timestamp: '14:02:22',
  level: 'success',
  message: '✓ Firestore provisioned. Security rules deployed.'
}, {
  id: 'l10',
  timestamp: '14:02:23',
  level: 'info',
  message: 'Creating GitHub repository: acme-org/velocity-runner'
}, {
  id: 'l11',
  timestamp: '14:02:27',
  level: 'success',
  message: '✓ Repository created. Branch protection enabled on main.'
}, {
  id: 'l12',
  timestamp: '14:02:28',
  level: 'info',
  message: 'Generating EAS project configuration...'
}, {
  id: 'l13',
  timestamp: '14:02:31',
  level: 'warn',
  message: '⚠ EAS build queue latency detected (310ms avg). Proceeding.'
}, {
  id: 'l14',
  timestamp: '14:02:35',
  level: 'success',
  message: '✓ EAS project linked. Build profiles: development, staging, production'
}, {
  id: 'l15',
  timestamp: '14:02:36',
  level: 'info',
  message: 'Syncing Apple Developer Portal...'
}, {
  id: 'l16',
  timestamp: '14:02:40',
  level: 'warn',
  message: '⚠ Awaiting manual APNs key upload. Pausing Apple sync.'
}, {
  id: 'l17',
  timestamp: '14:02:41',
  level: 'info',
  message: 'Generating google-services.json and GoogleService-Info.plist...'
}, {
  id: 'l18',
  timestamp: '14:02:43',
  level: 'success',
  message: '✓ Config files generated and committed to repository.'
}, {
  id: 'l19',
  timestamp: '14:02:44',
  level: 'debug',
  message: 'MCP server binding project context to workspace...'
}, {
  id: 'l20',
  timestamp: '14:02:46',
  level: 'success',
  message: '✓ Provisioning complete. 1 manual action required.'
}];
const MOCK_DEPLOYMENTS: DeploymentRecord[] = [{
  id: 'd1',
  version: '1.4.2',
  branch: 'main',
  commit: 'a3f9c12',
  triggeredBy: 'maya@acme.co',
  status: 'success',
  platform: 'both',
  createdAt: '2026-03-15T13:45:00Z',
  duration: '4m 12s'
}, {
  id: 'd2',
  version: '1.4.1',
  branch: 'main',
  commit: 'b7e2a88',
  triggeredBy: 'liam@acme.co',
  status: 'success',
  platform: 'ios',
  createdAt: '2026-03-14T10:20:00Z',
  duration: '3m 58s'
}, {
  id: 'd3',
  version: '1.4.1',
  branch: 'fix/auth-crash',
  commit: 'c1d5f44',
  triggeredBy: 'maya@acme.co',
  status: 'failed',
  platform: 'android',
  createdAt: '2026-03-13T16:05:00Z',
  duration: '1m 33s'
}, {
  id: 'd4',
  version: '1.4.0',
  branch: 'main',
  commit: 'e9b3c77',
  triggeredBy: 'noah@acme.co',
  status: 'success',
  platform: 'both',
  createdAt: '2026-03-12T09:00:00Z',
  duration: '5m 02s'
}, {
  id: 'd5',
  version: '1.5.0-beta',
  branch: 'feat/vertex-integration',
  commit: 'f4a8d31',
  triggeredBy: 'maya@acme.co',
  status: 'running',
  platform: 'both',
  createdAt: '2026-03-15T14:30:00Z'
}];
const OVERVIEW_STATS = [{
  id: 'health',
  label: 'Service Health',
  value: '5/6',
  sub: 'Operational',
  icon: Activity,
  color: 'text-emerald-500',
  bg: 'bg-emerald-500/10'
}, {
  id: 'deploys',
  label: 'Deployments',
  value: '14',
  sub: 'Last 30 days',
  icon: Package,
  color: 'text-blue-500',
  bg: 'bg-blue-500/10'
}, {
  id: 'uptime',
  label: 'Avg Uptime',
  value: '99.6%',
  sub: 'All services',
  icon: TrendingUp,
  color: 'text-violet-500',
  bg: 'bg-violet-500/10'
}, {
  id: 'latency',
  label: 'Avg Latency',
  value: '103ms',
  sub: 'P50 across services',
  icon: Globe,
  color: 'text-amber-500',
  bg: 'bg-amber-500/10'
}];
const APP_TYPE_OPTIONS: AppTypeOption[] = [{
  id: 'mobile',
  label: 'Mobile App',
  description: 'React Native / Expo',
  icon: Smartphone,
  available: true
}, {
  id: 'web',
  label: 'Web App',
  description: 'Next.js, Vite, SPA',
  icon: MonitorSmartphone,
  available: false
}, {
  id: 'backend',
  label: 'Backend / API',
  description: 'Node.js, Edge functions',
  icon: Server,
  available: false
}];

// --- NewProjectModal ---

const NewProjectModal = ({
  onClose,
  onCreate
}: {
  onClose: () => void;
  onCreate: (name: string, bundleId: string, type: AppType) => void;
}) => {
  const [appName, setAppName] = useState('');
  const [bundleId, setBundleId] = useState('');
  const [appType, setAppType] = useState<AppType>('mobile');
  const [submitted, setSubmitted] = useState(false);
  const canSubmit = appName.trim().length > 0 && bundleId.trim().length > 0 && !submitted;
  const handleSubmit = () => {
    if (!canSubmit) return;
    setSubmitted(true);
    setTimeout(() => {
      onCreate(appName.trim(), bundleId.trim(), appType);
      onClose();
    }, 600);
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{
    background: 'rgba(0,0,0,0.55)'
  }} onClick={onClose}>
      <motion.div initial={{
      opacity: 0,
      scale: 0.96,
      y: 16
    }} animate={{
      opacity: 1,
      scale: 1,
      y: 0
    }} exit={{
      opacity: 0,
      scale: 0.96,
      y: 16
    }} transition={{
      duration: 0.22,
      ease: 'easeOut'
    }} className="bg-background border border-border rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-5 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
              <Plus size={18} className="text-primary" />
            </div>
            <div>
              <h2 className="font-bold text-base tracking-tight">New Project</h2>
              <p className="text-[11px] text-muted-foreground mt-0.5">Set up your application details</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground">Application Name</label>
            <input type="text" placeholder="e.g. Velocity Runner" value={appName} onChange={e => setAppName(e.target.value)} className="w-full px-3 py-2.5 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground">Bundle / Package Identifier</label>
            <input type="text" placeholder="com.org.appname" value={bundleId} onChange={e => setBundleId(e.target.value)} className="w-full px-3 py-2.5 rounded-lg border border-border bg-background text-sm font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
            <p className="text-[11px] text-muted-foreground">
              <span>Used for iOS Bundle ID and Android package name.</span>
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-foreground">Project Type</label>
            <div className="grid grid-cols-3 gap-2">
              {APP_TYPE_OPTIONS.map(opt => {
              const OptIcon = opt.icon;
              const isSelected = appType === opt.id;
              return <button key={opt.id} disabled={!opt.available} onClick={() => opt.available && setAppType(opt.id)} className={`relative flex flex-col items-center gap-2 p-3.5 rounded-xl border-2 text-center transition-all ${!opt.available ? 'border-border opacity-45 cursor-not-allowed' : isSelected ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-primary/40 hover:bg-muted/40 cursor-pointer'}`}>
                    {!opt.available && <span className="absolute top-1.5 right-1.5 text-[8px] font-bold bg-muted text-muted-foreground px-1 py-0.5 rounded border border-border leading-none">
                        SOON
                      </span>}
                    <OptIcon size={20} className={isSelected ? 'text-primary' : 'text-muted-foreground'} />
                    <span className={`text-[11px] font-bold leading-tight ${isSelected ? 'text-primary' : 'text-foreground'}`}>
                      {opt.label}
                    </span>
                  </button>;
            })}
            </div>
            <p className="text-[11px] text-muted-foreground pt-0.5">
              <span>Only </span><strong>Mobile</strong><span> is supported today. Integrations are configured inside the project after creation.</span>
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-muted/20">
          <button onClick={onClose} className="text-xs font-bold px-4 py-2 border border-border rounded-lg hover:bg-accent transition-colors">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={!canSubmit} className="flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm">
            {submitted ? <span className="flex items-center gap-2">
                <CheckCircle2 size={14} />
                <span>Creating…</span>
              </span> : <span className="flex items-center gap-2">
                <Smartphone size={14} />
                <span>Create Project</span>
                <ArrowRight size={13} />
              </span>}
          </button>
        </div>
      </motion.div>
    </div>;
};

// --- IntegrationModal ---

const IntegrationModal = ({
  config,
  isConnected,
  onClose,
  onConnect,
  onDisconnect
}: {
  config: IntegrationConfig;
  isConnected: boolean;
  onClose: () => void;
  onConnect: (providerId: ProviderId) => void;
  onDisconnect: (providerId: ProviderId) => void;
}) => {
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [revealedFields, setRevealedFields] = useState<Record<string, boolean>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const LogoIcon = config.logo;
  const allFilled = config.fields.every(f => (fieldValues[f.key] ?? '').trim().length > 0);
  const handleConnect = () => {
    if (!allFilled) return;
    setIsSubmitting(true);
    setTimeout(() => {
      setIsSubmitting(false);
      setSubmitted(true);
      setTimeout(() => {
        onConnect(config.id);
        onClose();
      }, 900);
    }, 1400);
  };
  const handleDisconnect = () => {
    onDisconnect(config.id);
    onClose();
  };
  const affectedPluginIds = PROVIDER_PLUGIN_MAP[config.id] ?? [];
  const affectedPlugins = ALL_REGISTRY_PLUGINS.filter(p => affectedPluginIds.includes(p.id));
  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{
    background: 'rgba(0,0,0,0.55)'
  }} onClick={onClose}>
      <motion.div initial={{
      opacity: 0,
      scale: 0.96,
      y: 12
    }} animate={{
      opacity: 1,
      scale: 1,
      y: 0
    }} exit={{
      opacity: 0,
      scale: 0.96,
      y: 12
    }} transition={{
      duration: 0.2,
      ease: 'easeOut'
    }} className="bg-background border border-border rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between p-6 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center shrink-0">
              <LogoIcon size={20} className={config.logoColor} />
            </div>
            <div>
              <h2 className="font-bold text-base tracking-tight">{config.name}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isConnected ? <span className="flex items-center gap-1 text-emerald-500 font-medium"><CheckCircle2 size={11} /><span>Connected</span></span> : <span>Not connected</span>}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-5 max-h-[60vh] overflow-y-auto">
          <p className="text-sm text-muted-foreground leading-relaxed">{config.description}</p>

          <div className="bg-muted/50 rounded-xl p-4 space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
              Unlocks {affectedPlugins.length} plugins
            </p>
            <div className="flex flex-wrap gap-2">
              {affectedPlugins.map(p => <span key={p.id} className="flex items-center gap-1.5 text-[11px] font-medium bg-background border border-border px-2 py-1 rounded-lg">
                  <Code2 size={11} className="text-muted-foreground" />
                  <span>{p.name}</span>
                </span>)}
            </div>
          </div>

          {!isConnected && <div className="space-y-4">
              {config.fields.map(field => <div key={field.key} className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground">{field.label}</label>
                  {field.type === 'textarea' ? <textarea rows={5} placeholder={field.placeholder} value={fieldValues[field.key] ?? ''} onChange={e => setFieldValues(v => ({
              ...v,
              [field.key]: e.target.value
            }))} className="w-full px-3 py-2.5 rounded-lg border border-border bg-background font-mono text-[11px] leading-relaxed focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all resize-none" /> : <div className="relative">
                      <input type={field.type === 'password' && !revealedFields[field.key] ? 'password' : 'text'} placeholder={field.placeholder} value={fieldValues[field.key] ?? ''} onChange={e => setFieldValues(v => ({
                ...v,
                [field.key]: e.target.value
              }))} className="w-full px-3 py-2.5 rounded-lg border border-border bg-background font-mono text-[12px] focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all pr-10" />
                      {field.type === 'password' && <button type="button" onClick={() => setRevealedFields(v => ({
                ...v,
                [field.key]: !v[field.key]
              }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                          {revealedFields[field.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>}
                    </div>}
                  <p className="text-[11px] text-muted-foreground flex gap-1.5 leading-relaxed">
                    <Info size={11} className="shrink-0 mt-0.5" />
                    <span>{field.hint}</span>
                  </p>
                </div>)}
            </div>}

          {isConnected && <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 flex items-center gap-3">
              <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
              <div>
                <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400">Integration active</p>
                <p className="text-xs text-emerald-600/80 dark:text-emerald-400/80 mt-0.5">
                  Credentials stored securely in the local vault. All {affectedPlugins.length} plugins are available.
                </p>
              </div>
            </div>}

          <a href={config.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs text-primary font-medium hover:underline">
            <ExternalLink size={12} />
            <span>View setup guide</span>
          </a>
        </div>

        <div className="flex items-center justify-between p-5 border-t border-border bg-muted/20">
          {isConnected ? <button onClick={handleDisconnect} className="flex items-center gap-2 text-xs font-bold text-red-500 hover:text-red-400 px-3 py-2 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition-colors">
              <Unlink size={13} />
              <span>Disconnect</span>
            </button> : <div />}
          {!isConnected && <button onClick={handleConnect} disabled={!allFilled || isSubmitting} className="flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed ml-auto">
              {isSubmitting ? <span className="flex items-center gap-2"><Loader2 size={14} className="animate-spin" /><span>Verifying...</span></span> : submitted ? <span className="flex items-center gap-2"><CheckCircle2 size={14} /><span>Connected!</span></span> : <span className="flex items-center gap-2"><Link2 size={14} /><span>Connect Integration</span><ArrowRight size={13} /></span>}
            </button>}
          {isConnected && <button onClick={onClose} className="text-xs font-bold px-4 py-2 border border-border rounded-lg hover:bg-accent transition-colors">
              Done
            </button>}
        </div>
      </motion.div>
    </div>;
};

// --- Badge ---

const Badge = ({
  children,
  status
}: {
  children: React.ReactNode;
  status: ProjectStatus;
}) => {
  const styles: Record<ProjectStatus, string> = {
    active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
    provisioning: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30 animate-pulse',
    error: 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30',
    'pending-manual': 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${styles[status]}`}>
      {children}
    </span>;
};

// --- SidebarItem ---

const SidebarItem = ({
  icon: Icon,
  label,
  active,
  collapsed,
  onClick
}: {
  icon: React.ElementType;
  label: string;
  active?: boolean;
  collapsed: boolean;
  onClick: () => void;
}) => <button onClick={onClick} title={collapsed ? label : undefined} className={`w-full flex items-center gap-3 rounded-lg transition-colors text-sm font-medium ${collapsed ? 'px-2.5 py-2.5 justify-center' : 'px-4 py-2.5'} ${active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'}`}>
    <Icon size={18} className="shrink-0" />
    <AnimatePresence initial={false}>
      {!collapsed && <motion.span initial={{
      opacity: 0,
      width: 0
    }} animate={{
      opacity: 1,
      width: 'auto'
    }} exit={{
      opacity: 0,
      width: 0
    }} transition={{
      duration: 0.18
    }} className="overflow-hidden whitespace-nowrap">
          {label}
        </motion.span>}
    </AnimatePresence>
  </button>;

// --- InfrastructureTab ---

const InfrastructureTab = ({
  project
}: {
  project: Project;
}) => {
  const [pluginStates, setPluginStates] = useState<Record<string, ProjectPluginState>>(() => {
    const initial: Record<string, ProjectPluginState> = {};
    INFRA_CATEGORIES.forEach(cat => {
      const activePlugin = cat.plugins.find(p => project.plugins.includes(p.id));
      initial[cat.id] = {
        categoryId: cat.id,
        selectedPluginId: activePlugin?.id ?? null,
        configValues: {},
        setupStatus: activePlugin ? 'completed' : 'idle',
        taskStates: activePlugin ? Object.fromEntries(activePlugin.setupTasks.map(t => [t.id, 'completed' as SetupTaskStatus])) : {}
      };
    });
    return initial;
  });
  const [expandedCategory, setExpandedCategory] = useState<string | null>(INFRA_CATEGORIES[0].id);
  const runSetup = (categoryId: string) => {
    const state = pluginStates[categoryId];
    if (!state.selectedPluginId) return;
    const category = INFRA_CATEGORIES.find(c => c.id === categoryId);
    if (!category) return;
    const plugin = category.plugins.find(p => p.id === state.selectedPluginId);
    if (!plugin) return;
    setPluginStates(prev => ({
      ...prev,
      [categoryId]: {
        ...prev[categoryId],
        setupStatus: 'running',
        taskStates: Object.fromEntries(plugin.setupTasks.map(t => [t.id, 'idle' as SetupTaskStatus]))
      }
    }));
    let cumulative = 0;
    plugin.setupTasks.forEach(task => {
      const startDelay = cumulative;
      cumulative += task.duration + 200;
      setTimeout(() => {
        setPluginStates(prev => ({
          ...prev,
          [categoryId]: {
            ...prev[categoryId],
            taskStates: {
              ...prev[categoryId].taskStates,
              [task.id]: 'running'
            }
          }
        }));
      }, startDelay);
      setTimeout(() => {
        const finalStatus: SetupTaskStatus = task.manualRequired ? 'manual-required' : 'completed';
        setPluginStates(prev => {
          const newTaskStates = {
            ...prev[categoryId].taskStates,
            [task.id]: finalStatus
          };
          const allDone = plugin.setupTasks.every(t => {
            const s = newTaskStates[t.id];
            return s === 'completed' || s === 'manual-required';
          });
          const hasManual = plugin.setupTasks.some(t => newTaskStates[t.id] === 'manual-required');
          return {
            ...prev,
            [categoryId]: {
              ...prev[categoryId],
              taskStates: newTaskStates,
              setupStatus: allDone ? hasManual ? 'manual-required' : 'completed' : 'running',
              completedAt: allDone ? new Date().toISOString() : undefined
            }
          };
        });
      }, startDelay + task.duration);
    });
  };
  const resetSetup = (categoryId: string) => {
    setPluginStates(prev => ({
      ...prev,
      [categoryId]: {
        ...prev[categoryId],
        setupStatus: 'idle',
        taskStates: {}
      }
    }));
  };
  return <div className="space-y-4">
      {INFRA_CATEGORIES.map(category => {
      const state = pluginStates[category.id];
      const CategoryIcon = category.icon;
      const isExpanded = expandedCategory === category.id;
      const selectedPlugin = category.plugins.find(p => p.id === state.selectedPluginId) ?? null;
      const isSetupDone = state.setupStatus === 'completed' || state.setupStatus === 'manual-required';
      const isRunning = state.setupStatus === 'running';
      return <div key={category.id} className={`bg-card border rounded-2xl overflow-hidden transition-all shadow-sm ${isExpanded ? 'border-border' : 'border-border/60'}`}>
            <button onClick={() => setExpandedCategory(isExpanded ? null : category.id)} className="w-full flex items-center gap-4 p-5 hover:bg-muted/40 transition-colors text-left">
              <div className={`p-2 rounded-xl bg-muted ${category.color}`}>
                <CategoryIcon size={16} />
              </div>
              <div className="flex-grow min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="font-bold text-sm">{category.label}</span>
                  {selectedPlugin && <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground border border-border">
                      {selectedPlugin.name}
                    </span>}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">{category.description}</p>
              </div>
              <div className="flex items-center gap-2.5 shrink-0">
                {state.setupStatus === 'completed' && <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                    <CheckCircle2 size={10} /><span>CONFIGURED</span>
                  </span>}
                {state.setupStatus === 'manual-required' && <span className="flex items-center gap-1 text-[10px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-full">
                    <AlertTriangle size={10} /><span>MANUAL STEP</span>
                  </span>}
                {state.setupStatus === 'running' && <span className="flex items-center gap-1 text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 border border-blue-500/30 px-2 py-0.5 rounded-full animate-pulse">
                    <Loader2 size={10} className="animate-spin" /><span>RUNNING</span>
                  </span>}
                {state.setupStatus === 'idle' && !selectedPlugin && <span className="text-[10px] font-bold text-muted-foreground bg-muted px-2 py-0.5 rounded-full border border-border">NOT SET</span>}
                <ChevronRight size={16} className={`text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} />
              </div>
            </button>

            <AnimatePresence initial={false}>
              {isExpanded && <motion.div initial={{
            height: 0,
            opacity: 0
          }} animate={{
            height: 'auto',
            opacity: 1
          }} exit={{
            height: 0,
            opacity: 0
          }} transition={{
            duration: 0.25,
            ease: 'easeInOut'
          }} className="overflow-hidden">
                  <div className="border-t border-border">
                    {!isRunning && !isSetupDone && <div className="p-5 space-y-4">
                        <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Select Plugin</p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {category.plugins.map(plugin => {
                    const isSelected = state.selectedPluginId === plugin.id;
                    return <button key={plugin.id} onClick={() => setPluginStates(prev => ({
                      ...prev,
                      [category.id]: {
                        ...prev[category.id],
                        selectedPluginId: plugin.id,
                        configValues: {}
                      }
                    }))} className={`text-left p-4 rounded-xl border-2 transition-all ${isSelected ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-primary/40 hover:bg-muted/40'}`}>
                                <div className="flex items-start justify-between mb-1.5">
                                  <span className="font-bold text-sm">{plugin.name}</span>
                                  {isSelected && <CheckCircle2 size={14} className="text-primary shrink-0" />}
                                </div>
                                <p className="text-[10px] font-medium text-muted-foreground mb-1">{plugin.provider}</p>
                                <p className="text-xs text-muted-foreground leading-relaxed">{plugin.description}</p>
                              </button>;
                  })}
                        </div>
                      </div>}

                    {!isRunning && !isSetupDone && selectedPlugin && selectedPlugin.configFields.length > 0 && <div className="px-5 pb-4 space-y-3">
                        <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-3">Configuration</p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {selectedPlugin.configFields.map(field => <div key={field.key} className="space-y-1.5">
                              <label className="text-xs font-semibold text-foreground">{field.label}</label>
                              {field.type === 'select' && field.options ? <select value={state.configValues[field.key] ?? ''} onChange={e => setPluginStates(prev => ({
                      ...prev,
                      [category.id]: {
                        ...prev[category.id],
                        configValues: {
                          ...prev[category.id].configValues,
                          [field.key]: e.target.value
                        }
                      }
                    }))} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all">
                                  <option value="">{field.placeholder}</option>
                                  {field.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                                </select> : <input type="text" placeholder={field.placeholder} value={state.configValues[field.key] ?? ''} onChange={e => setPluginStates(prev => ({
                      ...prev,
                      [category.id]: {
                        ...prev[category.id],
                        configValues: {
                          ...prev[category.id].configValues,
                          [field.key]: e.target.value
                        }
                      }
                    }))} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all font-mono" />}
                            </div>)}
                        </div>
                      </div>}

                    {!isRunning && !isSetupDone && <div className="px-5 pb-5">
                        <button onClick={() => runSetup(category.id)} disabled={!selectedPlugin} className="flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm">
                          <Play size={14} fill="currentColor" />
                          <span>Run Setup</span>
                        </button>
                      </div>}

                    {(isRunning || isSetupDone) && selectedPlugin && <div className="p-5 space-y-4">
                        <div className="flex items-center justify-between">
                          <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                            Setup Timeline — {selectedPlugin.name}
                          </p>
                          {isSetupDone && <button onClick={() => resetSetup(category.id)} className="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground hover:text-foreground px-2.5 py-1 rounded-lg border border-border hover:bg-accent transition-colors">
                              <RotateCcw size={10} />
                              <span>Reset</span>
                            </button>}
                        </div>

                        <div className="space-y-0">
                          {selectedPlugin.setupTasks.map((task, idx) => {
                    const taskStatus = state.taskStates[task.id] ?? 'idle';
                    const isLast = idx === selectedPlugin.setupTasks.length - 1;
                    return <div key={task.id} className="flex gap-4">
                                <div className="flex flex-col items-center">
                                  <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border-2 transition-all duration-300 ${taskStatus === 'completed' ? 'border-emerald-500 bg-emerald-500/10' : taskStatus === 'running' ? 'border-primary bg-primary/10' : taskStatus === 'manual-required' ? 'border-amber-500 bg-amber-500/10' : taskStatus === 'error' ? 'border-red-500 bg-red-500/10' : 'border-border bg-background'}`}>
                                    {taskStatus === 'completed' && <CheckCircle2 size={13} className="text-emerald-500" />}
                                    {taskStatus === 'running' && <Loader2 size={13} className="text-primary animate-spin" />}
                                    {taskStatus === 'manual-required' && <AlertTriangle size={13} className="text-amber-500" />}
                                    {taskStatus === 'error' && <X size={13} className="text-red-500" />}
                                    {taskStatus === 'idle' && <span className="w-2 h-2 rounded-full bg-muted-foreground/30" />}
                                  </div>
                                  {!isLast && <div className={`w-0.5 flex-grow my-1 transition-all duration-500 ${taskStatus === 'completed' || taskStatus === 'manual-required' ? 'bg-emerald-500/40' : 'bg-border'}`} style={{
                          minHeight: '20px'
                        }} />}
                                </div>
                                <div className="flex-grow pb-4">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="pt-0.5">
                                      <p className={`text-sm font-semibold leading-tight ${taskStatus === 'idle' ? 'text-muted-foreground' : 'text-foreground'}`}>{task.title}</p>
                                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{task.description}</p>
                                      {taskStatus === 'manual-required' && task.manualLabel && <div className="mt-2 flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5">
                                          <AlertTriangle size={12} className="text-amber-500 shrink-0 mt-0.5" />
                                          <p className="text-[11px] text-amber-600 dark:text-amber-400 leading-relaxed">{task.manualLabel}</p>
                                        </div>}
                                    </div>
                                    <div className="shrink-0 pt-0.5">
                                      {taskStatus === 'running' && <span className="text-[9px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 border border-blue-500/30 px-1.5 py-0.5 rounded animate-pulse">RUNNING</span>}
                                      {taskStatus === 'completed' && <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.5 rounded">DONE</span>}
                                      {taskStatus === 'manual-required' && <span className="text-[9px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">ACTION</span>}
                                    </div>
                                  </div>
                                </div>
                              </div>;
                  })}
                        </div>

                        {isSetupDone && <div className={`rounded-xl p-3.5 flex items-center gap-3 border ${state.setupStatus === 'manual-required' ? 'bg-amber-500/10 border-amber-500/30' : 'bg-emerald-500/10 border-emerald-500/30'}`}>
                            {state.setupStatus === 'manual-required' ? <AlertTriangle size={16} className="text-amber-500 shrink-0" /> : <CheckCheck size={16} className="text-emerald-500 shrink-0" />}
                            <div>
                              <p className={`text-xs font-bold ${state.setupStatus === 'manual-required' ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                {state.setupStatus === 'manual-required' ? 'Setup complete — manual action required' : 'Setup complete'}
                              </p>
                              {state.completedAt && <p className="text-[10px] text-muted-foreground mt-0.5">Finished at {new Date(state.completedAt).toLocaleTimeString()}</p>}
                            </div>
                          </div>}
                      </div>}
                  </div>
                </motion.div>}
            </AnimatePresence>
          </div>;
    })}
    </div>;
};

// --- ProjectOverview ---

const ProjectOverview = ({
  project,
  onBack,
  connectedProviders,
  onOpenIntegration
}: {
  project: Project;
  onBack: () => void;
  connectedProviders: ConnectedProviders;
  onOpenIntegration: (id: ProviderId) => void;
}) => {
  const [activeTab, setActiveTab] = useState<ProjectTab>('overview');
  const logEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({
      behavior: 'smooth'
    });
  }, [activeTab]);
  const PROJECT_TABS: {
    id: ProjectTab;
    label: string;
    icon: React.ElementType;
  }[] = [{
    id: 'overview',
    label: 'Overview',
    icon: Activity
  }, {
    id: 'infrastructure',
    label: 'Infrastructure',
    icon: Server
  }, {
    id: 'deployments',
    label: 'Deployments',
    icon: Package
  }];
  const logLevelStyles: Record<LogEntry['level'], string> = {
    info: 'text-slate-400',
    success: 'text-emerald-400',
    warn: 'text-amber-400',
    error: 'text-red-400',
    debug: 'text-purple-400'
  };
  const deployStatusConfig: Record<DeploymentRecord['status'], {
    color: string;
    label: string;
    bg: string;
  }> = {
    success: {
      color: 'text-emerald-600 dark:text-emerald-400',
      label: 'Success',
      bg: 'bg-emerald-500/10 border-emerald-500/30'
    },
    failed: {
      color: 'text-red-600 dark:text-red-400',
      label: 'Failed',
      bg: 'bg-red-500/10 border-red-500/30'
    },
    running: {
      color: 'text-blue-600 dark:text-blue-400',
      label: 'Running',
      bg: 'bg-blue-500/10 border-blue-500/30 animate-pulse'
    },
    queued: {
      color: 'text-muted-foreground',
      label: 'Queued',
      bg: 'bg-muted border-border'
    }
  };
  const activePluginDetails = project.plugins.map(pid => {
    const regPlugin = ALL_REGISTRY_PLUGINS.find(p => p.id === pid);
    const health = SERVICE_HEALTH_DATA.find(s => s.name.toLowerCase().includes(pid.split('-')[0]));
    return {
      id: pid,
      name: regPlugin?.name ?? pid,
      provider: regPlugin?.provider ?? '—',
      health
    };
  });
  const integrationSummary = INTEGRATION_CONFIGS.map(cfg => ({
    ...cfg,
    connected: connectedProviders[cfg.id],
    pluginCount: PROVIDER_PLUGIN_MAP[cfg.id]?.length ?? 0
  }));
  return <motion.div initial={{
    opacity: 0,
    y: 16
  }} animate={{
    opacity: 1,
    y: 0
  }} transition={{
    duration: 0.35,
    ease: 'easeOut'
  }} className="space-y-0">
      <div className="flex items-center gap-4 mb-6">
        <button onClick={onBack} className="p-2 hover:bg-accent rounded-full text-muted-foreground transition-colors" aria-label="Back to projects">
          <ChevronRight size={20} className="rotate-180" />
        </button>
        <div className="flex-grow">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
            <Badge status={project.status}>{project.status.toUpperCase()}</Badge>
          </div>
          <p className="text-xs text-muted-foreground font-mono mt-0.5">{project.bundleId}</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 border border-border rounded-lg hover:bg-accent transition-colors">
            <Github size={14} /><span>Repository</span>
          </button>
          <button className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity">
            <Zap size={14} /><span>Swap Plugins</span>
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border mb-6">
        {PROJECT_TABS.map(tab => <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${activeTab === tab.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            <tab.icon size={15} />
            <span>{tab.label}</span>
          </button>)}
      </div>

      <AnimatePresence mode="wait">
        {activeTab === 'overview' && <motion.div key="overview" initial={{
        opacity: 0,
        y: 8
      }} animate={{
        opacity: 1,
        y: 0
      }} exit={{
        opacity: 0,
        y: -8
      }} transition={{
        duration: 0.2
      }} className="space-y-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {OVERVIEW_STATS.map(stat => {
            const StatIcon = stat.icon;
            return <div key={stat.id} className="bg-card border border-border rounded-xl p-4 shadow-sm">
                    <div className="flex items-center justify-between mb-3">
                      <div className={`p-2 rounded-lg ${stat.bg}`}>
                        <StatIcon size={15} className={stat.color} />
                      </div>
                    </div>
                    <p className="text-xl font-bold tracking-tight">{stat.value}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{stat.label}</p>
                    <p className="text-[10px] text-muted-foreground/70 mt-0.5">{stat.sub}</p>
                  </div>;
          })}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-1 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Active Plugins</h2>
                  <span className="text-[10px] font-bold bg-primary/10 text-primary px-2 py-0.5 rounded-full">{activePluginDetails.length}</span>
                </div>
                <div className="space-y-2">
                  {activePluginDetails.map(p => <div key={p.id} className="bg-card border border-border rounded-xl p-3.5 flex items-center gap-3 shadow-sm">
                      <div className="p-2 rounded-lg bg-primary/5"><Code2 size={14} className="text-primary" /></div>
                      <div className="flex-grow min-w-0">
                        <p className="text-sm font-semibold truncate">{p.name}</p>
                        <p className="text-[10px] text-muted-foreground truncate">{p.provider}</p>
                      </div>
                      <div className={`w-2 h-2 rounded-full shrink-0 ${p.health?.status === 'operational' ? 'bg-emerald-500' : p.health?.status === 'degraded' ? 'bg-amber-400' : 'bg-muted-foreground/40'}`} />
                    </div>)}
                  {activePluginDetails.length === 0 && <div className="bg-muted/30 border border-dashed border-border rounded-xl p-6 text-center">
                      <p className="text-xs text-muted-foreground">No plugins active yet</p>
                    </div>}
                </div>
              </div>

              <div className="lg:col-span-1 space-y-3">
                <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Integrations</h2>
                <div className="space-y-2">
                  {integrationSummary.map(cfg => {
                const CfgIcon = cfg.logo;
                return <button key={cfg.id} onClick={() => onOpenIntegration(cfg.id)} className={`w-full flex items-center gap-3 p-3.5 rounded-xl border transition-all text-left shadow-sm hover:shadow-md ${cfg.connected ? 'bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/15' : 'bg-card border-dashed border-border hover:border-primary/40'}`}>
                        <div className={`p-2 rounded-lg ${cfg.connected ? 'bg-emerald-500/15' : 'bg-muted'}`}>
                          <CfgIcon size={14} className={cfg.connected ? 'text-emerald-500' : 'text-muted-foreground'} />
                        </div>
                        <div className="flex-grow min-w-0">
                          <p className="text-sm font-semibold truncate">{cfg.name}</p>
                          <p className="text-[10px] text-muted-foreground">{cfg.connected ? `${cfg.pluginCount} plugins unlocked` : 'Not connected'}</p>
                        </div>
                        {cfg.connected ? <CheckCircle2 size={14} className="text-emerald-500 shrink-0" /> : <Link2 size={14} className="text-muted-foreground/50 shrink-0" />}
                      </button>;
              })}
                </div>
              </div>

              <div className="lg:col-span-1 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Recent Activity</h2>
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <RefreshCw size={10} className="animate-spin" /><span>Live</span>
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
                    {MOCK_LOGS.slice(-8).map(log => <div key={log.id} className="flex gap-2 items-start">
                        <span className="text-slate-600 shrink-0">{log.timestamp}</span>
                        <span className={logLevelStyles[log.level]}>{log.message}</span>
                      </div>)}
                    <div ref={logEndRef} />
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
          </motion.div>}

        {activeTab === 'infrastructure' && <motion.div key="infrastructure" initial={{
        opacity: 0,
        y: 8
      }} animate={{
        opacity: 1,
        y: 0
      }} exit={{
        opacity: 0,
        y: -8
      }} transition={{
        duration: 0.2
      }} className="space-y-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h2 className="text-sm font-bold">Infrastructure Setup</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Select one plugin per category and configure project-level settings.</p>
              </div>
            </div>
            <InfrastructureTab project={project} />
          </motion.div>}

        {activeTab === 'deployments' && <motion.div key="deployments" initial={{
        opacity: 0,
        y: 8
      }} animate={{
        opacity: 1,
        y: 0
      }} exit={{
        opacity: 0,
        y: -8
      }} transition={{
        duration: 0.2
      }} className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Build History</h2>
              <button className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity">
                <Zap size={13} /><span>Trigger Build</span>
              </button>
            </div>
            <div className="space-y-3">
              {MOCK_DEPLOYMENTS.map(dep => {
            const cfg = deployStatusConfig[dep.status];
            return <div key={dep.id} className="bg-card border border-border rounded-xl p-5 shadow-sm flex items-center gap-5">
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
                          <GitBranch size={10} /><span>{dep.branch}</span>
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <span>Triggered by {dep.triggeredBy}</span>
                        <span className="mx-1.5">·</span>
                        <span>{new Date(dep.createdAt).toLocaleString()}</span>
                        {dep.duration && <span><span className="mx-1.5">·</span><span>{dep.duration}</span></span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-[10px] uppercase font-bold text-muted-foreground">{dep.platform}</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>
                      <button className="p-1.5 hover:bg-accent rounded transition-colors text-muted-foreground">
                        <ExternalLink size={13} />
                      </button>
                    </div>
                  </div>;
          })}
            </div>
          </motion.div>}
      </AnimatePresence>
    </motion.div>;
};

// --- PlatformStudio (main) ---

export const PlatformStudio = () => {
  const [activeView, setActiveView] = useState<'projects' | 'plugins' | 'settings' | 'project-detail'>('projects');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [connectedProviders, setConnectedProviders] = useState<ConnectedProviders>({
    firebase: true,
    expo: false,
    github: false
  });
  const [activeIntegration, setActiveIntegration] = useState<ProviderId | null>(null);
  const handleCreateProject = (_name: string, _bundleId: string, _type: AppType) => {
    setShowNewProjectModal(false);
  };
  const handleSelectProject = (project: Project) => {
    setSelectedProject(project);
    setActiveView('project-detail');
  };
  const handleBackToProjects = () => {
    setSelectedProject(null);
    setActiveView('projects');
  };
  const handleConnect = (providerId: ProviderId) => {
    setConnectedProviders(prev => ({
      ...prev,
      [providerId]: true
    }));
  };
  const handleDisconnect = (providerId: ProviderId) => {
    setConnectedProviders(prev => ({
      ...prev,
      [providerId]: false
    }));
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
      return INTEGRATION_CONFIGS.find(c => c.id === plugin.providerId) ?? null;
    }
    return null;
  };
  const activeIntegrationConfig = activeIntegration ? INTEGRATION_CONFIGS.find(c => c.id === activeIntegration) ?? null : null;
  const renderDashboard = () => <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Projects</h1>
          <p className="text-muted-foreground mt-1">Manage your mobile infrastructure fleet.</p>
        </div>
        <button onClick={() => setShowNewProjectModal(true)} className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg font-medium hover:opacity-90 transition-opacity shadow-sm">
          <Plus size={18} /><span>New Project</span>
        </button>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {MOCK_PROJECTS.map(project => <motion.div key={project.id} whileHover={{
        y: -4
      }} className="bg-card border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-all cursor-pointer group" onClick={() => handleSelectProject(project)}>
            <div className="flex justify-between items-start mb-4">
              <div className="bg-accent p-2 rounded-lg group-hover:bg-primary/10 transition-colors">
                <Smartphone className="text-primary" size={20} />
              </div>
              <Badge status={project.status}>{project.status.toUpperCase()}</Badge>
            </div>
            <h3 className="font-semibold text-lg">{project.name}</h3>
            <p className="text-sm text-muted-foreground font-mono mb-4">{project.bundleId}</p>
            <div className="flex gap-2 mb-6 flex-wrap">
              {project.plugins.map(p => <div key={p} className="bg-muted px-2 py-1 rounded text-[10px] uppercase font-bold text-muted-foreground">
                  {p.split('-')[0]}
                </div>)}
            </div>
            <div className="flex items-center justify-between pt-4 border-t border-border">
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock size={12} /><span>{new Date(project.updatedAt).toLocaleDateString()}</span>
              </span>
              <ChevronRight size={16} className="text-muted-foreground" />
            </div>
          </motion.div>)}
      </div>
    </div>;
  const renderPluginRegistry = () => <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Plugin Registry</h1>
          <p className="text-muted-foreground mt-1">
            <span>{ALL_REGISTRY_PLUGINS.length} plugins across {REGISTRY_CATEGORIES.length} categories.</span>
            <span className="mx-1.5">·</span>
            <span>Plugins may appear in multiple sections.</span>
          </p>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-3 flex-wrap">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mr-1">Integrations</p>
        {INTEGRATION_CONFIGS.map(cfg => {
        const connected = connectedProviders[cfg.id];
        const CfgIcon = cfg.logo;
        const pluginCount = PROVIDER_PLUGIN_MAP[cfg.id]?.length ?? 0;
        return <button key={cfg.id} onClick={() => setActiveIntegration(cfg.id)} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all hover:shadow-sm ${connected ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/15' : 'bg-muted/50 border-dashed border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'}`}>
              <CfgIcon size={13} className={connected ? 'text-emerald-500' : 'text-muted-foreground'} />
              <span>{cfg.name}</span>
              {connected ? <CheckCircle2 size={12} className="text-emerald-500" /> : <span className="text-[10px] font-bold text-muted-foreground bg-muted px-1 py-0.5 rounded">{pluginCount} plugins</span>}
            </button>;
      })}
      </div>

      <div className="space-y-10">
        {REGISTRY_CATEGORIES.map(category => {
        const CategoryIcon = category.icon;
        const plugins = ALL_REGISTRY_PLUGINS.filter(p => category.pluginIds.includes(p.id));
        return <section key={category.id}>
              <div className="flex items-center gap-3 mb-4">
                <div className={`p-2 rounded-lg bg-muted ${category.color}`}>
                  <CategoryIcon size={16} />
                </div>
                <h2 className="text-base font-bold tracking-tight">{category.label}</h2>
                <span className="text-[10px] font-bold text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{plugins.length} plugins</span>
                <div className="flex-grow h-px bg-border ml-2" />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {plugins.map(plugin => {
              const connected = isPluginConnected(plugin);
              const providerConfig = getProviderConfig(plugin);
              const crossCategories = plugin.categories.filter(c => c !== category.id);
              const isStudio = plugin.providerId === 'studio';
              return <div key={`${category.id}-${plugin.id}`} className={`relative bg-card rounded-xl p-5 flex flex-col transition-all ${plugin.future ? 'border border-border opacity-60' : connected ? 'border-2 border-emerald-500/50 shadow-sm hover:shadow-md' : 'border border-dashed border-border hover:border-primary/40 hover:shadow-sm'}`}>
                      {connected && !plugin.future && <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-t-xl" />}
                      <div className="flex items-start justify-between mb-3">
                        <div className={`p-2 rounded-lg ${connected && !plugin.future ? 'bg-emerald-500/10' : 'bg-accent'}`}>
                          <Code2 size={18} className={connected && !plugin.future ? 'text-emerald-500' : 'text-primary'} />
                        </div>
                        <div className="flex items-center gap-1.5">
                          {plugin.future && <span className="text-[9px] font-bold bg-muted text-muted-foreground px-1.5 py-0.5 rounded border border-border">SOON</span>}
                          {!plugin.future && connected && <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.5 rounded-full">
                              <CheckCircle2 size={9} /><span>CONNECTED</span>
                            </span>}
                          {!plugin.future && !connected && !isStudio && <span className="text-[9px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded-full">
                              NOT CONNECTED
                            </span>}
                          <span className="text-[10px] font-mono text-muted-foreground">v{plugin.version}</span>
                        </div>
                      </div>
                      <h3 className="font-bold text-sm mb-0.5">{plugin.name}</h3>
                      <p className="text-[11px] text-muted-foreground font-medium mb-2">{plugin.provider}</p>
                      <p className="text-xs text-muted-foreground leading-relaxed flex-grow mb-4">{plugin.description}</p>
                      {crossCategories.length > 0 && <div className="flex flex-wrap gap-1 mb-3">
                          {crossCategories.map(catId => <span key={catId} className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${CATEGORY_PILL_STYLE[catId] ?? 'bg-muted text-muted-foreground border-border'}`}>
                              <span>Also: </span><span>{CATEGORY_LABEL_MAP[catId] ?? catId}</span>
                            </span>)}
                        </div>}
                      {plugin.future ? <button disabled className="w-full py-2 text-xs font-bold border border-border rounded-lg text-muted-foreground cursor-not-allowed opacity-60">Coming Soon</button> : connected ? <button onClick={() => providerConfig && setActiveIntegration(providerConfig.id)} className="w-full py-2 text-xs font-bold border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 rounded-lg hover:bg-emerald-500/10 transition-colors flex items-center justify-center gap-1.5">
                          <CheckCircle2 size={12} /><span>{isStudio ? 'View Plugin Contract' : 'View Integration'}</span>
                        </button> : providerConfig ? <button onClick={() => setActiveIntegration(providerConfig.id)} className="w-full py-2 text-xs font-bold border border-dashed border-primary/40 text-primary rounded-lg hover:bg-primary/5 transition-colors flex items-center justify-center gap-1.5">
                          <Link2 size={12} /><span>Connect {providerConfig.name}</span><ArrowRight size={11} />
                        </button> : <button className="w-full py-2 text-xs font-bold border border-border rounded-lg hover:bg-accent transition-colors">View Plugin Contract</button>}
                    </div>;
            })}
              </div>
            </section>;
      })}
      </div>
    </div>;

  // dark class applied to root wrapper, bypassing the forced-light-mode in main.tsx
  return <div className={`flex h-screen w-screen overflow-hidden font-sans ${isDark ? 'dark' : ''}`}>
      <div className="flex h-full w-full bg-background text-foreground overflow-hidden">
        {/* Sidebar */}
        <motion.aside animate={{
        width: sidebarCollapsed ? 64 : 256
      }} transition={{
        duration: 0.25,
        ease: 'easeInOut'
      }} className="border-r border-border bg-card flex flex-col shrink-0 overflow-hidden">
          <div className={`p-4 border-b border-border flex items-center shrink-0 ${sidebarCollapsed ? 'justify-center' : 'justify-between'}`}>
            {!sidebarCollapsed && <div className="flex items-center gap-3 overflow-hidden">
                <div className="bg-primary w-8 h-8 rounded flex items-center justify-center text-primary-foreground shadow-sm shrink-0">
                  <Cpu size={18} />
                </div>
                <motion.span initial={false} animate={{
              opacity: 1
            }} className="font-bold text-base tracking-tight whitespace-nowrap">
                  Studio Core
                </motion.span>
              </div>}
            {sidebarCollapsed && <div className="bg-primary w-8 h-8 rounded flex items-center justify-center text-primary-foreground shadow-sm shrink-0">
                <Cpu size={18} />
              </div>}
            <button onClick={() => setSidebarCollapsed(c => !c)} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground transition-colors shrink-0" title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
              {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          </div>

          <nav className="flex-grow p-3 space-y-1 overflow-hidden">
            {!sidebarCollapsed && <div className="px-4 py-2 text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-1">Platform</div>}
            {sidebarCollapsed && <div className="h-3" />}
            <SidebarItem icon={LayoutDashboard} label="Projects" active={activeView === 'projects' || activeView === 'project-detail'} collapsed={sidebarCollapsed} onClick={handleBackToProjects} />
            <SidebarItem icon={Layers} label="Registry" active={activeView === 'plugins'} collapsed={sidebarCollapsed} onClick={() => setActiveView('plugins')} />
            <SidebarItem icon={Terminal} label="CLI / MCP" collapsed={sidebarCollapsed} onClick={() => {}} />
            {!sidebarCollapsed && <div className="px-4 py-2 text-[10px] font-bold text-muted-foreground uppercase tracking-widest mt-6 mb-1">Organization</div>}
            {sidebarCollapsed && <div className="h-4" />}
            <SidebarItem icon={Settings} label="Settings" active={activeView === 'settings'} collapsed={sidebarCollapsed} onClick={() => setActiveView('settings')} />
            <SidebarItem icon={Lock} label="Vault" collapsed={sidebarCollapsed} onClick={() => {}} />
          </nav>

          {activeView === 'project-detail' && selectedProject && !sidebarCollapsed && <div className="px-3 pb-2">
              <div className="bg-primary/10 border border-primary/20 rounded-lg p-2.5">
                <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider mb-0.5">Active Project</p>
                <p className="text-xs font-bold text-primary truncate">{selectedProject.name}</p>
                <p className="text-[10px] font-mono text-muted-foreground truncate">{selectedProject.bundleId}</p>
              </div>
            </div>}

          <div className={`p-3 border-t border-border mt-auto shrink-0 ${sidebarCollapsed ? 'flex justify-center' : ''}`}>
            {sidebarCollapsed ? <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center" title="Acme Mobile Eng">
                <User size={15} />
              </div> : <div className="flex items-center gap-3 bg-muted/50 p-3 rounded-lg">
                <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center shrink-0">
                  <User size={16} />
                </div>
                <div className="overflow-hidden">
                  <p className="text-xs font-bold truncate">Acme Mobile Eng</p>
                  <p className="text-[10px] text-muted-foreground">Admin Access</p>
                </div>
              </div>}
          </div>
        </motion.aside>

        {/* Main Content */}
        <main className="flex-grow overflow-y-auto relative bg-muted/20 min-w-0">
          <header className="sticky top-0 z-10 bg-background/80 backdrop-blur border-b border-border px-8 py-4 flex items-center justify-between">
            <div className="relative w-96">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
              <input type="text" placeholder="Search projects, plugins, secrets..." className="w-full bg-muted/50 border border-transparent rounded-lg py-1.5 pl-10 pr-4 text-sm focus:bg-background focus:border-border outline-none transition-all" />
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setIsDark(d => !d)} className="p-2 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground transition-all" title={isDark ? 'Switch to light mode' : 'Switch to dark mode'} aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
                <motion.div key={isDark ? 'sun' : 'moon'} initial={{
                rotate: -30,
                opacity: 0
              }} animate={{
                rotate: 0,
                opacity: 1
              }} exit={{
                rotate: 30,
                opacity: 0
              }} transition={{
                duration: 0.2
              }}>
                  {isDark ? <Sun size={18} /> : <Moon size={18} />}
                </motion.div>
              </button>
              <button className="relative p-2 hover:bg-accent rounded-full text-muted-foreground transition-colors">
                <Bell size={20} />
                <span className="w-2 h-2 bg-primary rounded-full border border-background inline-block ml-px" />
              </button>
              <div className="h-6 w-px bg-border" />
              <button className="flex items-center gap-2 text-sm font-medium hover:text-primary transition-colors">
                <ExternalLink size={16} /><span>Docs</span>
              </button>
            </div>
          </header>

          <div className="p-8">
            {activeView === 'projects' && renderDashboard()}
            {activeView === 'project-detail' && selectedProject && <ProjectOverview project={selectedProject} onBack={handleBackToProjects} connectedProviders={connectedProviders} onOpenIntegration={id => setActiveIntegration(id)} />}
            {activeView === 'plugins' && renderPluginRegistry()}
            {activeView === 'settings' && <div className="max-w-2xl animate-in fade-in slide-in-from-bottom-4 duration-500">
                <h1 className="text-3xl font-bold tracking-tight mb-8">Org Settings</h1>
                <div className="space-y-6">
                  <section className="bg-card border border-border rounded-xl p-6 shadow-sm">
                    <h3 className="font-bold mb-4">Secret Vault (Local Sync)</h3>
                    <div className="space-y-4">
                      {[{
                    id: 'gcp',
                    label: 'GCP Service Account'
                  }, {
                    id: 'gh',
                    label: 'GitHub PAT'
                  }, {
                    id: 'eas',
                    label: 'EAS Token'
                  }, {
                    id: 'apple',
                    label: 'Apple Team ID'
                  }].map(s => <div key={s.id} className="flex items-center justify-between p-3 border border-border rounded-lg bg-muted/30">
                          <div className="flex items-center gap-3">
                            <Lock size={16} className="text-muted-foreground" />
                            <span className="text-sm font-medium">{s.label}</span>
                          </div>
                          <span className="text-xs text-emerald-500 font-bold flex items-center gap-1">
                            <CheckCircle2 size={12} /><span>SYNCED</span>
                          </span>
                        </div>)}
                    </div>
                  </section>
                </div>
              </div>}
          </div>
        </main>

        {/* Integration Modal */}
        <AnimatePresence>
          {activeIntegration && activeIntegrationConfig && <IntegrationModal key={activeIntegration} config={activeIntegrationConfig} isConnected={connectedProviders[activeIntegration]} onClose={() => setActiveIntegration(null)} onConnect={handleConnect} onDisconnect={handleDisconnect} />}
        </AnimatePresence>

        {/* New Project Modal */}
        <AnimatePresence>
          {showNewProjectModal && <NewProjectModal onClose={() => setShowNewProjectModal(false)} onCreate={handleCreateProject} />}
        </AnimatePresence>
      </div>
    </div>;
};
export default PlatformStudio;