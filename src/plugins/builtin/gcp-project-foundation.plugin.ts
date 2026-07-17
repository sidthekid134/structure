import type { PluginDefinition } from '../plugin-types.js';
import {
  FIREBASE_STEPS,
  FIREBASE_TEARDOWN_STEPS,
  USER_ACTIONS,
} from '../../provisioning/step-registry.js';

export const gcpProjectFoundationPlugin: PluginDefinition = {
  id: 'gcp-project-foundation',
  version: '1.0.0',
  label: 'Project Foundation',
  description: 'Create or link the Google Cloud project and attach billing.',
  integrationId: 'gcp',
  provider: 'gcp',
  providerMeta: {
    label: 'Google Cloud',
    scope: 'project',
    secretKeys: [],
    dependsOnProviders: [],
    displayMeta: {
      label: 'Google Cloud',
      color: 'text-blue-600 dark:text-blue-300',
      bg: 'bg-blue-500/10',
      border: 'border-blue-500/30',
    },
  },
  requiredModules: [],
  optionalModules: ['firebase-core', 'gcp-serverless-core'],
  includedInTemplates: ['mobile-app', 'web-app', 'api-backend'],
  steps: [
    FIREBASE_STEPS.find((s) => s.key === 'firebase:create-gcp-project')!,
  ],
  teardownSteps: [
    FIREBASE_TEARDOWN_STEPS.find((s) => s.key === 'firebase:delete-gcp-project')!,
  ],
  userActions: [
    USER_ACTIONS.find((a) => a.key === 'user:setup-gcp-billing')!,
    USER_ACTIONS.find((a) => a.key === 'user:connect-gcp-integration')!,
  ],
  displayMeta: {
    icon: 'Cloud',
    colors: {
      primary: 'blue-500',
      text: 'text-blue-700 dark:text-blue-300',
      bg: 'bg-blue-500/10',
      border: 'border-blue-500/25',
    },
  },
  defaultJourneyPhase: 'cloud_firebase',
  journeyPhaseOverrides: {
    'user:setup-gcp-billing': 'accounts',
  },
  resourceDisplay: {
    gcp_project_id: {
      primaryHrefTemplate: 'https://console.cloud.google.com/home/dashboard?project={value}',
      relatedLinks: [
        { label: 'Google Cloud Console', href: 'https://console.cloud.google.com/' },
        { label: 'Billing', href: 'https://console.cloud.google.com/billing' },
      ],
    },
    gcp_billing_account_id: {
      primaryHrefTemplate: 'https://console.cloud.google.com/billing/{value}',
    },
  },
  functionGroup: {
    id: 'infrastructure',
    label: 'Infrastructure',
    description: 'Cloud runtime foundations and deployment plumbing',
    order: 4,
  },
};
