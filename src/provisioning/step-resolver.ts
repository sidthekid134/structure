/**
 * StepResolver — topological sorting and readiness computation for the
 * step-level provisioning graph.
 *
 * The resolver operates on ProvisioningNode[] and produces ExecutionGroup[]
 * where each group is a set of nodes that can run in parallel (same depth
 * in the DAG after dependency expansion for per-environment steps).
 */

import type {
  ProvisioningNode,
  NodeState,
  NodeStatus,
  ExecutionGroup,
  ExecutionGroupItem,
  ProvisioningPlan,
  ProvisioningStepNode,
  UserActionNode,
} from './graph.types.js';
import { buildPlanViewModel, type PlanViewModel } from './journey-phases.js';
import { ALL_PROVISIONING_STEPS, USER_ACTIONS } from './step-registry.js';

export class StepResolver {
  /**
   * Resolve the execution plan from the node list and environments.
   *
   * Per-environment steps are fanned out: 'firebase:enable-services' with
   * environments ['dev', 'prod'] becomes two items in the execution plan:
   *   firebase:enable-services@dev
   *   firebase:enable-services@prod
   *
   * The result is an array of ExecutionGroups where each group's items
   * can be executed in parallel. Groups are ordered so that all deps in
   * earlier groups complete before the next group begins.
   */
  static resolveExecutionPlan(
    nodes: ProvisioningNode[],
    environments: string[],
  ): ExecutionGroup[] {
    // Build the expanded item list (fan out per-env steps)
    const items: ExecutionGroupItem[] = [];
    const nodeMap = new Map<string, ProvisioningNode>(nodes.map((n) => [n.key, n]));

    for (const node of nodes) {
      if (node.type === 'step' && node.environmentScope === 'per-environment') {
        for (const env of environments) {
          items.push({ nodeKey: node.key, environment: env });
        }
      } else {
        items.push({ nodeKey: node.key, environment: undefined });
      }
    }

    // Build adjacency (item key → set of item keys it depends on)
    // Item key = nodeKey or nodeKey@env
    const itemKey = (i: ExecutionGroupItem): string =>
      i.environment ? `${i.nodeKey}@${i.environment}` : i.nodeKey;

    const allItemKeys = new Set(items.map(itemKey));

    // Compute dependencies for each item in the expanded list
    const depMap = new Map<string, Set<string>>();
    for (const item of items) {
      const node = nodeMap.get(item.nodeKey);
      if (!node) continue;

      const deps = new Set<string>();
      for (const depRef of node.dependencies) {
        const depNode = nodeMap.get(depRef.nodeKey);
        if (!depNode) continue;

        if (depNode.type === 'step' && depNode.environmentScope === 'per-environment') {
          // A per-env step depends on per-env dep with the same env (if item is also per-env)
          if (item.environment) {
            const depItemKey = `${depRef.nodeKey}@${item.environment}`;
            if (allItemKeys.has(depItemKey)) deps.add(depItemKey);
          } else {
            // Global node depending on a per-env node: depends on ALL env instances
            for (const env of environments) {
              const depItemKey = `${depRef.nodeKey}@${env}`;
              if (allItemKeys.has(depItemKey)) deps.add(depItemKey);
            }
          }
        } else {
          // Global dep
          if (allItemKeys.has(depRef.nodeKey)) deps.add(depRef.nodeKey);
        }
      }
      depMap.set(itemKey(item), deps);
    }

    // Topological sort via BFS / Kahn's algorithm
    // Compute in-degree for each item
    const inDegree = new Map<string, number>();
    for (const item of items) {
      inDegree.set(itemKey(item), 0);
    }
    for (const [, deps] of depMap) {
      for (const dep of deps) {
        // dep must exist in items
        if (inDegree.has(dep)) {
          // items that have this dep as incoming edge — we actually track in-degree of the dependent
        }
      }
    }
    // Recalculate: in-degree of X = number of items that X depends on which are in the graph
    // Actually we need in-degree as: count of items pointing TO X
    const reverseDeps = new Map<string, Set<string>>();
    for (const item of items) {
      reverseDeps.set(itemKey(item), new Set());
    }
    for (const [from, deps] of depMap) {
      for (const dep of deps) {
        const set = reverseDeps.get(dep);
        if (set) set.add(from);
      }
    }

    // Recompute in-degree = number of deps this node has within graph
    for (const item of items) {
      const deps = depMap.get(itemKey(item)) ?? new Set();
      inDegree.set(itemKey(item), deps.size);
    }

    // BFS with depth tracking
    const depth = new Map<string, number>();
    const queue: string[] = [];

    for (const item of items) {
      const k = itemKey(item);
      if ((inDegree.get(k) ?? 0) === 0) {
        queue.push(k);
        depth.set(k, 0);
      }
    }

    const itemByKey = new Map<string, ExecutionGroupItem>(
      items.map((i) => [itemKey(i), i]),
    );

    let head = 0;
    while (head < queue.length) {
      const current = queue[head++]!;
      const currentDepth = depth.get(current) ?? 0;

      const dependents = reverseDeps.get(current) ?? new Set();
      for (const dependent of dependents) {
        const newDegree = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDegree);
        const existingDepth = depth.get(dependent) ?? 0;
        depth.set(dependent, Math.max(existingDepth, currentDepth + 1));
        if (newDegree === 0) {
          queue.push(dependent);
        }
      }
    }

