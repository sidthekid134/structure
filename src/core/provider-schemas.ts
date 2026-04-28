import type { ProviderType } from '../providers/types.js';
import type { ProviderBlueprint } from '../provisioning/graph.types.js';
import {
  FIREBASE_STEPS,
  GITHUB_STEPS,
  EAS_STEPS,
  APPLE_STEPS,
  GOOGLE_PLAY_STEPS,
  CLOUDFLARE_STEPS,
  OAUTH_STEPS,
  USER_ACTIONS,
} from '../provisioning/step-registry.js';
import { globalPluginRegistry } from '../plugins/plugin-registry.js';

const STATIC_PROVIDER_SECRET_SCHEMAS: Readonly<Record<string, string[]>> = {
  firebase: ['service_account_json', 'api_key', 'fcm_key'],
  github: ['token'],
  eas: ['eas_token', 'expo_token'],
  apple: ['certificate_pem', 'apns_key', 'p12_password'],
  'google-play': ['service_account_json', 'keystore_password'],
  cloudflare: ['api_token', 'zone_id'],
  oauth: ['client_id', 'client_secret'],
};

/** @deprecated Use getEffectiveProviderSecretSchemas() for registry-aware version */
export const PROVIDER_SECRET_SCHEMAS: Readonly<Record<ProviderType, string[]>> =
  STATIC_PROVIDER_SECRET_SCHEMAS as Readonly<Record<ProviderType, string[]>>;

/**
 * Returns provider secret schemas from the registry when bootstrapped,
 * falling back to static definitions.
 */
export function getEffectiveProviderSecretSchemas(): Readonly<Record<string, string[]>> {
  if (globalPluginRegistry.hasPlugin('firebase-core')) {
    const fromRegistry = globalPluginRegistry.getProviderSecretSchemas();
    return Object.keys(fromRegistry).length > 0 ? fromRegistry : STATIC_PROVIDER_SECRET_SCHEMAS;
  }
  return STATIC_PROVIDER_SECRET_SCHEMAS;
}

const STATIC_PROVIDER_DEPENDENCIES: Readonly<Record<string, string[]>> = {
  firebase: [],
  github: ['firebase'],
  eas: ['github'],
  apple: ['github'],
  'google-play': ['github'],
  cloudflare: [],
  oauth: ['firebase'],
};

/** @deprecated Use getEffectiveProviderDependencies() for registry-aware version */
export const PROVIDER_DEPENDENCIES: Readonly<Record<ProviderType, ProviderType[]>> =
  STATIC_PROVIDER_DEPENDENCIES as Readonly<Record<ProviderType, ProviderType[]>>;

/**
 * Returns provider dependency map from the registry when bootstrapped,
 * falling back to static definitions.
 */
export function getEffectiveProviderDependencies(): Readonly<Record<string, string[]>> {
  if (globalPluginRegistry.hasPlugin('firebase-core')) {
    const fromRegistry = globalPluginRegistry.getProviderDependencyMap();
    return Object.keys(fromRegistry).length > 0 ? fromRegistry : STATIC_PROVIDER_DEPENDENCIES;
  }
  return STATIC_PROVIDER_DEPENDENCIES;
}

export type IntegrationScope = 'organization' | 'project';

export interface IntegrationDependencyDescriptor {
  key: string;
  label: string;
  required: boolean;
  source: 'project' | 'organization' | 'integration';
  description: string;
}

export interface IntegrationPlannedResourceDescriptor {
  key: string;
  label: string;
  description: string;
  naming: string;
}

export interface IntegrationBlueprintDescriptor {
  provider: ProviderType;
  scope: IntegrationScope;
  dependencies: IntegrationDependencyDescriptor[];
  plannedResources: IntegrationPlannedResourceDescriptor[];
}

// ---------------------------------------------------------------------------
// New: ProviderBlueprint catalog — step-level representation
// ---------------------------------------------------------------------------

