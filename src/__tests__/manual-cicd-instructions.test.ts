import { buildManualInstructionsByNodeKey } from '../studio/manual-step-instructions.js';
import type { ProvisioningPlan, UserActionNode } from '../provisioning/graph.types.js';
import type { ProjectModule } from '../studio/project-manager.js';

const cicdPromptNode: UserActionNode = {
  type: 'user-action',
  key: 'user:share-cicd-integration-prompt',
  label: 'Share CI/CD App Structure Prompt',
  description: 'Share prompt',
  category: 'approval',
  provider: 'github',
  verification: { type: 'manual-confirm' },
  dependencies: [{ nodeKey: 'github:deploy-workflows', required: true }],
  produces: [],
};

describe('CI/CD manual instructions', () => {
  it('includes fullstack monorepo deploy contract details in the handoff prompt', () => {
    const plan: ProvisioningPlan = {
      projectId: 'proj-1',
      environments: ['preview', 'production'],
      selectedModules: ['gcp-serverless-web', 'gcp-serverless-api', 'gcp-serverless-fullstack'],
      platforms: [],
      nodes: [cicdPromptNode],
      nodeStates: new Map([
        [
          'github:deploy-workflows',
          {
            nodeKey: 'github:deploy-workflows',
            status: 'completed',
            userInputs: {
              deploy_target_types: 'web,api',
              deploy_web_root: 'apps/web',
              deploy_web_dockerfile: 'apps/web/Dockerfile',
              deploy_web_build_context: '.',
              deploy_api_root: 'apps/api',
              deploy_api_dockerfile: 'apps/api/Dockerfile',
              deploy_api_build_context: '.',
              deploy_api_health_path: '/api/health',
            },
          },
        ],
      ]),
    };
    const projectModule: ProjectModule = {
      project: {
        id: 'proj-1',
        name: 'Test App',
        slug: 'test-app',
        bundleId: 'com.example.test',
        description: '',
        repository: '',
        platform: 'web',
        githubOrg: '',
        easAccount: '',
        environments: ['preview', 'production'],
        platforms: [],
        domain: 'app.example.com',
        plugins: [],
        createdAt: '',
        updatedAt: '',
      },
      integrations: {},
    };

    const instructions = buildManualInstructionsByNodeKey(plan, projectModule);
    const prompt = instructions['user:share-cicd-integration-prompt']?.steps[1]?.copyText ?? '';

    expect(prompt).toContain('Recommended fullstack monorepo structure');
    expect(prompt).toContain('apps/web');
    expect(prompt).toContain('apps/api');
    expect(prompt).toContain('packages/shared');
    expect(prompt).toContain('Web Dockerfile: "apps/web/Dockerfile"');
    expect(prompt).toContain('API Dockerfile: "apps/api/Dockerfile"');
    expect(prompt).toContain('API health path: "/api/health"');
    expect(prompt).toContain('build context');
  });
});
