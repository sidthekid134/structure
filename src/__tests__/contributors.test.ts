import type { ProvisioningNode } from '../provisioning/graph.types.js';
import { mergeContributorNodes, type ProvisioningContributorContext } from '../provisioning/contributors.js';

const ctx: ProvisioningContributorContext = {
  projectId: 'p1',
  selectedProviders: ['firebase'],
  environments: ['development'],
};

describe('contributors', () => {
  it('mergeContributorNodes throws on duplicate keys', () => {
    const dup: ProvisioningNode = {
      type: 'user-action',
      key: 'same',
      label: '',
      description: '',
      category: 'account-enrollment',
      verification: { type: 'manual-confirm' },
      dependencies: [],
      produces: [],
    };
    const contributors = [
      { id: 'a', contributeNodes: () => [dup] },
      { id: 'b', contributeNodes: () => [dup] },
    ];
    expect(() => mergeContributorNodes(contributors, ctx)).toThrow(/Duplicate provisioning node key/);
  });

  it('mergeContributorNodes throws when required dependency is missing', () => {
    const orphan: ProvisioningNode = {
      type: 'step',
      key: 'child',
      label: '',
      description: '',
      provider: 'firebase',
      environmentScope: 'global',
      automationLevel: 'full',
      dependencies: [{ nodeKey: 'missing', required: true }],
      produces: [],
    };
    expect(() =>
      mergeContributorNodes([{ id: 'x', contributeNodes: () => [orphan] }], ctx),
    ).toThrow(/depends on missing node/);
  });
});
