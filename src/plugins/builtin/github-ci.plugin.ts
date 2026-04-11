import type { PluginDefinition } from '../plugin-types.js';
import type { ProvisioningStepNode } from '../../provisioning/graph.types.js';
import { GITHUB_STEPS, GITHUB_TEARDOWN_STEPS } from '../../provisioning/step-registry.js';

// github:inject-secrets is handled by the GitHub adapter but not yet
// defined as an explicit ProvisioningStepNode in step-registry.ts.
const injectSecretsStep: ProvisioningStepNode = {
  type: 'step',
  key: 'github:inject-secrets',
  label: 'Inject Repository Secrets',
  description:
    'Store Firebase, Expo, and other service credentials as GitHub Actions repository secrets.',
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
