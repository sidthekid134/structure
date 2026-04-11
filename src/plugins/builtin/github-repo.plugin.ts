import type { PluginDefinition } from '../plugin-types.js';
import type { ProvisioningStepNode } from '../../provisioning/graph.types.js';
import {
  GITHUB_STEPS,
  GITHUB_TEARDOWN_STEPS,
  USER_ACTIONS,
} from '../../provisioning/step-registry.js';
import { GITHUB_STEP_HANDLERS } from '../../provisioning/github-step-handlers.js';

// github:create-environments is handled by the GitHub adapter but not yet
// defined as an explicit ProvisioningStepNode in step-registry.ts.
// Define it here so the plugin owns it properly.
const createEnvironmentsStep: ProvisioningStepNode = {
  type: 'step',
  key: 'github:create-environments',
  label: 'Create GitHub Environments',
  description: 'Create staging/production environments in GitHub for Actions secrets isolation.',
  provider: 'github',
  environmentScope: 'global',
  automationLevel: 'full',
  dependencies: [{ nodeKey: 'github:create-repository', required: true }],
  produces: [
    {
      key: 'github_environment_id',
      label: 'Environment ID',
      description: 'GitHub Actions environment identifier',
    },
  ],
  estimatedDurationMs: 3000,
};

const deleteEnvironmentsStep: ProvisioningStepNode = {
  type: 'step',
  key: 'github:delete-environments',
  label: 'Delete GitHub Environments',
  description: 'Remove GitHub Actions environments created for this project.',
  provider: 'github',
  environmentScope: 'global',
  automationLevel: 'full',
  direction: 'teardown',
  teardownOf: 'github:create-environments',
  dependencies: [],
  produces: [],
};

export const githubRepoPlugin: PluginDefinition = {
  id: 'github-repo',
  version: '1.0.0',
  label: 'GitHub Repository',
  description: 'Create the repository and core integration metadata.',
  provider: 'github',
  providerMeta: {
    label: 'GitHub',
    scope: 'organization',
    secretKeys: ['token'],
    dependsOnProviders: ['firebase'],
    displayMeta: {
      label: 'GitHub',
      color: 'text-slate-600 dark:text-slate-300',
      bg: 'bg-slate-500/10',
      border: 'border-slate-500/30',
    },
  },
  requiredModules: [],
  optionalModules: ['github-ci'],
  includedInTemplates: ['mobile-app', 'web-app', 'api-backend'],
  steps: [
    GITHUB_STEPS.find((s) => s.key === 'github:create-repository')!,
    createEnvironmentsStep,
  ],
  teardownSteps: [
    deleteEnvironmentsStep,
    GITHUB_TEARDOWN_STEPS.find((s) => s.key === 'github:delete-repository')!,
  ],
  userActions: [
    USER_ACTIONS.find((a) => a.key === 'user:provide-github-pat')!,
  ],
  stepHandlers: GITHUB_STEP_HANDLERS,
  displayMeta: {
    icon: 'Github',
    colors: {
      primary: 'slate-500',
      text: 'text-slate-700 dark:text-slate-300',
      bg: 'bg-slate-500/10',
      border: 'border-slate-500/25',
    },
  },
  defaultJourneyPhase: 'repo',
  resourceDisplay: {
    github_repo_url: {
      primaryLinkFromValue: true,
      relatedLinks: [
        { label: 'Repository settings', hrefTemplate: '{value}/settings' },
        { label: 'Actions', hrefTemplate: '{value}/actions' },
      ],
    },
    github_environment_id: {
      relatedLinks: [
        {
          label: 'GitHub Environments',
          hrefTemplate: '{upstream.github_repo_url}/settings/environments',
        },
      ],
    },
    github_token: {
      sensitive: true,
    },
  },
  completionPortalLinks: {
    'github:create-repository': [
      { label: 'Open repository', hrefTemplate: '{upstream.github_repo_url}' },
      { label: 'Repository settings', hrefTemplate: '{upstream.github_repo_url}/settings' },
    ],
    'github:create-environments': [
      {
        label: 'GitHub environments',
        hrefTemplate: '{upstream.github_repo_url}/settings/environments',
      },
    ],
    'user:provide-github-pat': [
      { label: 'GitHub token settings', href: 'https://github.com/settings/tokens' },
    ],
  },
  functionGroup: {
    id: 'github',
    label: 'GitHub',
    description: 'Source repository and CI/CD automation',
    order: 2,
  },
};
