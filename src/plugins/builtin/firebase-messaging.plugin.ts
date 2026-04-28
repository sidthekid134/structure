import type { PluginDefinition } from '../plugin-types.js';
import {
  APPLE_STEPS,
  FIREBASE_STEPS,
  FIREBASE_TEARDOWN_STEPS,
  GOOGLE_PLAY_STEPS,
} from '../../provisioning/step-registry.js';

export const firebaseMessagingPlugin: PluginDefinition = {
  id: 'firebase-messaging',
  version: '1.0.0',
  label: 'Push Notifications',
  description: 'Configure FCM/APNs and mobile signing integration.',
  provider: 'firebase',
  requiredModules: ['firebase-core'],
  optionalModules: ['apple-signing', 'google-play-publishing'],
  includedInTemplates: ['mobile-app'],
  steps: [
    FIREBASE_STEPS.find((s) => s.key === 'firebase:enable-fcm')!,
    // Bridge steps that connect Firebase with Apple/Google Play
    APPLE_STEPS.find((s) => s.key === 'apple:upload-apns-to-firebase')!,
    GOOGLE_PLAY_STEPS.find((s) => s.key === 'google-play:add-fingerprints-to-firebase')!,
  ],
  teardownSteps: [
    FIREBASE_TEARDOWN_STEPS.find((s) => s.key === 'firebase:disable-messaging')!,
  ],
  userActions: [],
  displayMeta: {
    icon: 'Bell',
    colors: {
      primary: 'sky-500',
      text: 'text-sky-700 dark:text-sky-300',
      bg: 'bg-sky-500/10',
      border: 'border-sky-500/25',
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
