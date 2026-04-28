import type { PluginDefinition } from '../plugin-types.js';
import type { ProvisioningStepNode } from '../../provisioning/graph.types.js';
import { GITHUB_STEPS, GITHUB_TEARDOWN_STEPS } from '../../provisioning/step-registry.js';

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
    'Store FIREBASE_SERVICE_ACCOUNT as a GitHub Actions environment-level secret in every project environment (preview, production, …). EXPO_TOKEN is written separately at the repository level by `eas:store-token-in-github` so it acts as a shared fallback for every workflow job.',
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
  label: 'GitHub CI/CD',
  description: 'Deploy workflows and environment secrets.',
  provider: 'github',
  requiredModules: ['github-repo', 'firebase-core'],
  optionalModules: ['eas-builds'],
  includedInTemplates: ['mobile-app', 'web-app', 'api-backend'],
  steps: [
    injectSecretsStep,
    GITHUB_STEPS.find((s) => s.key === 'github:deploy-workflows')!,
  ],
  teardownSteps: [
    GITHUB_TEARDOWN_STEPS.find((s) => s.key === 'github:delete-workflows')!,
  ],
  userActions: [],
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
  },
  functionGroup: {
    id: 'github',
    label: 'GitHub',
    description: 'Source repository and CI/CD automation',
    order: 2,
  },
};
