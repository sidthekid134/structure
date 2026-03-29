/**
 * Merge provisioning nodes from multiple contributors (core + future plugins).
 */

import type { ProviderType } from '../providers/types.js';
import type { ProvisioningNode } from './graph.types.js';
import type { ModuleId } from './module-catalog.js';
import { validatePlanAcyclic } from './journey-phases.js';

export interface ProvisioningContributorContext {
  projectId: string;
  selectedProviders: ProviderType[];
  environments: string[];
  selectedModules?: ModuleId[];
}

export interface ProvisioningContributor {
  id: string;
  contributeNodes(ctx: ProvisioningContributorContext): ProvisioningNode[];
}

function validateDependencyReferences(nodes: ProvisioningNode[]): void {
  const keys = new Set(nodes.map((n) => n.key));
  for (const n of nodes) {
    for (const dep of n.dependencies) {
      if (!dep.required) continue;
      if (!keys.has(dep.nodeKey)) {
        throw new Error(
          `Node "${n.key}" depends on missing node "${dep.nodeKey}" (contributor merge / plan build).`,
        );
      }
    }
  }
}

/**
 * Concatenate contributor outputs, dedupe by key (first wins), validate DAG.
 */
export function mergeContributorNodes(
  contributors: ProvisioningContributor[],
  ctx: ProvisioningContributorContext,
): ProvisioningNode[] {
  const byKey = new Map<string, ProvisioningNode>();
  for (const c of contributors) {
    for (const n of c.contributeNodes(ctx)) {
      if (byKey.has(n.key)) {
        throw new Error(
          `Duplicate provisioning node key "${n.key}" from contributor "${c.id}" (already registered).`,
        );
      }
      byKey.set(n.key, n);
    }
  }
  const nodes = [...byKey.values()];
  validateDependencyReferences(nodes);
  validatePlanAcyclic(nodes);
  return nodes;
}
