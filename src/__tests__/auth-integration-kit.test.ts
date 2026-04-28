import { buildAuthIntegrationKitBundle } from '../studio/auth-integration-kit.js';
import type { ProvisioningPlan, ProvisioningStepNode } from '../provisioning/graph.types.js';
import type { ProjectModule } from '../studio/project-manager.js';

function step(key: string): ProvisioningStepNode {
  return {
    type: 'step',
    key,
    label: key,
    description: key,
    provider: 'oauth',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: [],
    produces: [],
  };
}

function makeProjectModule(): ProjectModule {
  const now = new Date().toISOString();
  return {
    project: {
      id: 'flow',
      name: 'Flow',
      slug: 'flow',
      bundleId: 'com.example.flow',
      description: '',
      repository: '',
      platform: 'cross-platform',
      githubOrg: '',
      easAccount: '',
      environments: ['preview', 'production'],
      platforms: ['ios', 'android'],
      domain: 'app.flow.example',
      plugins: ['oauth'],
      createdAt: now,
      updatedAt: now,
    },
    integrations: {},
  };
}

function makePlan(resources: Record<string, string>): ProvisioningPlan {
  const nodes: ProvisioningStepNode[] = [
    step('oauth:register-oauth-client-web'),
    step('oauth:register-oauth-client-ios'),
    step('oauth:register-oauth-client-android'),
    step('oauth:configure-apple-sign-in'),
    step('oauth:link-deep-link-domain'),
    step('oauth:prepare-app-integration-kit'),
  ];
  return {
    projectId: 'flow',
    environments: ['preview', 'production'],
    selectedModules: ['oauth-social'],
    platforms: ['ios', 'android'],
    nodes,
    nodeStates: new Map([
      [
        'oauth:prepare-app-integration-kit',
        {
          nodeKey: 'oauth:prepare-app-integration-kit',
          status: 'completed',
          resourcesProduced: resources,
        },
      ],
    ]),
  };
}

describe('buildAuthIntegrationKitBundle', () => {
  it('builds zip artifacts and prompt text from completed auth outputs', () => {
    const bundle = buildAuthIntegrationKitBundle(
      makePlan({
        firebase_project_id: 'st-flow-abc123',
        oauth_client_id_web: 'web-client-id.apps.googleusercontent.com',
        oauth_client_id_ios: 'ios-client-id.apps.googleusercontent.com',
        oauth_client_id_android: 'android-client-id.apps.googleusercontent.com',
        apple_sign_in_service_id: 'com.example.flow.signin',
        deep_link_base_url: 'https://app.flow.example',
      }),
      makeProjectModule(),
    );

    expect(bundle.zipFileName).toBe('flow-auth-integration-kit.zip');
    expect(bundle.promptFileName).toBe('flow-auth-llm-prompt.txt');
    expect(bundle.files.some((f) => f.path.endsWith('/auth-config.json'))).toBe(true);
    expect(bundle.promptText).toContain('web-client-id.apps.googleusercontent.com');
    expect(bundle.promptText).toContain('com.example.flow.signin');
    expect(bundle.promptText).toContain('app-appropriate sign-up moment');
    expect(bundle.promptText).toContain('global auth state/store');
  });

  it('fails loudly when required oauth outputs are missing', () => {
    expect(() =>
      buildAuthIntegrationKitBundle(
        makePlan({
          firebase_project_id: 'st-flow-abc123',
          oauth_client_id_web: 'web-client-id.apps.googleusercontent.com',
          oauth_client_id_ios: 'ios-client-id.apps.googleusercontent.com',
          apple_sign_in_service_id: 'com.example.flow.signin',
        }),
        makeProjectModule(),
      ),
    ).toThrow('deep_link_base_url');
  });
});
