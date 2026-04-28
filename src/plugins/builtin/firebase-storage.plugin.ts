import type { PluginDefinition } from '../plugin-types.js';
import { FIREBASE_STEPS, FIREBASE_TEARDOWN_STEPS } from '../../provisioning/step-registry.js';

export const firebaseStoragePlugin: PluginDefinition = {
  id: 'firebase-storage',
  version: '1.0.0',
  label: 'Cloud Storage',
  description: 'Deploy storage rules for configured environments.',
  provider: 'firebase',
  requiredModules: ['firebase-core'],
  optionalModules: [],
  includedInTemplates: ['mobile-app'],
  steps: [
    FIREBASE_STEPS.find((s) => s.key === 'firebase:enable-storage')!,
    FIREBASE_STEPS.find((s) => s.key === 'firebase:configure-storage-rules')!,
  ],
  teardownSteps: [
    FIREBASE_TEARDOWN_STEPS.find((s) => s.key === 'firebase:delete-storage-buckets')!,
  ],
  userActions: [],
  displayMeta: {
    icon: 'HardDrive',
    colors: {
      primary: 'cyan-500',
      text: 'text-cyan-700 dark:text-cyan-300',
      bg: 'bg-cyan-500/10',
      border: 'border-cyan-500/25',
    },
  },
  defaultJourneyPhase: 'cloud_firebase',
  functionGroup: {
    id: 'firebase',
    label: 'Firebase & GCP',
    description: 'Firebase services and Google Cloud infrastructure',
    order: 1,
  },
};
