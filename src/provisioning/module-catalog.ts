import type { ProviderType } from '../providers/types.js';

export type ModuleId =
  | 'firebase-core'
  | 'firebase-auth'
  | 'firebase-firestore'
  | 'firebase-storage'
  | 'firebase-messaging'
  | 'github-repo'
  | 'github-ci'
  | 'eas-builds'
  | 'eas-submit'
  | 'apple-signing'
  | 'google-play-publishing'
  | 'cloudflare-domain'
  | 'oauth-social';

export interface ModuleDefinition {
  id: ModuleId;
  label: string;
  description: string;
  provider: ProviderType;
  requiredModules: ModuleId[];
  optionalModules: ModuleId[];
  stepKeys: string[];
  teardownStepKeys: string[];
  /** User-action node keys that belong to this module (for UI attribution). */
  userActionKeys?: string[];
}

export type ProjectTemplateId = 'mobile-app' | 'web-app' | 'api-backend' | 'custom';

export interface ProjectTemplate {
  id: ProjectTemplateId;
  label: string;
  description: string;
  modules: ModuleId[];
}

export const MODULE_CATALOG: Readonly<Record<ModuleId, ModuleDefinition>> = {
  'firebase-core': {
    id: 'firebase-core',
    label: 'Firebase Core',
    description: 'Create the GCP/Firebase project and provisioner identity.',
    provider: 'firebase',
    requiredModules: [],
    optionalModules: ['firebase-auth', 'firebase-firestore', 'firebase-storage', 'firebase-messaging'],
    stepKeys: [
      'firebase:create-gcp-project',
      'firebase:enable-firebase',
      'firebase:create-provisioner-sa',
      'firebase:bind-provisioner-iam',
      'firebase:generate-sa-key',
      'firebase:register-ios-app',
      'firebase:register-android-app',
    ],
    teardownStepKeys: ['firebase:delete-gcp-project'],
    userActionKeys: ['user:setup-gcp-billing'],
  },
  'firebase-auth': {
    id: 'firebase-auth',
    label: 'Firebase Auth',
    description: 'Enable auth providers and configure redirect domains.',
    provider: 'oauth',
    requiredModules: ['firebase-core'],
    optionalModules: ['oauth-social'],
    stepKeys: ['oauth:enable-auth-providers', 'oauth:register-oauth-clients', 'oauth:configure-redirect-uris'],
    teardownStepKeys: ['oauth:disable-auth-providers'],
  },
  'firebase-firestore': {
    id: 'firebase-firestore',
    label: 'Firestore',
    description: 'Enable Firebase services and deploy Firestore rules.',
    provider: 'firebase',
    requiredModules: ['firebase-core'],
    optionalModules: [],
    stepKeys: ['firebase:enable-services', 'firebase:configure-firestore-rules'],
    teardownStepKeys: ['firebase:delete-firestore-data'],
  },
  'firebase-storage': {
    id: 'firebase-storage',
    label: 'Cloud Storage',
    description: 'Deploy storage rules for configured environments.',
    provider: 'firebase',
    requiredModules: ['firebase-core'],
    optionalModules: [],
    stepKeys: ['firebase:enable-services', 'firebase:configure-storage-rules'],
    teardownStepKeys: ['firebase:delete-storage-buckets'],
  },
  'firebase-messaging': {
    id: 'firebase-messaging',
    label: 'Push Notifications',
    description: 'Configure FCM/APNs and mobile signing integration.',
    provider: 'firebase',
    requiredModules: ['firebase-core', 'apple-signing', 'google-play-publishing'],
    optionalModules: [],
    stepKeys: ['firebase:enable-services', 'apple:upload-apns-to-firebase', 'google-play:add-fingerprints-to-firebase'],
    teardownStepKeys: ['firebase:disable-messaging'],
  },
  'github-repo': {
    id: 'github-repo',
    label: 'GitHub Repository',
    description: 'Create the repository and core integration metadata.',
    provider: 'github',
    requiredModules: [],
    optionalModules: ['github-ci'],
    stepKeys: ['github:create-repository', 'github:create-environments'],
    teardownStepKeys: ['github:delete-repository'],
    userActionKeys: ['user:provide-github-pat'],
  },
  'github-ci': {
    id: 'github-ci',
    label: 'GitHub CI/CD',
    description: 'Deploy workflows and environment secrets.',
    provider: 'github',
    requiredModules: ['github-repo', 'firebase-core'],
    optionalModules: ['eas-builds'],
    stepKeys: ['github:inject-secrets', 'github:deploy-workflows'],
    teardownStepKeys: ['github:delete-workflows', 'github:delete-environments'],
  },
  'eas-builds': {
    id: 'eas-builds',
    label: 'EAS Builds',
    description: 'Register project with EAS and configure build profiles.',
    provider: 'eas',
    requiredModules: ['github-repo'],
    optionalModules: ['eas-submit'],
    stepKeys: ['eas:create-project', 'eas:configure-build-profiles', 'eas:store-token-in-github'],
    teardownStepKeys: ['eas:delete-project'],
    userActionKeys: ['user:provide-expo-token', 'user:install-expo-github-app'],
  },
  'eas-submit': {
    id: 'eas-submit',
    label: 'EAS Submit',
    description: 'Configure Apple and Android app submission from EAS.',
    provider: 'eas',
    requiredModules: ['eas-builds', 'apple-signing', 'google-play-publishing'],
    optionalModules: [],
    stepKeys: ['eas:configure-submit-apple', 'eas:configure-submit-android'],
    teardownStepKeys: ['eas:remove-submit-targets'],
  },
  'apple-signing': {
    id: 'apple-signing',
    label: 'Apple Signing',
    description: 'Provision Apple app IDs, profiles, and submission credentials.',
    provider: 'apple',
    requiredModules: [],
    optionalModules: ['eas-submit'],
    stepKeys: [
      'apple:register-app-id',
      'apple:create-dev-provisioning-profile',
      'apple:create-dist-provisioning-profile',
      'apple:generate-apns-key',
      'apple:create-app-store-listing',
      'apple:generate-asc-api-key',
      'apple:store-signing-in-eas',
    ],
    teardownStepKeys: ['apple:remove-app-store-listing', 'apple:revoke-signing-assets'],
    userActionKeys: ['user:enroll-apple-developer'],
  },
  'google-play-publishing': {
    id: 'google-play-publishing',
    label: 'Google Play Publishing',
    description: 'Set up Play app, signing, and service account automation.',
    provider: 'google-play',
    requiredModules: ['firebase-core'],
    optionalModules: ['eas-submit'],
    stepKeys: [
      'google-play:create-app-listing',
      'google-play:create-service-account',
      'google-play:setup-internal-testing',
      'google-play:configure-app-signing',
      'google-play:extract-fingerprints',
    ],
    teardownStepKeys: ['google-play:remove-app-listing', 'google-play:revoke-service-account'],
    userActionKeys: ['user:enroll-google-play', 'user:upload-initial-aab'],
  },
  'cloudflare-domain': {
    id: 'cloudflare-domain',
    label: 'Cloudflare Domain',
    description: 'Configure DNS, SSL, and deep-link route hosting.',
    provider: 'cloudflare',
    requiredModules: [],
    optionalModules: ['oauth-social'],
    stepKeys: [
      'cloudflare:add-domain-zone',
      'cloudflare:configure-dns',
      'cloudflare:configure-ssl',
      'cloudflare:configure-deep-link-routes',
      'cloudflare:setup-apple-app-site-association',
      'cloudflare:setup-android-asset-links',
    ],
    teardownStepKeys: ['cloudflare:remove-domain-zone'],
    userActionKeys: ['user:confirm-dns-nameservers'],
  },
  'oauth-social': {
    id: 'oauth-social',
    label: 'OAuth Social Login',
    description: 'Configure Google/Apple sign-in flows with deep-link support.',
    provider: 'oauth',
    requiredModules: ['firebase-auth', 'cloudflare-domain'],
    optionalModules: ['apple-signing'],
    stepKeys: ['oauth:configure-apple-sign-in', 'oauth:link-deep-link-domain'],
    teardownStepKeys: ['oauth:delete-oauth-clients'],
  },
};

