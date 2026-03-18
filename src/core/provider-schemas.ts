import type { ProviderType } from '../providers/types.js';

export const PROVIDER_SECRET_SCHEMAS: Readonly<Record<ProviderType, string[]>> = {
  firebase: ['service_account_json', 'api_key', 'fcm_key'],
  github: ['token', 'webhook_secret'],
  eas: ['eas_token', 'expo_token'],
  apple: ['certificate_pem', 'apns_key', 'p12_password'],
  'google-play': ['service_account_json', 'keystore_password'],
  cloudflare: ['api_token', 'zone_id'],
  oauth: ['client_id', 'client_secret'],
};

export const PROVIDER_DEPENDENCIES: Readonly<Record<ProviderType, ProviderType[]>> = {
  firebase: [],
  github: ['firebase'],
  eas: ['github'],
  apple: ['github'],
  'google-play': ['github'],
  cloudflare: [],
  oauth: ['firebase'],
};

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
        description: 'Used to standardize generated GCP project naming.',
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
    dependencies: [],
    plannedResources: [],
  },
  'google-play': {
    provider: 'google-play',
    scope: 'organization',
    dependencies: [],
    plannedResources: [],
  },
  cloudflare: {
    provider: 'cloudflare',
    scope: 'project',
    dependencies: [],
    plannedResources: [],
  },
  oauth: {
    provider: 'oauth',
    scope: 'project',
    dependencies: [],
    plannedResources: [],
  },
};
