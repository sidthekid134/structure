import { buildGitHubWorkflowTemplates } from '../studio/api-helpers.js';
import type { NodeState, ProvisioningPlan, ProvisioningStepNode } from '../provisioning/graph.types.js';

function makeStep(
  key: string,
  provider: ProvisioningStepNode['provider'],
): ProvisioningStepNode {
  return {
    type: 'step',
    key,
    label: key,
    description: key,
    provider,
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [],
    produces: [],
  };
}

function makePlan(
  nodes: ProvisioningStepNode[],
  nodeStates: Record<string, NodeState> = {},
  selectedModules: string[] = [],
): ProvisioningPlan {
  return {
    projectId: 'proj-1',
    environments: ['preview', 'production'],
    selectedModules,
    platforms: [],
    nodes,
    nodeStates: new Map<string, NodeState>(Object.entries(nodeStates)),
  };
}

describe('buildGitHubWorkflowTemplates', () => {
  it('auto-detects mobile target when EAS steps are present', () => {
    const plan = makePlan([
      makeStep('github:deploy-workflows', 'github'),
      makeStep('eas:create-project', 'eas'),
    ]);

    expect(buildGitHubWorkflowTemplates(plan)).toEqual(['expo-testflight']);
  });

  it('auto-detects web/api targets from plan nodes', () => {
    const plan = makePlan(
      [
        makeStep('github:deploy-workflows', 'github'),
        makeStep('web:cicd-prepare-contract', 'firebase'),
        makeStep('api:build-container', 'firebase'),
      ],
      {},
      ['gcp-serverless-web', 'gcp-serverless-api'],
    );

    expect(buildGitHubWorkflowTemplates(plan)).toEqual([
      'web-gcp-react-delivery',
      'api-gcp-node-build',
      'api-gcp-node-deploy',
    ]);
  });

  it('uses explicit deploy target inputs when configured', () => {
    const plan = makePlan(
      [
        makeStep('github:deploy-workflows', 'github'),
        makeStep('eas:create-project', 'eas'),
        makeStep('web:cicd-prepare-contract', 'firebase'),
        makeStep('api:build-container', 'firebase'),
      ],
      {
        'github:deploy-workflows': {
          nodeKey: 'github:deploy-workflows',
          status: 'ready',
          userInputs: { deploy_target_types: 'web,api' },
        },
      },
      ['gcp-serverless-web', 'gcp-serverless-api'],
    );

    expect(buildGitHubWorkflowTemplates(plan)).toEqual([
      'web-gcp-react-delivery',
      'api-gcp-node-build',
      'api-gcp-node-deploy',
    ]);
  });

  it('uses Next.js and Flask templates when those stacks are selected', () => {
    const plan = makePlan(
      [
        makeStep('github:deploy-workflows', 'github'),
        makeStep('web:cicd-prepare-contract', 'firebase'),
        makeStep('api:build-container', 'firebase'),
      ],
      {
        'github:deploy-workflows': {
          nodeKey: 'github:deploy-workflows',
          status: 'ready',
          userInputs: {
            deploy_target_types: 'web,api',
            deploy_web_stack: 'nextjs',
            deploy_api_stack: 'flask',
          },
        },
      },
    );

    expect(buildGitHubWorkflowTemplates(plan)).toEqual([
      'web-gcp-nextjs-delivery',
      'api-gcp-flask-build',
      'api-gcp-flask-deploy',
    ]);
  });

  it('infers GCP Cloud Run destinations from selected modules', () => {
    const plan = makePlan(
      [
        makeStep('github:deploy-workflows', 'github'),
        makeStep('web:cicd-prepare-contract', 'firebase'),
        makeStep('api:build-container', 'firebase'),
      ],
      {
        'github:deploy-workflows': {
          nodeKey: 'github:deploy-workflows',
          status: 'ready',
          userInputs: {
            deploy_target_types: 'web,api',
            deploy_web_stack: 'nextjs',
            deploy_api_stack: 'flask',
          },
        },
      },
      ['gcp-serverless-web', 'gcp-serverless-api'],
    );

    expect(buildGitHubWorkflowTemplates(plan)).toEqual([
      'web-gcp-nextjs-delivery',
      'api-gcp-flask-build',
      'api-gcp-flask-deploy',
    ]);
  });

  it('throws when web/api targets are selected without deployment modules', () => {
    const plan = makePlan(
      [
        makeStep('github:deploy-workflows', 'github'),
        makeStep('eas:create-project', 'eas'),
      ],
      {
        'github:deploy-workflows': {
          nodeKey: 'github:deploy-workflows',
          status: 'ready',
          userInputs: {
            deploy_target_types: 'web,api',
          },
        },
      },
    );

    expect(() => buildGitHubWorkflowTemplates(plan)).toThrow(
      'no supported deployment destination is available',
    );
  });

  it('throws when mobile target is configured without EAS', () => {
    const plan = makePlan(
      [makeStep('github:deploy-workflows', 'github')],
      {
        'github:deploy-workflows': {
          nodeKey: 'github:deploy-workflows',
          status: 'ready',
          userInputs: { deploy_target_types: 'mobile' },
        },
      },
    );

    expect(() => buildGitHubWorkflowTemplates(plan)).toThrow('mobile');
  });

  it('throws when an unsupported web stack is configured', () => {
    const plan = makePlan(
      [
        makeStep('github:deploy-workflows', 'github'),
        makeStep('web:cicd-prepare-contract', 'firebase'),
      ],
      {
        'github:deploy-workflows': {
          nodeKey: 'github:deploy-workflows',
          status: 'ready',
          userInputs: {
            deploy_target_types: 'web',
            deploy_web_stack: 'vue',
          },
        },
      },
    );

    expect(() => buildGitHubWorkflowTemplates(plan)).toThrow('Unsupported web stack');
  });
});