export const PROJECT_TEMPLATES: Readonly<Record<ProjectTemplateId, ProjectTemplate>> = {
  'mobile-app': {
    id: 'mobile-app',
    label: 'Mobile App',
    description: 'Cross-platform mobile template with build and store automation.',
    modules: [
      'firebase-core',
      'firebase-auth',
      'firebase-firestore',
      'firebase-storage',
      'firebase-messaging',
      'github-repo',
      'github-ci',
      'eas-builds',
      'eas-submit',
      'apple-signing',
      'google-play-publishing',
      'cloudflare-domain',
      'oauth-social',
    ],
  },
  'web-app': {
    id: 'web-app',
    label: 'Web App',
    description: 'Web-focused app with auth, data, CI, and managed DNS.',
    modules: [
      'firebase-core',
      'firebase-auth',
      'firebase-firestore',
      'firebase-storage',
      'github-repo',
      'github-ci',
      'cloudflare-domain',
      'oauth-social',
    ],
  },
  'api-backend': {
    id: 'api-backend',
    label: 'API Backend',
    description: 'Backend infrastructure with data, auth, and CI foundations.',
    modules: ['firebase-core', 'firebase-auth', 'firebase-firestore', 'github-repo', 'github-ci'],
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    description: 'Start from scratch and choose modules manually.',
    modules: [],
  },
};

