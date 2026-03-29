import type { ProvisioningNode } from '../provisioning/graph.types.js';
import {
  buildPlanViewModel,
  computeCanonicalNodeOrder,
  propagateJourneyPhases,
  validatePlanAcyclic,
} from '../provisioning/journey-phases.js';

function ua(
  key: string,
  category: import('../provisioning/graph.types.js').UserActionNode['category'],
  deps: { nodeKey: string; required: boolean }[] = [],
): ProvisioningNode {
  return {
    type: 'user-action',
    key,
    label: key,
    description: '',
    category,
    verification: { type: 'manual-confirm' },
    dependencies: deps,
    produces: [],
  };
}

function step(
  key: string,
  provider: import('../providers/types.js').ProviderType,
  deps: { nodeKey: string; required: boolean }[] = [],
): ProvisioningNode {
  return {
    type: 'step',
    key,
    label: key,
    description: '',
    provider,
    environmentScope: 'global',
    automationLevel: 'full',
    dependencies: deps,
    produces: [],
  };
}

describe('journey-phases', () => {
  it('validatePlanAcyclic accepts a linear DAG', () => {
    const nodes: ProvisioningNode[] = [
      ua('gate', 'account-enrollment'),
      step('firebase:create-gcp-project', 'firebase', [{ nodeKey: 'gate', required: true }]),
    ];
    expect(() => validatePlanAcyclic(nodes)).not.toThrow();
  });

  it('validatePlanAcyclic throws on a 2-node cycle', () => {
    const nodes: ProvisioningNode[] = [
      step('x', 'firebase', [{ nodeKey: 'y', required: true }]),
      step('y', 'firebase', [{ nodeKey: 'x', required: true }]),
    ];
    expect(() => validatePlanAcyclic(nodes)).toThrow(/cycle/);
  });

  it('computeCanonicalNodeOrder places dependencies before dependents', () => {
    const nodes: ProvisioningNode[] = [
      step('child', 'github', [{ nodeKey: 'parent', required: true }]),
      ua('parent', 'credential-upload'),
    ];
    const phases = propagateJourneyPhases(nodes);
    const order = computeCanonicalNodeOrder(nodes, phases);
    expect(order.indexOf('parent')).toBeLessThan(order.indexOf('child'));
  });

  it('tie-break prefers earlier journey phase among independent nodes', () => {
    const nodes: ProvisioningNode[] = [
      ua('cred', 'credential-upload'),
      ua('acct', 'account-enrollment'),
    ];
    const phases = propagateJourneyPhases(nodes);
    const order = computeCanonicalNodeOrder(nodes, phases);
    expect(order[0]).toBe('acct');
    expect(order[1]).toBe('cred');
  });

  it('propagateJourneyPhases never assigns a phase earlier than a required dependency', () => {
    const nodes: ProvisioningNode[] = [
      ua('acct', 'account-enrollment'),
      step('fb', 'firebase', [{ nodeKey: 'acct', required: true }]),
    ];
    const phases = propagateJourneyPhases(nodes);
    const acctPhase = phases.get('acct')!;
    const fbPhase = phases.get('fb')!;
    const rank = (id: string) =>
      [
        'accounts',
        'domain_dns',
        'credentials',
        'cloud_firebase',
        'repo',
        'cicd',
        'mobile_build',
        'signing_apple',
        'play',
        'edge_ssl',
        'deep_links',
        'oauth',
        'verification',
        'teardown',
      ].indexOf(id);
    expect(rank(fbPhase)).toBeGreaterThanOrEqual(rank(acctPhase));
  });

  it('buildPlanViewModel includes canonical order and phases for environments', () => {
    const nodes: ProvisioningNode[] = [ua('a', 'account-enrollment')];
    const vm = buildPlanViewModel(nodes, ['prod', 'dev']);
    expect(vm.canonicalNodeOrder).toEqual(['a']);
    expect(vm.journeyPhaseByNodeKey['a']).toBe('accounts');
    expect(vm.sequentialExecutionItems).toEqual([{ nodeKey: 'a' }]);
  });
});
