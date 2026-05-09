import type { PluginDefinition } from '../plugin-types.js';
import type { ProvisioningStepNode } from '../../provisioning/graph.types.js';
import { GITHUB_STEPS, GITHUB_TEARDOWN_STEPS, USER_ACTIONS } from '../../provisioning/step-registry.js';

// github:inject-secrets is implemented by both the GitHub adapter
// (orchestrated full runs) and a StepHandler (targeted runs / reset delete path).
//
// Owns ENV-LEVEL secrets only. Repo-level secrets (EXPO_TOKEN) are written by
// `eas:store-token-in-github`. See github-step-handlers.ts for the partitioning
// rationale.
const injectSecretsStep: ProvisioningStepNode = {
  type: 'step',
  key: 'github:inject-secrets',
  label: 'Inject Environment Secrets',
  description:
    'Store project environment secrets in GitHub Actions environments. FIREBASE_SERVICE_ACCOUNT is included only when the Google Cloud project key exists. EXPO_TOKEN is written separately at the repository level by `eas:store-token-in-github` so it acts as a shared fallback for every workflow job.',
  provider: 'github',
  environmentScope: 'global',
  automationLevel: 'full',
  dependencies: [
    { nodeKey: 'github:create-repository', required: true },
    { nodeKey: 'firebase:generate-sa-key', required: false, description: 'Firebase SA key to store' },
  ],
  produces: [],
  estimatedDurationMs: 5000,
};

export const githubCiPlugin: PluginDefinition = {
  id: 'github-ci',
  version: '1.0.0',
  label: 'CI/CD Workflows',
  description: 'Install GitHub Actions workflows, deployment environments, and environment secrets.',
  integrationId: 'github',
  provider: 'github',
  requiredModules: ['github-repo'],
  optionalModules: ['eas-builds'],
  includedInTemplates: ['mobile-app', 'web-app', 'api-backend'],
  steps: [
    injectSecretsStep,
    GITHUB_STEPS.find((s) => s.key === 'github:deploy-workflows')!,
  ],
  teardownSteps: [
    GITHUB_TEARDOWN_STEPS.find((s) => s.key === 'github:delete-workflows')!,
  ],
  userActions: [
    USER_ACTIONS.find((a) => a.key === 'user:share-cicd-integration-prompt')!,
  ],
  displayMeta: {
    icon: 'GitBranch',
    colors: {
      primary: 'slate-500',
      text: 'text-slate-700 dark:text-slate-300',
      bg: 'bg-slate-500/10',
      border: 'border-slate-500/25',
    },
  },
  defaultJourneyPhase: 'cicd',
  completionPortalLinks: {
    'github:inject-secrets': [
      {
        label: 'Actions secrets',
        hrefTemplate: '{upstream.github_repo_url}/settings/secrets/actions',
      },
    ],
    'github:deploy-workflows': [
      { label: 'Actions', hrefTemplate: '{upstream.github_repo_url}/actions' },
    ],
    'user:share-cicd-integration-prompt': [
      { label: 'Repository Actions', hrefTemplate: '{upstream.github_repo_url}/actions' },
    ],
  },
  functionGroup: {
    id: 'github',
    label: 'GitHub',
    description: 'Source repository and CI/CD automation',
    order: 2,
  },
};