const STATIC_PROVIDER_BLUEPRINTS: Readonly<Record<string, ProviderBlueprint>> = {
  firebase: {
    provider: 'firebase',
    scope: 'project',
    steps: FIREBASE_STEPS,
    userActions: USER_ACTIONS.filter((a) => a.provider === 'firebase'),
  },
  github: {
    provider: 'github',
    scope: 'organization',
    steps: GITHUB_STEPS,
    userActions: USER_ACTIONS.filter((a) => a.provider === 'github'),
  },
  eas: {
    provider: 'eas',
    scope: 'organization',
    steps: EAS_STEPS,
    userActions: USER_ACTIONS.filter((a) => a.provider === 'eas'),
  },
  apple: {
    provider: 'apple',
    scope: 'organization',
    steps: APPLE_STEPS,
    userActions: USER_ACTIONS.filter((a) => a.provider === 'apple'),
  },
  'google-play': {
    provider: 'google-play',
    scope: 'organization',
    steps: GOOGLE_PLAY_STEPS,
    userActions: USER_ACTIONS.filter((a) => a.provider === 'google-play'),
  },
  cloudflare: {
    provider: 'cloudflare',
    scope: 'organization',
    steps: CLOUDFLARE_STEPS,
    userActions: USER_ACTIONS.filter((a) => a.provider === 'cloudflare'),
  },
  oauth: {
    provider: 'oauth',
    scope: 'project',
    steps: OAUTH_STEPS,
    userActions: [],
  },
};

/** @deprecated Use getEffectiveProviderBlueprints() for registry-aware version */
export const PROVIDER_BLUEPRINTS: Readonly<Record<ProviderType, ProviderBlueprint>> =
  STATIC_PROVIDER_BLUEPRINTS as Readonly<Record<ProviderType, ProviderBlueprint>>;

/**
 * Returns provider blueprints from the registry when bootstrapped,
 * falling back to static definitions.
 */
export function getEffectiveProviderBlueprints(): Readonly<Record<string, ProviderBlueprint>> {
  if (globalPluginRegistry.hasPlugin('firebase-core')) {
    const fromRegistry = globalPluginRegistry.getProviderBlueprints();
    return Object.keys(fromRegistry).length > 0 ? fromRegistry : STATIC_PROVIDER_BLUEPRINTS;
  }
  return STATIC_PROVIDER_BLUEPRINTS;
}

// ---------------------------------------------------------------------------
// Legacy: PROVIDER_INTEGRATION_BLUEPRINTS — kept for backward compat
// ---------------------------------------------------------------------------

/** @deprecated Use PROVIDER_BLUEPRINTS instead */
export const PROVIDER_INTEGRATION_BLUEPRINTS: Readonly<
  Record<ProviderType, IntegrationBlueprintDescriptor>
