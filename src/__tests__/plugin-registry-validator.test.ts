import { PluginRegistry } from '../plugins/plugin-registry';
import {
  validatePluginRegistry,
  AggregateRegistryError,
} from '../plugins/plugin-registry-validator';
import type { PluginDefinition } from '../plugins/plugin-types';
import type { ProvisioningStepNode, UserActionNode } from '../provisioning/graph.types';

function makeStep(key: string, deps: string[] = []): ProvisioningStepNode {
  return {
    type: 'step',
    key,
    label: key,
    description: key,
    provider: 'firebase',
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: deps.map((nodeKey) => ({ nodeKey, required: true })),
    produces: [],
  };
}

function makeUserAction(key: string): UserActionNode {
  return {
    type: 'user-action',
    key,
    label: key,
    description: key,
    category: 'approval',
    provider: 'firebase',
    verification: { type: 'manual-confirm' },
    dependencies: [],
    produces: [],
  };
}

function makePlugin(overrides: Partial<PluginDefinition> & Pick<PluginDefinition, 'id'>): PluginDefinition {
  const { id, ...rest } = overrides;
  return {
    id,
    version: '0.0.0',
    label: id,
    description: id,
    integrationId: 'gcp',
    provider: 'firebase',
    requiredModules: [],
    optionalModules: [],
    steps: [],
    teardownSteps: [],
    userActions: [],
    defaultJourneyPhase: 'cloud_firebase',
    ...rest,
  };
}

describe('validatePluginRegistry', () => {
  it('passes when the registry is internally consistent', () => {
    const registry = new PluginRegistry();
    const sharedStep = makeStep('cloud:shared');
    registry.register(makePlugin({ id: 'a', steps: [sharedStep] }));
    registry.register(
      makePlugin({
        id: 'b',
        requiredModules: ['a'],
        steps: [sharedStep, makeStep('cloud:b-only', ['cloud:shared'])],
      }),
    );

    const result = validatePluginRegistry(registry, { throwOnError: false });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('reports unknown requiredModules / optionalModules ids', () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin({ id: 'a', optionalModules: ['ghost-module'] }));

    const result = validatePluginRegistry(registry, { throwOnError: false });
    expect(result.problems).toEqual(
      expect.arrayContaining([
        'a.optionalModules references unknown module "ghost-module"',
      ]),
    );
  });

  it('reports two plugins defining the same step key with different objects', () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin({ id: 'a', steps: [makeStep('cloud:shared')] }));
    registry.register(makePlugin({ id: 'b', steps: [makeStep('cloud:shared')] }));

    const result = validatePluginRegistry(registry, { throwOnError: false });
    expect(result.problems).toEqual(
      expect.arrayContaining([
        'step "cloud:shared" defined as different objects by "a" and "b"',
      ]),
    );
  });

  it('reports unknown step dependency nodeKeys', () => {
    const registry = new PluginRegistry();
    registry.register(
      makePlugin({
        id: 'a',
        steps: [makeStep('cloud:dependent', ['cloud:does-not-exist'])],
      }),
    );

    const result = validatePluginRegistry(registry, { throwOnError: false });
    expect(result.problems).toEqual(
      expect.arrayContaining([
        'a: node "cloud:dependent" depends on unknown node "cloud:does-not-exist"',
      ]),
    );
  });

  it('reports unknown defaultJourneyPhase ids', () => {
    const registry = new PluginRegistry();
    registry.register(
      makePlugin({ id: 'a', defaultJourneyPhase: 'phase-that-does-not-exist' }),
    );

    const result = validatePluginRegistry(registry, { throwOnError: false });
    expect(result.problems).toEqual(
      expect.arrayContaining([
        'a.defaultJourneyPhase references unknown journey phase "phase-that-does-not-exist"',
      ]),
    );
  });

  it('reports template member modules whose required deps are missing from the same template', () => {
    const registry = new PluginRegistry();
    registry.registerProjectTemplate({
      id: 'broken',
      label: 'Broken',
      description: '',
    });
    registry.register(makePlugin({ id: 'base' }));
    registry.register(
      makePlugin({
        id: 'leaf',
        requiredModules: ['base'],
        includedInTemplates: ['broken'],
      }),
    );

    const result = validatePluginRegistry(registry, { throwOnError: false });
    expect(result.problems).toEqual(
      expect.arrayContaining([
        'template "broken" includes "leaf" which requires "base", but "base" is not in the template',
      ]),
    );
  });

  it('throws an AggregateRegistryError listing every problem', () => {
    const registry = new PluginRegistry();
    // Two distinct issues that bypass the eager register() checks:
    // optionalModules is not validated at register-time, and
    // defaultJourneyPhase is not validated at register-time either.
    registry.register(makePlugin({ id: 'a', optionalModules: ['ghost'] }));
    registry.register(makePlugin({ id: 'b', defaultJourneyPhase: 'fake-phase' }));

    let caught: AggregateRegistryError | undefined;
    try {
      validatePluginRegistry(registry);
    } catch (err) {
      if (err instanceof AggregateRegistryError) caught = err;
    }
    expect(caught).toBeInstanceOf(AggregateRegistryError);
    expect(caught?.problems.length).toBeGreaterThanOrEqual(2);
    expect(caught?.message).toContain('failed validation');
  });

  it('also accepts user actions as valid dependency targets', () => {
    const registry = new PluginRegistry();
    registry.register(
      makePlugin({
        id: 'a',
        userActions: [makeUserAction('user:approve')],
        steps: [makeStep('cloud:after', ['user:approve'])],
      }),
    );

    const result = validatePluginRegistry(registry, { throwOnError: false });
    expect(result.problems).toEqual([]);
  });
});
