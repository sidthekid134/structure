import type { PluginDefinition } from '../plugin-types.js';
import { EAS_STEPS, EAS_TEARDOWN_STEPS } from '../../provisioning/step-registry.js';

export const easSubmitPlugin: PluginDefinition = {
  id: 'eas-submit',
  version: '1.0.0',
  label: 'Store Submission',
  description: 'Configure App Store and Google Play upload targets for EAS Submit.',
  integrationId: 'eas',
  provider: 'eas',
  requiredModules: ['eas-builds', 'github-ci'],
  optionalModules: ['apple-signing', 'google-play-publishing'],
  // This module owns both iOS and Android sub-steps; the planner filters
  // individual steps via their own `platforms` mask.
  platforms: ['ios', 'android'],
  moduleHints: [
    {
      kind: 'scope',
      label: 'Mobile release only',
      description: 'EAS Submit is only useful for projects that publish iOS or Android builds.',
      platforms: ['ios', 'android'],
    },
    {
      kind: 'requires',
      label: 'CI/CD must be present',
      description: 'Submit targets are configured alongside the GitHub workflow and environment secrets.',
      moduleIds: ['github-ci'],
    },
    {
      kind: 'platform',
      label: 'iOS path',
      description: 'App Store uploads need Apple signing and App Store Connect credentials.',
      moduleIds: ['apple-signing'],
      platforms: ['ios'],
    },
    {
      kind: 'platform',
      label: 'Android path',
      description: 'Google Play uploads need Play Console publishing and Android signing setup.',
      moduleIds: ['google-play-publishing'],
      platforms: ['android'],
    },
  ],
  includedInTemplates: ['mobile-app'],
  steps: [
    EAS_STEPS.find((s) => s.key === 'eas:configure-submit-apple')!,
    EAS_STEPS.find((s) => s.key === 'eas:configure-submit-android')!,
  ],
  teardownSteps: [
    EAS_TEARDOWN_STEPS.find((s) => s.key === 'eas:remove-submit-targets')!,
  ],
  userActions: [],
  displayMeta: {
    icon: 'Upload',
    colors: {
      primary: 'indigo-500',
      text: 'text-indigo-700 dark:text-indigo-300',
      bg: 'bg-indigo-500/10',
      border: 'border-indigo-500/25',
    },
  },
  defaultJourneyPhase: 'mobile_build',
  completionPortalLinks: {
    'eas:configure-submit-apple': [
      { label: 'App Store Connect', href: 'https://appstoreconnect.apple.com/' },
      { label: 'TestFlight', href: 'https://appstoreconnect.apple.com/apps' },
      { label: 'EAS Submit docs', href: 'https://docs.expo.dev/submit/introduction/' },
    ],
  },
  functionGroup: {
    id: 'mobile',
    label: 'Mobile & App Stores',
    description: 'Mobile build, signing, and store publishing',
    order: 3,
  },
};
