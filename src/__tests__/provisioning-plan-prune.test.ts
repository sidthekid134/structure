import { buildProvisioningPlan, pruneNodesWithUnresolvedDependencies } from '../provisioning/step-registry.js';
import type { ProvisioningNode } from '../provisioning/graph.types.js';
import { registerBuiltinPlugins } from '../plugins/builtin/index.js';

beforeAll(() => {
  registerBuiltinPlugins();
});

describe('pruneNodesWithUnresolvedDependencies', () => {
  it('removes nodes in dependency order until all required edges resolve', () => {
    const nodes: ProvisioningNode[] = [
      {
        type: 'step',
        key: 'root',
        label: '',
        description: '',
        provider: 'firebase',
        environmentScope: 'global',
        automationLevel: 'full',
        dependencies: [],
        produces: [],
      },
      {
        type: 'step',
        key: 'mid',
        label: '',
        description: '',
        provider: 'eas',
        environmentScope: 'global',
        automationLevel: 'full',
        dependencies: [{ nodeKey: 'missing', required: true }],
        produces: [],
      },
      {
        type: 'step',
        key: 'top',
        label: '',
        description: '',
        provider: 'eas',
        environmentScope: 'global',
        automationLevel: 'full',
        dependencies: [{ nodeKey: 'mid', required: true }],
        produces: [],
      },
    ];
    const out = pruneNodesWithUnresolvedDependencies(nodes);
    expect(out.map((n) => n.key)).toEqual(['root']);
  });
});

describe('buildProvisioningPlan default providers', () => {
  it('does not fail when EAS is selected without Apple / Google Play (cross-provider submit steps pruned)', () => {
    expect(() =>
      buildProvisioningPlan('proj', ['firebase', 'github', 'eas'], ['development', 'production']),
    ).not.toThrow();

    const plan = buildProvisioningPlan('proj', ['firebase', 'github', 'eas'], ['development', 'production']);
    const keys = new Set(plan.nodes.map((n) => n.key));
    expect(keys.has('eas:configure-submit-apple')).toBe(false);
    expect(keys.has('eas:configure-submit-android')).toBe(false);
  });

  it('includes EAS submit steps when Apple and Google Play providers are selected', () => {
    const plan = buildProvisioningPlan(
      'proj',
      ['firebase', 'github', 'eas', 'apple', 'google-play'],
      ['development', 'production'],
    );
    const keys = new Set(plan.nodes.map((n) => n.key));
    expect(keys.has('eas:configure-submit-apple')).toBe(true);
    expect(keys.has('apple:generate-asc-api-key')).toBe(true);
    expect(keys.has('eas:configure-submit-android')).toBe(true);
  });
});
