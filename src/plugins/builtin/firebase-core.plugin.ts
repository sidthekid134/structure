import type { PluginDefinition } from '../plugin-types.js';
import {
  FIREBASE_STEPS,
} from '../../provisioning/step-registry.js';

export const firebaseCorePlugin: PluginDefinition = {
  id: 'firebase-core',
  version: '1.0.0',
  label: 'Firebase App Foundation',
  description: 'Enable Firebase on the Google Cloud project and register mobile app IDs.',
  integrationId: 'gcp',
  provider: 'firebase',
  providerMeta: {
    label: 'Firebase',
    scope: 'project',
    secretKeys: ['service_account_json', 'api_key', 'fcm_key'],
    dependsOnProviders: ['gcp'],
    displayMeta: {
      label: 'Firebase',
      color: 'text-orange-500',
      bg: 'bg-orange-500/10',
      border: 'border-orange-500/30',
    },
  },
  requiredModules: ['gcp-project-foundation'],
  optionalModules: ['firebase-auth', 'firebase-firestore', 'firebase-storage', 'firebase-messaging'],
  includedInTemplates: ['mobile-app', 'web-app', 'api-backend'],
  steps: [
    FIREBASE_STEPS.find((s) => s.key === 'firebase:enable-firebase')!,
    FIREBASE_STEPS.find((s) => s.key === 'firebase:create-provisioner-sa')!,
    FIREBASE_STEPS.find((s) => s.key === 'firebase:bind-provisioner-iam')!,
    FIREBASE_STEPS.find((s) => s.key === 'firebase:generate-sa-key')!,
    FIREBASE_STEPS.find((s) => s.key === 'firebase:register-ios-app')!,
    FIREBASE_STEPS.find((s) => s.key === 'firebase:register-android-app')!,
    FIREBASE_STEPS.find((s) => s.key === 'firebase:register-android-sha1')!,
  ],
  teardownSteps: [],
  userActions: [],
  displayMeta: {
    icon: 'Cloud',
    colors: {
      primary: 'orange-500',
      text: 'text-orange-700 dark:text-orange-300',
      bg: 'bg-orange-500/10',
      border: 'border-orange-500/25',
    },
  },
  defaultJourneyPhase: 'cloud_firebase',
  journeyPhaseOverrides: {
    'user:setup-gcp-billing': 'accounts',
  },
  resourceDisplay: {
    firebase_project_id: {
      primaryHrefTemplate: 'https://console.firebase.google.com/project/{value}',
      relatedLinks: [{ label: 'Firebase console', href: 'https://console.firebase.google.com/' }],
    },
    firebase_ios_app_id: {
      primaryHrefTemplate:
        'https://console.firebase.google.com/project/{upstream.firebase_project_id}/settings/general/ios',
      relatedLinks: [
        {
          label: 'Firebase project settings',
          hrefTemplate:
            'https://console.firebase.google.com/project/{upstream.firebase_project_id}/settings/general',
        },
      ],
    },
    firebase_android_app_id: {
      primaryHrefTemplate:
        'https://console.firebase.google.com/project/{upstream.firebase_project_id}/settings/general/android',
      relatedLinks: [
        {
          label: 'Firebase project settings',
          hrefTemplate:
            'https://console.firebase.google.com/project/{upstream.firebase_project_id}/settings/general',
        },
      ],
    },
    provisioner_sa_email: {
      primaryHrefTemplate:
        'https://console.cloud.google.com/iam-admin/serviceaccounts?project={upstream.gcp_project_id}',
      relatedLinks: [
        {
          label: 'IAM',
          hrefTemplate:
            'https://console.cloud.google.com/iam-admin/iam?project={upstream.gcp_project_id}',
        },
      ],
    },
    service_account_json: {
      sensitive: true,
    },
  },
  functionGroup: {
    id: 'firebase',
    label: 'Firebase & Cloud',
    description: 'Firebase services and Google Cloud infrastructure',
    order: 1,
  },
};