    // Group items by depth
    const maxDepth = Math.max(0, ...Array.from(depth.values()));
    const groups: ExecutionGroup[] = [];
    for (let d = 0; d <= maxDepth; d++) {
      const groupItems: ExecutionGroupItem[] = [];
      for (const [k, d2] of depth) {
        if (d2 === d) {
          const item = itemByKey.get(k);
          if (item) groupItems.push(item);
        }
      }
      if (groupItems.length > 0) {
        groups.push({ depth: d, items: groupItems });
      }
    }

    // Items that never got added (cycle or missing dep) — append at end
    const placed = new Set(queue);
    const unplaced = items.filter((i) => !placed.has(itemKey(i)));
    if (unplaced.length > 0) {
      groups.push({ depth: maxDepth + 1, items: unplaced });
    }

    return groups;
  }

  /**
   * Resolve teardown execution groups in reverse topological order.
   *
   * The input is typically the teardown node set produced by step-registry.
   * We still run the normal DAG resolver first so per-environment expansion
   * behaves identically, then reverse the execution groups.
   */
  static resolveTeardownPlan(
    nodes: ProvisioningNode[],
    environments: string[],
  ): ExecutionGroup[] {
    const forward = StepResolver.resolveExecutionPlan(nodes, environments);
    const reversed = [...forward].reverse();
    return reversed.map((group, idx) => ({
      depth: idx,
      items: group.items,
    }));
  }

  /**
   * Returns all nodes whose dependencies are all 'completed' and whose
   * own status is 'not-started' or 'blocked'.
   */
  static getReadyNodes(
    nodes: ProvisioningNode[],
    nodeStates: Map<string, NodeState>,
    environments: string[],
  ): Array<{ node: ProvisioningNode; environment?: string }> {
    const ready: Array<{ node: ProvisioningNode; environment?: string }> = [];

    for (const node of nodes) {
      const instances =
        node.type === 'step' && node.environmentScope === 'per-environment'
          ? environments.map((env) => ({ node, environment: env }))
          : [{ node, environment: undefined }];

      for (const instance of instances) {
        const stateKey = instance.environment
          ? `${node.key}@${instance.environment}`
          : node.key;
        const state = nodeStates.get(stateKey);
        const currentStatus = state?.status ?? 'not-started';

        if (currentStatus !== 'not-started' && currentStatus !== 'blocked') continue;

        const status = StepResolver.computeNodeStatus(node, nodeStates, instance.environment, environments);
        if (status === 'ready') {
          ready.push(instance);
        }
      }
    }

    return ready;
  }

  /**
   * Compute the current status of a node based on its dependency states.
   *
   * - If all deps completed → 'ready'
   * - If any dep failed → 'blocked'
   * - If any dep is waiting-on-user → 'blocked'
   * - If any dep is not-started or blocked → 'blocked'
   * - Otherwise → current recorded status
   */
  static computeNodeStatus(
    node: ProvisioningNode,
    nodeStates: Map<string, NodeState>,
    environment: string | undefined,
    environments: string[],
  ): NodeStatus {
    for (const dep of node.dependencies) {
      const depNode = { type: 'unknown', environmentScope: 'global' };
      // Determine dep state key
      let depStateKey: string;

      // Check if dep is a per-env step by looking up the full nodes list
      // We use a heuristic: if the dep key contains an @env in the state map, treat as per-env
      const perEnvKey = environment ? `${dep.nodeKey}@${environment}` : null;
      const globalKey = dep.nodeKey;

      if (perEnvKey && nodeStates.has(perEnvKey)) {
        depStateKey = perEnvKey;
      } else {
        depStateKey = globalKey;
      }

      const depState = nodeStates.get(depStateKey);
      const depStatus = depState?.status ?? 'not-started';

      if (dep.required) {
        if (depStatus === 'failed') return 'blocked';
        if (depStatus === 'waiting-on-user') return 'blocked';
        if (depStatus === 'blocked') return 'blocked';
        if (depStatus === 'not-started') return 'blocked';
        if (depStatus === 'in-progress') return 'blocked';
        // 'completed', 'skipped' are OK
      }
    }

    return 'ready';
  }

  /**
   * Snapshot the plan for API transport (converts Map to plain object).
   */
  static snapshotPlan(plan: ProvisioningPlan): {
    projectId: string;
    environments: string[];
    selectedModules: string[];
    nodes: ProvisioningNode[];
    nodeStates: Record<string, NodeState>;
  } {
    return {
      projectId: plan.projectId,
      environments: plan.environments,
      selectedModules: plan.selectedModules,
      nodes: plan.nodes,
      nodeStates: Object.fromEntries(plan.nodeStates),
    };
  }

  /** Registry lookup for fields that may be missing from old persisted plans. */
  private static readonly userActionRegistry = new Map<string, UserActionNode>(
    USER_ACTIONS.map((ua) => [ua.key, ua]),
  );

  private static readonly provisioningStepRegistry = new Map<string, ProvisioningStepNode>(
    ALL_PROVISIONING_STEPS.map((s) => [s.key, s]),
  );

  /** Snapshot plus journey order and phase metadata for API/UI (recomputed; not persisted). */
  static enrichPlanSnapshot(
    plan: ProvisioningPlan,
  ): ReturnType<typeof StepResolver.snapshotPlan> & PlanViewModel {
    const snapshot = StepResolver.snapshotPlan(plan);
    snapshot.nodes = snapshot.nodes.map((node) => {
      if (node.type === 'user-action') {
        const registry = StepResolver.userActionRegistry.get(node.key);
        if (!registry) return node;
        return {
          ...node,
          interactiveAction: node.interactiveAction ?? registry.interactiveAction,
        };
      }
      if (node.type === 'step') {
        const registry = StepResolver.provisioningStepRegistry.get(node.key);
        if (!registry?.interactiveAction) return node;
        return {
          ...node,
          interactiveAction: node.interactiveAction ?? registry.interactiveAction,
        };
      }
      return node;
    });
    return {
      ...snapshot,
      ...buildPlanViewModel(plan.nodes, plan.environments),
    };
  }

  /**
   * Restore a plan from a snapshot (converts plain object back to Map).
   */
  static restorePlan(snapshot: {
    projectId: string;
    environments: string[];
    selectedModules?: string[];
    nodes: ProvisioningNode[];
    nodeStates: Record<string, NodeState>;
  }): ProvisioningPlan {
    return {
      projectId: snapshot.projectId,
      environments: snapshot.environments,
      selectedModules: snapshot.selectedModules ?? [],
      nodes: snapshot.nodes,
      nodeStates: new Map(Object.entries(snapshot.nodeStates)),
    };
  }
}
