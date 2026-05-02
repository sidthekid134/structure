import type { ProvisioningStepNode } from '../graph.types.js';

export const GITHUB_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'github:create-repository',
    label: 'Create Repository',
    description: 'Create or link the GitHub repository for the project.',
    provider: 'github',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'user:provide-github-pat', required: true }],
    inputFields: [
      {
        key: 'github_owner',
        label: 'GitHub Owner / Org',
        description: 'Optional override for where the repository should be created (user or organization name).',
        type: 'text',
        placeholder: 'my-org',
        required: false,
      },
    ],
    produces: [
      {
        key: 'github_repo_url',
        label: 'Repository',
        description: 'GitHub repository URL (opens in browser)',
      },
    ],
    estimatedDurationMs: 5000,
  },
  {
    type: 'step',
    key: 'github:deploy-workflows',
    label: 'Deploy CI/CD Workflows',
    description: 'Create build, test, and deploy workflow YAML files.',
    provider: 'github',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [{ nodeKey: 'github:create-repository', required: true }],
    produces: [],
    estimatedDurationMs: 5000,
  },
];

export const GITHUB_TEARDOWN_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'github:delete-workflows',
    label: 'Delete GitHub Workflows',
    description: 'Remove repository workflow files and CI/CD automation.',
    provider: 'github',
    environmentScope: 'global',
    automationLevel: 'full',
    direction: 'teardown',
    teardownOf: 'github:deploy-workflows',
    dependencies: [],
    produces: [],
  },
  {
    type: 'step',
    key: 'github:delete-repository',
    label: 'Delete GitHub Repository',
    description: 'Delete the GitHub repository for this project.',
    provider: 'github',
    environmentScope: 'global',
    automationLevel: 'assisted',
    direction: 'teardown',
    teardownOf: 'github:create-repository',
    dependencies: [{ nodeKey: 'github:delete-workflows', required: true }],
    produces: [],
  },
];
