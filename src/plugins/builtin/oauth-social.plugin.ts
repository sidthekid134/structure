import type { PluginDefinition } from '../plugin-types.js';
import { APPLE_STEPS, OAUTH_STEPS, USER_ACTIONS } from '../../provisioning/step-registry.js';

export const oauthSocialPlugin: PluginDefinition = {
  id: 'oauth-social',
  version: '1.0.0',
  label: 'Social OAuth & Deep Links',
  description:
    'Apple Sign-In credential creation + Firebase provider wiring, and deep link domain configuration for mobile auth.',
  integrationId: 'gcp',
  provider: 'oauth',
  requiredModules: ['firebase-auth'],
  optionalModules: ['cloudflare-domain', 'apple-signing'],
  includedInTemplates: ['mobile-app'],
  steps: [
    // Apple-side preparation lives in APPLE_STEPS but is added here so it is
    // only included in projects that opt into social OAuth. Pairs with
    // oauth:configure-apple-sign-in below, which consumes the vaulted
    // credentials.
    APPLE_STEPS.find((s) => s.key === 'apple:create-sign-in-key')!,
    OAUTH_STEPS.find((s) => s.key === 'oauth:configure-apple-sign-in')!,
    OAUTH_STEPS.find((s) => s.key === 'oauth:link-deep-link-domain')!,
    OAUTH_STEPS.find((s) => s.key === 'oauth:prepare-app-integration-kit')!,
  ],
  teardownSteps: [],
  userActions: [USER_ACTIONS.find((a) => a.key === 'user:verify-auth-integration-kit')!],
  displayMeta: {
    icon: 'KeyRound',
    colors: {
      primary: 'violet-500',
      text: 'text-violet-700 dark:text-violet-300',
      bg: 'bg-violet-500/10',
      border: 'border-violet-500/25',
    },
  },
  defaultJourneyPhase: 'oauth',
  journeyPhaseOverrides: {
    'oauth:link-deep-link-domain': 'deep_links',
  },
  resourceDisplay: {
    apple_sign_in_service_id: {
      relatedLinks: [
        { label: 'Apple Developer', href: 'https://developer.apple.com/account/resources/identifiers/list' },
      ],
    },
  },
  completionPortalLinks: {
    'apple:create-sign-in-key': [
      {
        label: 'Apple Services IDs (where the Service ID lives)',
        href: 'https://developer.apple.com/account/resources/identifiers/list/serviceId',
      },
      {
        label: 'Apple Developer Keys (where the .p8 sign-in key lives)',
        href: 'https://developer.apple.com/account/resources/authkeys/list',
      },
    ],
    'oauth:configure-apple-sign-in': [
      {
        label: 'Firebase Auth providers',
        href: 'https://console.firebase.google.com/',
      },
      {
        label: 'Apple Services IDs (verify return URL)',
        href: 'https://developer.apple.com/account/resources/identifiers/list/serviceId',
      },
    ],
    'oauth:link-deep-link-domain': [
      {
        label: 'Firebase Auth authorized domains',
        href: 'https://console.firebase.google.com/',
      },
      {
        label: 'Expo auth + deep linking guide',
        href: 'https://docs.expo.dev/guides/authentication/',
      },
    ],
    'oauth:prepare-app-integration-kit': [
      {
        label: 'Open your app repository',
        hrefTemplate: '{upstream.github_repo_url}',
      },
    ],
  },
  functionGroup: {
    id: 'auth',
    label: 'Authentication',
    description: 'Social sign-in and OAuth configuration',
    order: 5,
  },
};