> = {
  firebase: {
    provider: 'firebase',
    scope: 'project',
    dependencies: [
      {
        key: 'bundle_id',
        label: 'Bundle ID',
        required: true,
        source: 'project',
        description: 'Used to register Firebase apps and mobile auth redirect configuration.',
      },
      {
        key: 'project_slug',
        label: 'Project Slug',
        required: true,
        source: 'project',
        description: 'Short identifier for GCP project IDs and other systems that do not allow hostnames.',
      },
      {
        key: 'project_domain',
        label: 'App Domain',
        required: true,
        source: 'project',
        description: 'Hostname from project creation (deep links, auth authorized domains, Cloudflare).',
      },
      {
        key: 'gcp_auth_method',
        label: 'GCP Authentication',
        required: true,
        source: 'integration',
        description: 'Either Google OAuth bootstrap or manual service-account JSON key.',
      },
    ],
    plannedResources: [
      {
        key: 'gcp_project',
        label: 'GCP Project',
        description: 'Project is created or reused as the backing infrastructure container.',
        naming: 'st-<project-slug>-<hash6>',
      },
      {
        key: 'provisioner_service_account',
        label: 'Provisioner Service Account',
        description: 'Service account used for project-scoped provisioning operations.',
        naming: 'platform-provisioner@<gcp-project-id>.iam.gserviceaccount.com',
      },
      {
        key: 'provisioner_service_account_key',
        label: 'Provisioner Service Account Key',
        description: 'JSON key generated once and stored in the encrypted local vault.',
        naming: '<studio-project-id>/service_account_json',
      },
    ],
  },
  github: {
    provider: 'github',
    scope: 'organization',
    dependencies: [
      {
        key: 'github_pat',
        label: 'GitHub Token',
        required: true,
        source: 'integration',
        description: 'Personal access token with repo and workflow scopes.',
      },
    ],
    plannedResources: [
      {
        key: 'github_identity',
        label: 'GitHub Identity Sync',
        description: 'Studio verifies username and org memberships for automation context.',
        naming: 'credential_vault/github::*',
      },
    ],
  },
  eas: {
    provider: 'eas',
    scope: 'organization',
    dependencies: [
      {
        key: 'expo_token',
        label: 'Expo Robot Token',
        required: true,
        source: 'integration',
        description: 'Token used to authenticate EAS build and submit workflows.',
      },
      {
        key: 'project_slug',
        label: 'Project Slug',
        required: true,
        source: 'project',
        description: 'Used as the EAS / Expo project name (hostnames are not valid there).',
      },
    ],
    plannedResources: [
      {
        key: 'expo_identity',
        label: 'Expo Identity Sync',
        description: 'Studio verifies account identity and available account memberships.',
        naming: 'credential_vault/eas::*',
      },
    ],
  },
  apple: {
    provider: 'apple',
    scope: 'organization',
    dependencies: [
      {
        key: 'bundle_id',
        label: 'Bundle ID',
        required: true,
        source: 'project',
        description: 'iOS bundle identifier used across Apple Developer, App Store Connect, and EAS.',
      },
      {
        key: 'project_domain',
        label: 'App Domain',
        required: true,
        source: 'project',
        description: 'Domain used for Universal Links and apple-app-site-association hosting.',
      },
      {
        key: 'apple_team_id',
        label: 'Apple Team ID',
        required: true,
        source: 'integration',
        description: '10-character Apple Developer Team ID required for signing and Sign In with Apple.',
      },
      {
        key: 'default_test_users',
        label: 'Default Test Users',
        required: false,
        source: 'integration',
        description: 'Optional QA tester emails / Apple IDs for TestFlight and auth validation.',
      },
    ],
    plannedResources: [
      {
        key: 'apple_signing_assets',
        label: 'Apple Signing Assets',
        description: 'Certificates, provisioning profiles, APNs key, and ASC API key material.',
        naming: 'apple/{bundle_id}',
      },
      {
        key: 'testflight_distribution',
        label: 'TestFlight Distribution',
        description: 'App Store Connect app and submission credentials used by EAS Submit.',
        naming: 'asc/{bundle_id}',
      },
    ],
  },
  'google-play': {
    provider: 'google-play',
    scope: 'organization',
    dependencies: [],
    plannedResources: [],
  },
  cloudflare: {
    provider: 'cloudflare',
    scope: 'organization',
    dependencies: [
      {
        key: 'cloudflare_token',
        label: 'Cloudflare API Token',
        required: true,
        source: 'integration',
        description:
          'Token with zone-scoped permissions for DNS Edit, Zone Read, Page Rules Edit, and Zone Settings/SSL Edit used for ownership checks, DNS, SSL, and auth routing automation.',
      },
      {
        key: 'project_domain',
        label: 'App Domain',
        required: true,
        source: 'project',
        description: 'Zone and DNS records use the hostname from project creation.',
      },
      {
        key: 'project_slug',
        label: 'Project Slug',
        required: true,
        source: 'project',
        description: 'Short identifier for resource names that cannot use the full domain.',
      },
    ],
    plannedResources: [],
  },
  oauth: {
    provider: 'oauth',
    scope: 'project',
    dependencies: [
      {
        key: 'project_domain',
        label: 'App Domain',
        required: true,
        source: 'project',
        description: 'Redirect URIs and Firebase authorized domains use this hostname.',
      },
      {
        key: 'project_slug',
        label: 'Project Slug',
        required: true,
        source: 'project',
        description: 'Fallback naming where a hostname is not allowed.',
      },
    ],
    plannedResources: [],
  },
};
