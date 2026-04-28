import type { PluginDefinition } from '../plugin-types.js';
import { FIREBASE_STEPS, FIREBASE_TEARDOWN_STEPS } from '../../provisioning/step-registry.js';

export const firebaseFirestorePlugin: PluginDefinition = {
  id: 'firebase-firestore',
  version: '1.0.0',
  label: 'Firestore',
  description: 'Create a Firestore database and deploy security rules.',
  provider: 'firebase',
  requiredModules: ['firebase-core'],
  optionalModules: [],
  includedInTemplates: ['mobile-app', 'web-app', 'api-backend'],
  steps: [
    FIREBASE_STEPS.find((s) => s.key === 'firebase:create-firestore-db')!,
    FIREBASE_STEPS.find((s) => s.key === 'firebase:configure-firestore-rules')!,
  ],
  teardownSteps: [
    FIREBASE_TEARDOWN_STEPS.find((s) => s.key === 'firebase:delete-firestore-db')!,
  ],
  userActions: [],
  displayMeta: {
    icon: 'Database',
    colors: {
      primary: 'emerald-500',
      text: 'text-emerald-700 dark:text-emerald-300',
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/25',
    },
  },
  defaultJourneyPhase: 'cloud_firebase',
  resourceDisplay: {
    firestore_database_id: {
      primaryHrefTemplate:
        'https://console.firebase.google.com/project/{upstream.firebase_project_id}/firestore',
      relatedLinks: [
        {
          label: 'Firestore in Cloud Console',
          hrefTemplate:
            'https://console.cloud.google.com/firestore?project={upstream.gcp_project_id}',
        },
      ],
    },
  },
  completionPortalLinks: {
    'firebase:create-firestore-db': [
      {
        label: 'Open Firestore',
        hrefTemplate:
          'https://console.firebase.google.com/project/{upstream.firebase_project_id}/firestore',
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
