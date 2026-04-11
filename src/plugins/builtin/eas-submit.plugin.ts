import type { PluginDefinition } from '../plugin-types.js';
import { EAS_STEPS, EAS_TEARDOWN_STEPS } from '../../provisioning/step-registry.js';

export const easSubmitPlugin: PluginDefinition = {
  id: 'eas-submit',
  version: '1.0.0',
  label: 'EAS Submit',
  description: 'Configure EAS Submit for App Store and Google Play uploads.',
  provider: 'eas',
  requiredModules: ['eas-builds'],
  optionalModules: ['apple-signing', 'google-play-publishing'],
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
  functionGroup: {
    id: 'mobile',
    label: 'Mobile & App Stores',
    description: 'Mobile build, signing, and store publishing',
    order: 3,
  },
};
