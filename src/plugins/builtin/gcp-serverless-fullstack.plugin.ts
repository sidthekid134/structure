import type { PluginDefinition } from '../plugin-types.js';
import { GCP_SERVERLESS_STEPS } from '../../provisioning/step-registry.js';

const fullstackKeys = [
  'combo:cross-service-smoke-check',
  'combo:promote-release',
  'combo:rollback-release',
] as const;

const fullstackStepCapabilities = Object.fromEntries(
  fullstackKeys.map((key) => [key, { supportsRevert: false }]),
);

export const gcpServerlessFullstackPlugin: PluginDefinition = {
  id: 'gcp-serverless-fullstack',
  version: '1.0.0',
  label: 'Full-Stack Release',
  description:
    'Coordinate independently deployable web/API Cloud Run services, environment contracts, smoke checks, promotion, and rollback.',
  integrationId: 'gcp',
  provider: 'gcp',
  requiredModules: ['gcp-serverless-api', 'gcp-serverless-web'],
  optionalModules: [],
  steps: fullstackKeys.map((k) => GCP_SERVERLESS_STEPS.find((s) => s.key === k)!).filter(Boolean),
  stepCapabilities: fullstackStepCapabilities,
  teardownSteps: [],
  userActions: [],
  resourceDisplay: {
    combo_release_promoted: {
      primaryHrefTemplate:
        'https://console.cloud.google.com/run?project={upstream.gcp_project_id}',
    },
    combo_release_rolled_back: {
      primaryHrefTemplate:
        'https://console.cloud.google.com/run?project={upstream.gcp_project_id}',
    },
  },
  defaultJourneyPhase: 'runtime',
  functionGroup: {
    id: 'infrastructure',
    label: 'Infrastructure',
    description: 'Cloud runtime foundations and deployment plumbing',
    order: 4,
  },
};