export const DEFAULT_MODULE_IDS: ModuleId[] = PROJECT_TEMPLATES['mobile-app'].modules;

export function resolveModuleDependencies(moduleIds: ModuleId[]): ModuleId[] {
  const seen = new Set<ModuleId>();
  const visiting = new Set<ModuleId>();

  const visit = (moduleId: ModuleId) => {
    if (seen.has(moduleId)) return;
    if (visiting.has(moduleId)) {
      throw new Error(`Circular module dependency detected at "${moduleId}".`);
    }

    const module = MODULE_CATALOG[moduleId];
    if (!module) {
      throw new Error(`Unknown module "${moduleId}".`);
    }

    visiting.add(moduleId);
    for (const requiredModule of module.requiredModules) {
      visit(requiredModule);
    }
    visiting.delete(moduleId);
    seen.add(moduleId);
  };

  for (const moduleId of moduleIds) {
    visit(moduleId);
  }

  return Array.from(seen);
}

export function getProvidersForModules(moduleIds: ModuleId[]): ProviderType[] {
  const providers = new Set<ProviderType>();
  for (const moduleId of resolveModuleDependencies(moduleIds)) {
    providers.add(MODULE_CATALOG[moduleId].provider);
  }
  return Array.from(providers);
}

export function getStepKeysForModules(moduleIds: ModuleId[]): string[] {
  const stepKeys = new Set<string>();
  for (const moduleId of resolveModuleDependencies(moduleIds)) {
    for (const stepKey of MODULE_CATALOG[moduleId].stepKeys) {
      stepKeys.add(stepKey);
    }
  }
  return Array.from(stepKeys);
}

export function getTeardownStepKeysForModules(moduleIds: ModuleId[]): string[] {
  const stepKeys = new Set<string>();
  for (const moduleId of resolveModuleDependencies(moduleIds)) {
    for (const stepKey of MODULE_CATALOG[moduleId].teardownStepKeys) {
      stepKeys.add(stepKey);
    }
  }
  return Array.from(stepKeys);
}
