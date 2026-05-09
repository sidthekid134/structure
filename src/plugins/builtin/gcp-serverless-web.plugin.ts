import type { PluginDefinition } from '../plugin-types.js';
import { GCP_SERVERLESS_STEPS } from '../../provisioning/step-registry.js';

const webKeys = [
  'web:cicd-prepare-contract',
  'web:cicd-verify-deploy',
  'web:cicd-verify-smoke',
  'web:bind-domain-ssl',
  'cicd:configure-deploy-identity',
  'cicd:generate-github-workflow',
  'cicd:wire-environment-promotions',
  'cicd:wire-rollback-action',
] as const;

const webStepCapabilities = Object.fromEntries(
  webKeys.map((key) => [key, { supportsRevert: false }]),
);

export const gcpServerlessWebPlugin: PluginDefinition = {
  id: 'gcp-serverless-web',
  version: '1.0.0',
  label: 'Web Frontend',
  description: 'Prepare CI contract, verify GitHub-driven Cloud Run deploys, smoke test, and bind domains for web frontends.',
  integrationId: 'gcp',
  provider: 'gcp',
  requiredModules: ['gcp-serverless-core', 'github-ci'],
  optionalModules: ['gcp-serverless-api', 'gcp-serverless-fullstack'],
  includedInTemplates: ['web-app'],
  steps: webKeys.map((k) => GCP_SERVERLESS_STEPS.find((s) => s.key === k)!).filter(Boolean),
  stepCapabilities: webStepCapabilities,
  teardownSteps: [],
  userActions: [],
  resourceDisplay: {
    web_cicd_contract_ready: {
      primaryHrefTemplate: '{upstream.github_repo_url}/actions',
    },
    ci_github_repo: {
      primaryHrefTemplate: 'https://github.com/{value}',
    },
    web_cloud_run_service: {
      primaryHrefTemplate:
        'https://console.cloud.google.com/run/detail/{upstream.gcp_region}/{value}/revisions?project={upstream.gcp_project_id}',
    },
    web_cloud_run_url: {
      primaryLinkFromValue: true,
      relatedLinks: [
        {
          label: 'Cloud Run service',
          hrefTemplate:
            'https://console.cloud.google.com/run/detail/{upstream.gcp_region}/{upstream.web_cloud_run_service}/revisions?project={upstream.gcp_project_id}',
        },
      ],
    },
    web_domain_url: {
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
  defaultJourneyPhase: 'runtime',
  functionGroup: {
    id: 'infrastructure',
    label: 'Infrastructure',
    description: 'Cloud runtime foundations and deployment plumbing',
    order: 4,
  },
};
