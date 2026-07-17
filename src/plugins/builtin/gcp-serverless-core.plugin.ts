import type { PluginDefinition } from '../plugin-types.js';
import { GCP_SERVERLESS_STEPS } from '../../provisioning/step-registry.js';
import { GCP_SERVERLESS_STEP_HANDLERS } from '../../core/gcp/gcp-serverless-step-handlers.js';

const coreKeys = [
  'gcp:resolve-project-context',
  'gcp:prepare-runtime-foundation',
  'gcp:ensure-artifact-registry',
  'gcp:ensure-runtime-service-account',
  'gcp:ensure-secret-manager-bindings',
  'gcp:setup-observability-baseline',
] as const;

const coreStepCapabilities = Object.fromEntries(
  coreKeys.map((key) => [key, { supportsRevert: false }]),
);

export const gcpServerlessCorePlugin: PluginDefinition = {
  id: 'gcp-serverless-core',
  version: '1.0.0',
  label: 'Cloud Run Foundation',
  description: 'Shared Cloud Run prerequisites, runtime identity, secrets, and observability.',
  integrationId: 'gcp',
  provider: 'gcp',
  requiredModules: ['gcp-project-foundation'],
  optionalModules: ['gcp-serverless-api', 'gcp-serverless-web', 'gcp-serverless-fullstack'],
  includedInTemplates: ['web-app', 'api-backend'],
  steps: coreKeys.map((k) => GCP_SERVERLESS_STEPS.find((s) => s.key === k)!).filter(Boolean),
  stepCapabilities: coreStepCapabilities,
  stepHandlers: GCP_SERVERLESS_STEP_HANDLERS,
  teardownSteps: [],
  userActions: [],
  resourceDisplay: {
    gcp_project_id: {
      primaryHrefTemplate:
        'https://console.cloud.google.com/home/dashboard?project={value}',
    },
    artifact_registry_repo: {
      primaryHrefTemplate:
        'https://console.cloud.google.com/artifacts?project={upstream.gcp_project_id}',
    },
    runtime_service_account_email: {
      primaryHrefTemplate:
        'https://console.cloud.google.com/iam-admin/serviceaccounts/details/{value}?project={upstream.gcp_project_id}',
    },
    secret_manager_bindings: {
      primaryHrefTemplate:
        'https://console.cloud.google.com/security/secret-manager?project={upstream.gcp_project_id}',
    },
    gcp_observability_ready: {
      primaryHrefTemplate:
        'https://console.cloud.google.com/logs/metrics?project={upstream.gcp_project_id}',
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
