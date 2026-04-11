import type { PluginDefinition } from '../plugin-types.js';
import { OAUTH_STEPS } from '../../provisioning/step-registry.js';

export const oauthSocialPlugin: PluginDefinition = {
  id: 'oauth-social',
  version: '1.0.0',
  label: 'Social OAuth & Deep Links',
  description: 'Apple Sign-In service ID and deep link domain configuration.',
  provider: 'oauth',
  requiredModules: ['firebase-auth'],
  optionalModules: ['cloudflare-domain', 'apple-signing'],
  includedInTemplates: ['mobile-app'],
  steps: [
    OAUTH_STEPS.find((s) => s.key === 'oauth:configure-apple-sign-in')!,
    OAUTH_STEPS.find((s) => s.key === 'oauth:link-deep-link-domain')!,
  ],
  teardownSteps: [],
  userActions: [],
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
  functionGroup: {
    id: 'auth',
    label: 'Authentication',
    description: 'Social sign-in and OAuth configuration',
    order: 5,
  },
};
