import type { PluginDefinition } from '../plugin-types.js';
import { EAS_STEPS, EAS_TEARDOWN_STEPS, USER_ACTIONS } from '../../provisioning/step-registry.js';
import { EAS_STEP_HANDLERS } from '../../provisioning/eas-step-handlers.js';

export const easBuildsPlugin: PluginDefinition = {
  id: 'eas-builds',
  version: '1.0.0',
  label: 'EAS Builds',
  description: 'Register project with EAS and configure build profiles.',
  provider: 'eas',
  providerMeta: {
    label: 'EAS',
    scope: 'organization',
    secretKeys: ['eas_token', 'expo_token'],
    dependsOnProviders: ['github'],
    displayMeta: {
      label: 'EAS',
      color: 'text-indigo-500',
      bg: 'bg-indigo-500/10',
      border: 'border-indigo-500/30',
    },
  },
  requiredModules: ['github-repo'],
  optionalModules: ['eas-submit'],
  includedInTemplates: ['mobile-app'],
  steps: [
    EAS_STEPS.find((s) => s.key === 'eas:create-project')!,
    EAS_STEPS.find((s) => s.key === 'eas:configure-build-profiles')!,
    EAS_STEPS.find((s) => s.key === 'eas:sync-runtime-env')!,
    EAS_STEPS.find((s) => s.key === 'eas:store-token-in-github')!,
    EAS_STEPS.find((s) => s.key === 'eas:write-eas-json')!,
  ],
  teardownSteps: [
    EAS_TEARDOWN_STEPS.find((s) => s.key === 'eas:delete-project')!,
  ],
  userActions: [
    USER_ACTIONS.find((a) => a.key === 'user:provide-expo-token')!,
    USER_ACTIONS.find((a) => a.key === 'user:install-expo-github-app')!,
  ],
  stepHandlers: EAS_STEP_HANDLERS,
  displayMeta: {
    icon: 'Smartphone',
    colors: {
      primary: 'indigo-500',
      text: 'text-indigo-700 dark:text-indigo-300',
      bg: 'bg-indigo-500/10',
      border: 'border-indigo-500/25',
    },
  },
  defaultJourneyPhase: 'mobile_build',
  resourceDisplay: {
    eas_project_id: {
      primaryHrefTemplate: 'https://expo.dev/projects/{value}',
      relatedLinks: [{ label: 'Expo dashboard', href: 'https://expo.dev/' }],
    },
    expo_token: {
      sensitive: true,
    },
  },
  completionPortalLinks: {
    'user:provide-expo-token': [
      { label: 'Expo access tokens', href: 'https://expo.dev/settings/access-tokens' },
    ],
    'user:install-expo-github-app': [
      {
        label: 'Expo GitHub integration docs',
        href: 'https://docs.expo.dev/eas-update/github-integration/',
      },
      { label: 'GitHub repository', hrefTemplate: '{upstream.github_repo_url}' },
      { label: 'Expo account settings', href: 'https://expo.dev/settings' },
    ],
  },
  stepCapabilities: {
    'eas:create-project': {
      supportsRevalidate: true,
      supportsSync: true,
      supportsRevert: true,
      supportsManualRevert: false,
    },
  },
  functionGroup: {
    id: 'mobile',
    label: 'Mobile & App Stores',
    description: 'Mobile build, signing, and store publishing',
    order: 3,
  },
};
