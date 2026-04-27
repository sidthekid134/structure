import type { PluginDefinition } from '../plugin-types.js';
import {
  GOOGLE_PLAY_STEPS,
  GOOGLE_PLAY_TEARDOWN_STEPS,
  USER_ACTIONS,
} from '../../provisioning/step-registry.js';
import { GOOGLE_PLAY_FLOW } from '../../flows/google-play.flow.js';

export const googlePlayPlugin: PluginDefinition = {
  id: 'google-play-publishing',
  version: '1.0.0',
  label: 'Google Play',
  description: 'Play Console listing, signing, service account, and internal testing track.',
  provider: 'google-play',
  providerMeta: {
    label: 'Google Play',
    scope: 'organization',
    secretKeys: ['service_account_json', 'keystore_password'],
    dependsOnProviders: ['firebase'],
    displayMeta: {
      label: 'Google Play',
      color: 'text-green-600',
      bg: 'bg-green-500/10',
      border: 'border-green-500/30',
    },
  },
  requiredModules: [],
  optionalModules: ['eas-submit'],
  includedInTemplates: ['mobile-app'],
  platforms: ['android'],
  steps: [
    GOOGLE_PLAY_STEPS.find((s) => s.key === 'google-play:create-app-listing')!,
    GOOGLE_PLAY_STEPS.find((s) => s.key === 'google-play:create-service-account')!,
    GOOGLE_PLAY_STEPS.find((s) => s.key === 'google-play:setup-internal-testing')!,
    GOOGLE_PLAY_STEPS.find((s) => s.key === 'google-play:configure-app-signing')!,
    GOOGLE_PLAY_STEPS.find((s) => s.key === 'google-play:extract-fingerprints')!,
  ],
  teardownSteps: [
    GOOGLE_PLAY_TEARDOWN_STEPS.find((s) => s.key === 'google-play:revoke-service-account')!,
    GOOGLE_PLAY_TEARDOWN_STEPS.find((s) => s.key === 'google-play:remove-app-listing')!,
  ],
  userActions: [
    USER_ACTIONS.find((a) => a.key === 'user:enroll-google-play')!,
    USER_ACTIONS.find((a) => a.key === 'user:upload-initial-aab')!,
  ],
  displayMeta: {
    icon: 'Play',
    colors: {
      primary: 'green-500',
      text: 'text-green-700 dark:text-green-300',
      bg: 'bg-green-500/10',
      border: 'border-green-500/25',
    },
  },
  defaultJourneyPhase: 'play',
  guidedFlows: [
    {
      ...GOOGLE_PLAY_FLOW,
      stepKeys: ['google-play:create-service-account', 'google-play:create-app-listing'],
    },
  ],
  resourceDisplay: {
    play_app_id: {
      relatedLinks: [{ label: 'Play Console', href: 'https://play.google.com/console' }],
    },
    play_service_account_email: {
      primaryHrefTemplate:
        'https://console.cloud.google.com/iam-admin/serviceaccounts?project={upstream.gcp_project_id}',
    },
  },
  completionPortalLinks: {
    'user:enroll-google-play': [
      { label: 'Play Console signup', href: 'https://play.google.com/console/signup' },
    ],
  },
  functionGroup: {
    id: 'mobile',
    label: 'Mobile & App Stores',
    description: 'Mobile build, signing, and store publishing',
    order: 3,
  },
};
