import type { PluginDefinition } from '../plugin-types.js';
import { GCP_SERVERLESS_STEPS } from '../../provisioning/step-registry.js';

const apiKeys = [
  'api:build-container',
  'api:deploy-cloud-run',
  'api:run-smoke-check',
  'api:promote-traffic',
  'api:rollback-revision',
  'api:bind-domain-ssl',
  'cicd:configure-deploy-identity',
  'cicd:generate-github-workflow',
  'cicd:wire-environment-promotions',
  'cicd:wire-rollback-action',
] as const;

const apiStepCapabilities = Object.fromEntries(
  apiKeys.map((key) => [key, { supportsRevert: false }]),
);

export const gcpServerlessApiPlugin: PluginDefinition = {
  id: 'gcp-serverless-api',
  version: '1.0.0',
  label: 'Backend Service',
  description:
    'Build, deploy, smoke test, promote, and roll back API services on Cloud Run from a configurable API app root/Dockerfile/build context.',
  integrationId: 'gcp',
  provider: 'gcp',
  requiredModules: ['gcp-serverless-core', 'github-ci'],
  optionalModules: ['gcp-serverless-web', 'gcp-serverless-fullstack'],
  includedInTemplates: ['api-backend'],
  steps: apiKeys.map((k) => GCP_SERVERLESS_STEPS.find((s) => s.key === k)!).filter(Boolean),
  stepCapabilities: apiStepCapabilities,
  teardownSteps: [],
  userActions: [],
  resourceDisplay: {
    api_image_uri: {
      primaryHrefTemplate:
        'https://console.cloud.google.com/artifacts?project={upstream.gcp_project_id}',
    },
    api_cloud_run_service: {
      primaryHrefTemplate:
        'https://console.cloud.google.com/run/detail/{upstream.gcp_region}/{value}/revisions?project={upstream.gcp_project_id}',
    },
    api_cloud_run_url: {
      primaryLinkFromValue: true,
      relatedLinks: [
        {
          label: 'Cloud Run service',
          hrefTemplate:
            'https://console.cloud.google.com/run/detail/{upstream.gcp_region}/{upstream.api_cloud_run_service}/revisions?project={upstream.gcp_project_id}',
        },
      ],
    },
    api_domain_url: {
      primaryLinkFromValue: true,
      relatedLinks: [
        {
          label: 'Cloud Run domain mappings',
          hrefTemplate:
            'https://console.cloud.google.com/run/domains?project={upstream.gcp_project_id}',
        },
      ],
    },
    cloudrun_workflow_path: {
      primaryHrefTemplate: '{upstream.github_repo_url}/actions',
    },
    ci_deploy_identity_configured: {
      primaryHrefTemplate: '{upstream.github_repo_url}/settings/secrets/actions',
    },
    gcp_ci_service_account: {
      primaryHrefTemplate:
        'https://console.cloud.google.com/iam-admin/serviceaccounts/details/{value}?project={upstream.gcp_project_id}',
    },
    gcp_workload_identity_provider: {
      primaryHrefTemplate:
        'https://console.cloud.google.com/iam-admin/workload-identity-pools?project={upstream.gcp_project_id}',
    },
    cloudbuild_source_bucket: {
      primaryHrefTemplate:
        'https://console.cloud.google.com/storage/browser/{value}?project={upstream.gcp_project_id}',
    },
    ci_promotions_wired: {
      primaryHrefTemplate: '{upstream.github_repo_url}/settings/environments',
    },
    ci_rollback_wired: {
      primaryHrefTemplate: '{upstream.github_repo_url}/actions',
    },
  },
  defaultJourneyPhase: 'cicd',
  functionGroup: {
    id: 'infrastructure',
    label: 'Infrastructure',
    description: 'Cloud runtime foundations and deployment plumbing',
    order: 4,
  },
};
