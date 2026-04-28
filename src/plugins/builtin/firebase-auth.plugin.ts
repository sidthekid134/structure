import type { PluginDefinition } from '../plugin-types.js';
import { FIREBASE_STEPS, OAUTH_STEPS, OAUTH_TEARDOWN_STEPS } from '../../provisioning/step-registry.js';

export const firebaseAuthPlugin: PluginDefinition = {
  id: 'firebase-auth',
  version: '1.0.0',
  label: 'Firebase Auth',
  description: 'Enable auth providers and configure redirect domains.',
  provider: 'oauth',
  providerMeta: {
    label: 'OAuth',
    scope: 'project',
    secretKeys: ['client_id', 'client_secret'],
    dependsOnProviders: ['firebase'],
    displayMeta: {
      label: 'OAuth',
      color: 'text-violet-500',
      bg: 'bg-violet-500/10',
      border: 'border-violet-500/30',
    },
  },
  requiredModules: ['firebase-core'],
  optionalModules: ['oauth-social'],
  includedInTemplates: ['mobile-app', 'web-app', 'api-backend'],
  steps: [
    FIREBASE_STEPS.find((s) => s.key === 'firebase:enable-auth')!,
    OAUTH_STEPS.find((s) => s.key === 'oauth:enable-auth-providers')!,
    OAUTH_STEPS.find((s) => s.key === 'oauth:enable-google-sign-in')!,
    OAUTH_STEPS.find((s) => s.key === 'oauth:register-oauth-client-web')!,
    OAUTH_STEPS.find((s) => s.key === 'oauth:register-oauth-client-ios')!,
    OAUTH_STEPS.find((s) => s.key === 'oauth:register-oauth-client-android')!,
    OAUTH_STEPS.find((s) => s.key === 'oauth:configure-redirect-uris')!,
  ],
  teardownSteps: [
    OAUTH_TEARDOWN_STEPS.find((s) => s.key === 'oauth:disable-auth-providers')!,
    OAUTH_TEARDOWN_STEPS.find((s) => s.key === 'oauth:delete-oauth-clients')!,
  ],
  userActions: [],
  displayMeta: {
    icon: 'ShieldCheck',
    colors: {
      primary: 'violet-500',
      text: 'text-violet-700 dark:text-violet-300',
      bg: 'bg-violet-500/10',
      border: 'border-violet-500/25',
    },
  },
  defaultJourneyPhase: 'oauth',
  resourceDisplay: {
    google_sign_in_enabled: {
      relatedLinks: [
        { label: 'Firebase Auth Console', href: 'https://console.firebase.google.com/project/_/authentication/providers' },
      ],
    },
    oauth_client_id_ios: {
      relatedLinks: [
        { label: 'Google Cloud Console', href: 'https://console.cloud.google.com/apis/credentials' },
      ],
    },
    oauth_client_id_android: {
      relatedLinks: [
        { label: 'Google Cloud Console', href: 'https://console.cloud.google.com/apis/credentials' },
      ],
    },
    oauth_client_id_web: {
      relatedLinks: [
        { label: 'Google Cloud Console', href: 'https://console.cloud.google.com/apis/credentials' },
      ],
    },
    oauth_redirect_uri_primary: {
      relatedLinks: [
        {
          label: 'Firebase Auth settings',
          hrefTemplate:
            'https://console.firebase.google.com/project/{upstream.firebase_project_id}/authentication/settings',
        },
      ],
    },
    oauth_redirect_uri_firebase: {
      relatedLinks: [
        {
          label: 'Firebase Auth settings',
          hrefTemplate:
            'https://console.firebase.google.com/project/{upstream.firebase_project_id}/authentication/settings',
        },
      ],
    },
    oauth_authorized_domain_primary: {
      relatedLinks: [
        {
          label: 'Firebase Authorized domains',
          hrefTemplate:
            'https://console.firebase.google.com/project/{upstream.firebase_project_id}/authentication/settings',
        },
        {
          label: 'Open domain',
          hrefTemplate: 'https://{value}',
        },
      ],
    },
    oauth_authorized_domain_deep_link: {
      relatedLinks: [
        {
          label: 'Firebase Authorized domains',
          hrefTemplate:
            'https://console.firebase.google.com/project/{upstream.firebase_project_id}/authentication/settings',
        },
        {
          label: 'Open deep link host',
          hrefTemplate: 'https://{value}',
        },
      ],
    },
  },
  completionPortalLinks: {
    'oauth:configure-redirect-uris': [
      {
        label: 'Firebase Auth settings',
        hrefTemplate:
          'https://console.firebase.google.com/project/{upstream.firebase_project_id}/authentication/settings',
      },
      {
        label: 'Google Cloud OAuth credentials',
        hrefTemplate:
          'https://console.cloud.google.com/apis/credentials?project={upstream.gcp_project_id}',
      },
    ],
  },
  functionGroup: {
    id: 'firebase',
    label: 'Firebase & GCP',
    description: 'Firebase services and Google Cloud infrastructure',
    order: 1,
  },
};
